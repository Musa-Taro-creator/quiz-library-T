-- Quiz Library — gift a plan to a user. The admin sends e.g. "Pro for 1 month";
-- the user sees it in My Profile until they claim it or the admin cancels it.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.

create table if not exists public.ql_gifts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  plan_id     text not null,
  days        integer,                 -- null = no end date
  message     text not null default '',
  status      text not null default 'pending',   -- pending | claimed | cancelled
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists ql_gifts_user on public.ql_gifts (user_id, status);
alter table public.ql_gifts enable row level security;
revoke all on public.ql_gifts from anon, authenticated;

-- admin: send a gift
create or replace function public.ql_admin_send_gift(p_user uuid, p_plan text, p_days integer, p_message text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform ql__need_admin();
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'User not found'; end if;
  if not exists (select 1 from ql_plans where id = p_plan) then raise exception 'Unknown plan'; end if;
  if p_days is not null and (p_days < 1 or p_days > 36500) then raise exception 'Choose a length between 1 day and 100 years'; end if;
  insert into ql_gifts (user_id, plan_id, days, message) values (p_user, p_plan, p_days, left(coalesce(p_message, ''), 300))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_admin_send_gift(uuid, text, integer, text) from public, anon;
grant execute on function public.ql_admin_send_gift(uuid, text, integer, text) to authenticated;

-- admin: gifts of one user (all statuses)
create or replace function public.ql_admin_user_gifts(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(g) order by g.created_at desc) from ql_gifts g where g.user_id = p_user), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_user_gifts(uuid) from public, anon;
grant execute on function public.ql_admin_user_gifts(uuid) to authenticated;

-- admin: cancel a gift that wasn't claimed yet
create or replace function public.ql_admin_cancel_gift(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  update ql_gifts set status = 'cancelled', decided_at = now() where id = p_id and status = 'pending';
  if not found then raise exception 'This gift was already claimed or cancelled'; end if;
end;
$$;
revoke all on function public.ql_admin_cancel_gift(uuid) from public, anon;
grant execute on function public.ql_admin_cancel_gift(uuid) to authenticated;

-- student: my gifts waiting to be claimed
create or replace function public.ql_my_gifts()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'plan_id', g.plan_id, 'plan_name', p.name, 'color', p.color,
           'days', g.days, 'message', g.message, 'created_at', g.created_at) order by g.created_at), '[]'::jsonb)
    from ql_gifts g join ql_plans p on p.id = g.plan_id
   where g.user_id = auth.uid() and g.status = 'pending';
$$;
revoke all on function public.ql_my_gifts() from public, anon;
grant execute on function public.ql_my_gifts() to authenticated;

-- student: claim it (days are added on top of what they already have on that plan)
create or replace function public.ql_claim_gift(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g ql_gifts; v_sub ql_subscriptions;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into g from ql_gifts where id = p_id and user_id = auth.uid() for update;
  if g.id is null or g.status <> 'pending' then raise exception 'This gift is no longer available.'; end if;
  if not exists (select 1 from ql_plans where id = g.plan_id) then raise exception 'That plan no longer exists.'; end if;
  update ql_gifts set status = 'claimed', decided_at = now() where id = g.id;
  v_sub := ql__grant(g.user_id, g.plan_id, g.days);
  return jsonb_build_object('plan_id', v_sub.plan_id, 'ends_at', v_sub.ends_at);
end;
$$;
revoke all on function public.ql_claim_gift(uuid) from public, anon;
grant execute on function public.ql_claim_gift(uuid) to authenticated;

-- Instant: the student's screen updates the moment a gift is sent or cancelled
drop policy if exists "own gifts read" on public.ql_gifts;
create policy "own gifts read" on public.ql_gifts for select to authenticated using (user_id = auth.uid());
grant select on public.ql_gifts to authenticated;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ql_gifts') then
    execute 'alter publication supabase_realtime add table public.ql_gifts';
  end if;
end $$;

notify pgrst, 'reload schema';
