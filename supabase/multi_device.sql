-- Quiz Library — how many devices an account can use at the same time.
-- Run in Supabase → SQL Editor, AFTER plans_admin.sql, single_device_login.sql
-- and device_history.sql. Safe to run again (it also updates the first version).
--
-- The limit comes from:
--   1. a number the admin sets for one person (Users → Manage → Devices), or
--   2. the person's plan (Plans & Limits → Edit → "Devices at the same time"),
--   3. otherwise 1 device, as before.
-- Empty / Unlimited = no limit.
--
-- Signing in on a new device when the limit is reached signs out the device
-- that signed in longest ago. Students see their limit in My Profile.

-- per-person limit (a row here = custom for this person; max_devices null = unlimited)
create table if not exists public.ql_device_rules (
  user_id    uuid primary key,
  mode       text,
  updated_at timestamptz not null default now()
);
alter table public.ql_device_rules add column if not exists max_devices integer;
alter table public.ql_device_rules alter column mode drop not null;
update public.ql_device_rules set max_devices = 1, mode = null where mode = 'one';
update public.ql_device_rules set mode = null where mode = 'many';
alter table public.ql_device_rules enable row level security;
revoke all on public.ql_device_rules from anon, authenticated;

-- devices signed in right now
create table if not exists public.ql_signed_devices (
  user_id      uuid not null,
  device_id    text not null,
  device_label text,
  signed_in_at timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.ql_signed_devices enable row level security;
revoke all on public.ql_signed_devices from anon, authenticated;
drop policy if exists "own signed devices read" on public.ql_signed_devices;
create policy "own signed devices read" on public.ql_signed_devices for select to authenticated using (user_id = auth.uid());
grant select on public.ql_signed_devices to authenticated;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'ql_signed_devices') then
    execute 'alter publication supabase_realtime add table public.ql_signed_devices';
  end if;
end $$;

-- the first version of this file (on/off instead of a number)
drop function if exists public.ql_my_device_rule();
drop function if exists public.ql_admin_set_device_rule(uuid, text);
drop function if exists public.ql__many_devices(uuid);

-- the limit for one account (null = unlimited)
create or replace function public.ql__device_limit(p_uid uuid)
returns integer language plpgsql stable security definer set search_path = public as $$
declare r ql_device_rules; v_lim jsonb;
begin
  select * into r from ql_device_rules where user_id = p_uid;
  if found then return r.max_devices; end if;
  select limits into v_lim from ql_plans where id = ql__effective_plan(p_uid);
  if v_lim is not null and v_lim ? 'devices' then
    return case when jsonb_typeof(v_lim->'devices') = 'number' then greatest((v_lim->>'devices')::int, 1) else null end;
  end if;
  return 1;
end;
$$;
revoke all on function public.ql__device_limit(uuid) from public, anon, authenticated;

-- keep only the newest N signed-in devices (always keeps p_keep)
create or replace function public.ql__trim_devices(p_uid uuid, p_keep text)
returns void language plpgsql security definer set search_path = public as $$
declare v_lim integer := ql__device_limit(p_uid);
begin
  if v_lim is null then return; end if;
  delete from ql_signed_devices d
   where d.user_id = p_uid
     and d.device_id is distinct from p_keep
     and d.device_id not in (
       select x.device_id from ql_signed_devices x
        where x.user_id = p_uid and x.device_id is distinct from p_keep
        order by x.signed_in_at desc
        limit greatest(v_lim - case when p_keep is null then 0 else 1 end, 0));
end;
$$;
revoke all on function public.ql__trim_devices(uuid, text) from public, anon, authenticated;

create or replace function public.ql__my_devices_info(p_uid uuid, p_device text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'limit', ql__device_limit(p_uid),
    'count', (select count(*) from ql_signed_devices where user_id = p_uid),
    'signed_in', exists (select 1 from ql_signed_devices where user_id = p_uid and device_id = p_device),
    'any', exists (select 1 from ql_signed_devices where user_id = p_uid),
    'newest', (select jsonb_build_object('label', device_label, 'at', signed_in_at) from ql_signed_devices
                where user_id = p_uid order by signed_in_at desc limit 1));
