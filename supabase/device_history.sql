-- Quiz Library — device history + block / unblock a device.
--
-- Run this once in Supabase → SQL Editor, AFTER single_device_login.sql.
-- It is safe to run again. Nothing existing is deleted.
--
-- Every device (browser) that signs in to an account is remembered in
-- ql_device_log: its name (e.g. "iPad · Safari"), first and last sign-in,
-- and how many times it signed in. The account owner can block a device from
-- My Profile: that device is signed out and cannot sign in again until the
-- owner unblocks it.

create table if not exists public.ql_device_log (
  user_id      uuid        not null default auth.uid(),
  device_id    text        not null,
  device_label text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  sign_ins     integer     not null default 1,
  blocked      boolean     not null default false,
  blocked_at   timestamptz,
  primary key (user_id, device_id)
);

alter table public.ql_device_log enable row level security;

drop policy if exists "own device log read" on public.ql_device_log;
create policy "own device log read" on public.ql_device_log
  for select to authenticated using (user_id = auth.uid());

revoke all on public.ql_device_log from anon, authenticated;
grant select on public.ql_device_log to authenticated;

-- Sign-in: refuse a blocked device, otherwise remember it and make it the
-- account's active device (newest sign-in wins, as before).
create or replace function public.ql_claim_device(p_device_id text, p_label text default null)
returns public.ql_active_device
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.ql_active_device;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(trim(p_device_id), '') = '' then
    raise exception 'missing device id';
  end if;
  if exists (select 1 from ql_device_log
              where user_id = v_uid and device_id = p_device_id and blocked) then
    raise exception 'device_blocked' using errcode = '42501';
  end if;

  insert into ql_device_log (user_id, device_id, device_label, first_seen, last_seen, sign_ins)
  values (v_uid, p_device_id, left(p_label, 120), now(), now(), 1)
  on conflict (user_id, device_id) do update
     set device_label = coalesce(excluded.device_label, ql_device_log.device_label),
         last_seen = now(),
         sign_ins = ql_device_log.sign_ins + 1;

  insert into ql_active_device (user_id, device_id, device_label, signed_in_at)
  values (v_uid, p_device_id, left(p_label, 120), now())
  on conflict (user_id) do update
     set device_id = excluded.device_id,
         device_label = excluded.device_label,
         signed_in_at = excluded.signed_in_at
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.ql_claim_device(text, text) from public, anon;
grant execute on function public.ql_claim_device(text, text) to authenticated;

-- Opening the app on the device that is already signed in: refresh
-- "last used" (not counted as a new sign-in) and refuse if it was blocked.
create or replace function public.ql_touch_device(p_device_id text, p_label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(trim(p_device_id), '') = '' then
    raise exception 'missing device id';
  end if;
  if exists (select 1 from ql_device_log
              where user_id = v_uid and device_id = p_device_id and blocked) then
    raise exception 'device_blocked' using errcode = '42501';
  end if;
  insert into ql_device_log (user_id, device_id, device_label, first_seen, last_seen, sign_ins)
  values (v_uid, p_device_id, left(p_label, 120), now(), now(), 1)
  on conflict (user_id, device_id) do update
     set device_label = coalesce(excluded.device_label, ql_device_log.device_label),
         last_seen = now();
end;
$$;
revoke all on function public.ql_touch_device(text, text) from public, anon;
grant execute on function public.ql_touch_device(text, text) to authenticated;

-- Block or unblock one of your own devices. Blocking the active device also
-- clears it, so the account is free to sign in somewhere else.
create or replace function public.ql_set_device_blocked(p_device_id text, p_blocked boolean)
returns public.ql_device_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.ql_device_log;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update ql_device_log
     set blocked = coalesce(p_blocked, false),
         blocked_at = case when coalesce(p_blocked, false) then now() else null end
   where user_id = v_uid and device_id = p_device_id
  returning * into v_row;
  if v_row.device_id is null then
    raise exception 'device not found';
  end if;
  if v_row.blocked then
    delete from ql_active_device where user_id = v_uid and device_id = p_device_id;
  end if;
  return v_row;
end;
$$;
revoke all on function public.ql_set_device_blocked(text, boolean) from public, anon;
grant execute on function public.ql_set_device_blocked(text, boolean) to authenticated;

-- Remove an (unblocked) device from the history list.
create or replace function public.ql_forget_device(p_device_id text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from ql_device_log
   where user_id = auth.uid() and device_id = p_device_id and not blocked;
$$;
revoke all on function public.ql_forget_device(text) from public, anon;
grant execute on function public.ql_forget_device(text) to authenticated;

-- Instant sign-out on a device the moment it is blocked (Realtime).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename = 'ql_device_log') then
    execute 'alter publication supabase_realtime add table public.ql_device_log';
  end if;
end $$;

notify pgrst, 'reload schema';
