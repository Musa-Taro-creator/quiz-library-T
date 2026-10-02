-- Quiz Library — allow some accounts to use many devices at the same time.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql and single_device_login.sql.
-- Safe to run again.
--
-- Who may use many devices at once:
--   1. A per-person choice the admin sets in Users → Manage → Devices
--      ('one' or 'many'); this wins when set.
--   2. Otherwise the Website Control switch "Many devices at the same time"
--      (key multi_device): Many devices = everyone, By plan = plans with it
--      ticked, One device (or not set) = one device only, as before.

create table if not exists public.ql_device_rules (
  user_id    uuid primary key,
  mode       text not null check (mode in ('one', 'many')),
  updated_at timestamptz not null default now()
);
alter table public.ql_device_rules enable row level security;
revoke all on public.ql_device_rules from anon, authenticated;

-- true = this account may stay signed in on many devices at once
create or replace function public.ql__many_devices(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select mode = 'many' from ql_device_rules where user_id = p_uid),
    case coalesce((select value->>'multi_device' from ql_site_settings where key = 'features'), 'off')
      when 'on'   then true
      when 'plan' then coalesce((select (features->>'multi_device')::boolean from ql_plans where id = ql__effective_plan(p_uid)), false)
      else false end);
$$;
revoke all on function public.ql__many_devices(uuid) from public, anon, authenticated;

-- student: may I use many devices?
create or replace function public.ql_my_device_rule()
returns boolean language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then false else ql__many_devices(auth.uid()) end;
$$;
revoke all on function public.ql_my_device_rule() from public, anon;
grant execute on function public.ql_my_device_rule() to authenticated;

-- admin: read one person's choice ('one', 'many' or null = follow the website setting)
create or replace function public.ql_admin_get_device_rule(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return jsonb_build_object('mode', (select mode from ql_device_rules where user_id = p_user),
                            'effective_many', ql__many_devices(p_user));
end;
$$;
revoke all on function public.ql_admin_get_device_rule(uuid) from public, anon;
grant execute on function public.ql_admin_get_device_rule(uuid) to authenticated;

-- admin: set one person's choice (null = follow the website setting)
create or replace function public.ql_admin_set_device_rule(p_user uuid, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_mode is null or p_mode = '' then
    delete from ql_device_rules where user_id = p_user;
  elsif p_mode in ('one', 'many') then
    insert into ql_device_rules (user_id, mode, updated_at) values (p_user, p_mode, now())
    on conflict (user_id) do update set mode = excluded.mode, updated_at = now();
  else
    raise exception 'Unknown device mode';
  end if;
end;
$$;
revoke all on function public.ql_admin_set_device_rule(uuid, text) from public, anon;
grant execute on function public.ql_admin_set_device_rule(uuid, text) to authenticated;

notify pgrst, 'reload schema';