$$;
revoke all on function public.ql__my_devices_info(uuid, text) from public, anon, authenticated;

-- student: this device just signed in
create or replace function public.ql_device_signin(p_device_id text, p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform ql_claim_device(p_device_id, p_label);   -- device history + blocked check
  delete from ql_signed_devices s using ql_device_log l
   where s.user_id = v_uid and l.user_id = v_uid and l.device_id = s.device_id and l.blocked;
  insert into ql_signed_devices (user_id, device_id, device_label, signed_in_at, last_seen)
  values (v_uid, p_device_id, left(p_label, 120), clock_timestamp(), clock_timestamp())
  on conflict (user_id, device_id) do update set device_label = excluded.device_label, signed_in_at = clock_timestamp(), last_seen = clock_timestamp();
  perform ql__trim_devices(v_uid, p_device_id);
  return ql__my_devices_info(v_uid, p_device_id);
end;
$$;
revoke all on function public.ql_device_signin(text, text) from public, anon;
grant execute on function public.ql_device_signin(text, text) to authenticated;

-- student: is this device still signed in? (also applies a lowered limit)
create or replace function public.ql_device_check(p_device_id text, p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform ql_touch_device(p_device_id, p_label);   -- refuses a blocked device
  update ql_signed_devices set last_seen = now() where user_id = v_uid and device_id = p_device_id;
  perform ql__trim_devices(v_uid, null);
  return ql__my_devices_info(v_uid, p_device_id);
end;
$$;
revoke all on function public.ql_device_check(text, text) from public, anon;
grant execute on function public.ql_device_check(text, text) to authenticated;

-- student: signing out frees the slot
create or replace function public.ql_device_signout(p_device_id text)
returns void language sql security definer set search_path = public as $$
  delete from ql_signed_devices where user_id = auth.uid() and device_id = p_device_id;
$$;
revoke all on function public.ql_device_signout(text) from public, anon;
grant execute on function public.ql_device_signout(text) to authenticated;

-- admin: the limit for one person + where it comes from + devices signed in now
create or replace function public.ql_admin_get_device_rule(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r ql_device_rules;
begin
  perform ql__need_admin();
  select * into r from ql_device_rules where user_id = p_user;
  return jsonb_build_object(
    'custom', r.user_id is not null,
    'max', r.max_devices,
    'effective', ql__device_limit(p_user),
    'plan', (select name from ql_plans where id = ql__effective_plan(p_user)),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('label', device_label, 'signed_in_at', signed_in_at, 'last_seen', last_seen) order by signed_in_at desc)
                          from ql_signed_devices where user_id = p_user), '[]'::jsonb));
end;
$$;
revoke all on function public.ql_admin_get_device_rule(uuid) from public, anon;
grant execute on function public.ql_admin_get_device_rule(uuid) to authenticated;

-- admin: set one person's limit. p_follow = true → use the plan's limit.
-- Otherwise p_max = number of devices (null = unlimited).
create or replace function public.ql_admin_set_device_limit(p_user uuid, p_follow boolean, p_max integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_follow then
    delete from ql_device_rules where user_id = p_user;
  else
    if p_max is not null and (p_max < 1 or p_max > 100) then raise exception 'Choose between 1 and 100 devices'; end if;
    insert into ql_device_rules (user_id, max_devices, mode, updated_at) values (p_user, p_max, null, now())
    on conflict (user_id) do update set max_devices = excluded.max_devices, mode = null, updated_at = now();
  end if;
  perform ql__trim_devices(p_user, (select device_id from ql_signed_devices where user_id = p_user order by signed_in_at desc limit 1));
end;
$$;
revoke all on function public.ql_admin_set_device_limit(uuid, boolean, integer) from public, anon;
grant execute on function public.ql_admin_set_device_limit(uuid, boolean, integer) to authenticated;

notify pgrst, 'reload schema';
