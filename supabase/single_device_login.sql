-- Quiz Library — one device per account.
--
-- Run this once in Supabase → SQL Editor. It is safe to run again.
--
-- Each account has one "active device". Signing in on a device makes it the
-- active one; any other device that is still open sees the change (instantly
-- via Realtime, or within a minute) and signs itself out with a message.
-- Nothing existing is changed or deleted.

create table if not exists public.ql_active_device (
  user_id      uuid        primary key default auth.uid(),
  device_id    text        not null,
  device_label text,
  signed_in_at timestamptz not null default now()
);

alter table public.ql_active_device enable row level security;

drop policy if exists "own active device read" on public.ql_active_device;
create policy "own active device read" on public.ql_active_device
  for select to authenticated using (user_id = auth.uid());

revoke all on public.ql_active_device from anon, authenticated;
grant select on public.ql_active_device to authenticated;

-- Make this browser the account's active device (newest sign-in wins).
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

-- Instant notice on the other device (Realtime). Ignored if already added.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename = 'ql_active_device') then
    execute 'alter publication supabase_realtime add table public.ql_active_device';
  end if;
end $$;

notify pgrst, 'reload schema';
