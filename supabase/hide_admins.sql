-- Quiz Library — keep admin accounts out of the Users list and the numbers
-- (total users, users by plan, account limit). Run once in Supabase → SQL
-- Editor, AFTER plans_admin.sql and admin_extras.sql. Safe to run again.

create or replace function public.ql_admin_users(p_search text default '', p_filter text default 'all', p_limit integer default 50, p_offset integer default 0)
returns table (user_id uuid, email text, name text, share_id text, created_at timestamptz, last_sign_in_at timestamptz,
               plan_id text, ends_at timestamptz, status text, extra_storage_mb integer, usage jsonb, device text, total bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return query
  with base as (
    select u.id, u.email::text as email,
           coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)) as name,
           u.created_at, u.last_sign_in_at, ql__effective_plan(u.id) as pid, s.ends_at, coalesce(s.status, 'active') as st,
           coalesce(s.extra_storage_mb, 0) as extra
      from auth.users u left join ql_subscriptions s on s.user_id = u.id
     where not ql__is_admin(u.id)
       and (coalesce(p_search, '') = '' or u.email ilike '%' || p_search || '%'
        or coalesce(u.raw_user_meta_data->>'full_name', '') ilike '%' || p_search || '%')
  ), f as (
    select * from base b where
      p_filter = 'all' or (p_filter = 'suspended' and b.st = 'suspended')
      or (p_filter = 'ending' and b.ends_at between now() and now() + interval '7 days')
      or (p_filter not in ('all', 'suspended', 'ending') and b.pid = p_filter)
  )
  select f.id, f.email, f.name,
         null::text,
         f.created_at, f.last_sign_in_at, f.pid, f.ends_at, f.st, f.extra, ql__usage(f.id),
         (select d.device_label from ql_active_device d where d.user_id = f.id),
         count(*) over ()
    from f order by f.created_at desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset);
end;
$$;
revoke all on function public.ql_admin_users(text, text, integer, integer) from public, anon;
grant execute on function public.ql_admin_users(text, text, integer, integer) to authenticated;

create or replace function public.ql_admin_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform ql__need_admin();
  select jsonb_build_object(
    'users', (select count(*) from auth.users where not ql__is_admin(id)),
    'users_month', (select count(*) from auth.users where created_at > date_trunc('month', now()) and not ql__is_admin(id)),
    'paying', (select count(*) from ql_subscriptions s join ql_plans p on p.id = s.plan_id
                where s.status = 'active' and (s.ends_at is null or s.ends_at > now()) and not p.is_default),
    'income_month', (select coalesce(sum(amount), 0) from ql_payment_requests where status = 'approved' and decided_at > date_trunc('month', now())),
    'income_last_month', (select coalesce(sum(amount), 0) from ql_payment_requests where status = 'approved'
                           and decided_at >= date_trunc('month', now()) - interval '1 month' and decided_at < date_trunc('month', now())),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where (metadata->>'size') ~ '^[0-9]+$'),
    'waiting_payments', (select count(*) from ql_payment_requests where status = 'waiting'),
    'ending_7d', (select count(*) from ql_subscriptions where status = 'active' and ends_at between now() and now() + interval '7 days'),
    'suspended', (select count(*) from ql_subscriptions where status = 'suspended'),
    'signups_weeks', (select jsonb_agg(c order by w desc) from (
        select w, (select count(*) from auth.users u where not ql__is_admin(u.id) and u.created_at >= date_trunc('week', now()) - make_interval(weeks => w)
                                                    and u.created_at <  date_trunc('week', now()) - make_interval(weeks => w - 1)) as c
          from generate_series(11, 0, -1) w) x),
    'by_plan', (select coalesce(jsonb_object_agg(pid, n), '{}'::jsonb) from (
        select ql__effective_plan(u.id) as pid, count(*) as n from auth.users u where not ql__is_admin(u.id) group by 1) y)
  ) into v;
  return v;
end;
$$;
revoke all on function public.ql_admin_stats() from public, anon;
grant execute on function public.ql_admin_stats() to authenticated;

create or replace function public.ql__check_signup_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_max int;
begin
  select case when (value->>'max_users') ~ '^[0-9]+$' then (value->>'max_users')::int end into v_max
    from ql_site_settings where key = 'site';
  if v_max is not null and (select count(*) from auth.users where not ql__is_admin(id)) >= v_max then
    raise exception 'Quiz Library is full right now. New sign-ups are closed.';
  end if;
  return new;
end;
$$;
drop trigger if exists ql_signup_cap on auth.users;
create trigger ql_signup_cap before insert on auth.users for each row execute function public.ql__check_signup_cap();

-- Students' website learns whether sign-ups are full (to hide Create account).
create or replace function public.ql_public_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'settings', coalesce((select jsonb_object_agg(key, value) from ql_site_settings where key in ('site','features','announcement')), '{}'::jsonb),
    'payment', (select value - 'note' || jsonb_build_object('note', value->>'note') from ql_site_settings where key = 'payment'),
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort) from ql_plans p where p.visibility <> 'hidden'), '[]'::jsonb),
    'signups_full', coalesce((select case when (value->>'max_users') ~ '^[0-9]+$'
                                          then (select count(*) from auth.users where not ql__is_admin(id)) >= (value->>'max_users')::int end
                                from ql_site_settings where key = 'site'), false),
    'server_time', now());
$$;
grant execute on function public.ql_public_config() to anon, authenticated;

notify pgrst, 'reload schema';
