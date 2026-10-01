-- Quiz Library — plans, subscriptions, activation codes, payments and the
-- admin website (admin.html).
--
-- Run this once in Supabase → SQL Editor. It is safe to run again.
-- Nothing existing is deleted.
--
-- BEFORE RUNNING: put the email of YOUR account (the one that may open
-- admin.html) on the line marked ### ADMIN EMAIL ### near the bottom.

-- ------------------------------------------------------------------ tables
create table if not exists public.ql_admins (
  user_id    uuid primary key,
  added_at   timestamptz not null default now()
);

create table if not exists public.ql_plans (
  id             text primary key,
  name           text not null,
  tagline        text not null default '',
  color          text not null default '#6366f1',
  badge          text not null default '',
  price_month    numeric(10,2),
  price_year     numeric(10,2),
  price_lifetime numeric(10,2),
  visibility     text not null default 'public',      -- public | code | hidden
  sort           integer not null default 100,
  limits         jsonb not null default '{}'::jsonb,  -- storage_mb, quizzes, pdfs, questions_per_quiz, devices, results_kept (null = unlimited)
  features       jsonb not null default '{}'::jsonb,  -- feature_key: true
  is_default     boolean not null default false,      -- the plan everyone falls back to (Free)
  updated_at     timestamptz not null default now()
);

create table if not exists public.ql_site_settings (
  key        text primary key,   -- site | features | announcement | payment
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.ql_subscriptions (
  user_id          uuid primary key,
  plan_id          text not null,
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz,              -- null = never ends
  status           text not null default 'active',   -- active | suspended
  extra_storage_mb integer not null default 0,
  force_logout_at  timestamptz,
  updated_at       timestamptz not null default now()
);

create table if not exists public.ql_activation_codes (
  code        text primary key,
  plan_id     text not null,
  days        integer,                 -- null = never ends
  max_uses    integer,                 -- null = no limit
  uses        integer not null default 0,
  expires_at  timestamptz,             -- null = never
  note        text not null default '',
  cancelled   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.ql_code_redemptions (
  code        text not null,
  user_id     uuid not null,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

create table if not exists public.ql_payment_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  plan_id     text not null,
  period      text not null,          -- month | year | lifetime
  amount      numeric(10,2),
  receipt     text,                   -- small JPEG as data URL
  status      text not null default 'waiting',   -- waiting | approved | rejected
  admin_note  text not null default '',
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists ql_payment_requests_status on public.ql_payment_requests (status, created_at desc);

alter table public.ql_admins            enable row level security;
alter table public.ql_plans             enable row level security;
alter table public.ql_site_settings     enable row level security;
alter table public.ql_subscriptions     enable row level security;
alter table public.ql_activation_codes  enable row level security;
alter table public.ql_code_redemptions  enable row level security;
alter table public.ql_payment_requests  enable row level security;
revoke all on public.ql_admins, public.ql_plans, public.ql_site_settings, public.ql_subscriptions,
              public.ql_activation_codes, public.ql_code_redemptions, public.ql_payment_requests
  from anon, authenticated;

-- Settings and visible plans are public (needed for the closed-website page
-- and for instant updates); everything else goes through the functions below.
drop policy if exists "public settings read" on public.ql_site_settings;
create policy "public settings read" on public.ql_site_settings for select to anon, authenticated using (true);
grant select on public.ql_site_settings to anon, authenticated;
drop policy if exists "public plans read" on public.ql_plans;
create policy "public plans read" on public.ql_plans for select to anon, authenticated using (true);
grant select on public.ql_plans to anon, authenticated;
drop policy if exists "own subscription read" on public.ql_subscriptions;
create policy "own subscription read" on public.ql_subscriptions for select to authenticated using (user_id = auth.uid());
grant select on public.ql_subscriptions to authenticated;

-- ------------------------------------------------------------------ seeds
insert into public.ql_plans (id, name, tagline, color, badge, price_month, price_year, visibility, sort, limits, features, is_default) values
 ('free','Free','Start learning','#94a3b8','',0,0,'public',10,
  '{"storage_mb":100,"quizzes":10,"pdfs":20,"questions_per_quiz":100,"devices":1,"results_kept":5}',
  '{"item_share_in":true,"nav_random":true}', true),
 ('pro','Pro','For serious students','#6366f1','MOST POPULAR',4,39,'public',20,
  '{"storage_mb":2048,"quizzes":null,"pdfs":null,"questions_per_quiz":null,"devices":1,"results_kept":null}',
  '{"item_share_in":true,"item_share_ex":true,"pf_themes":true,"nav_random":true,"ed_images":true}', false),
 ('max','Max','Everything, more space','#a855f7','',8,79,'public',30,
  '{"storage_mb":10240,"quizzes":null,"pdfs":null,"questions_per_quiz":null,"devices":2,"results_kept":null}',
  '{"item_share_in":true,"item_share_ex":true,"pf_themes":true,"nav_random":true,"ed_images":true,"quiz_results_export":true}', false)
on conflict (id) do nothing;

insert into public.ql_site_settings (key, value) values
 ('site','{"open":true,"message":"Quiz Library is under maintenance. Back soon!","close_at":null,"signups":true}'),
 ('features','{"item_share_ex":"plan","pf_themes":"plan","ed_images":"plan"}'),
 ('announcement','{"active":false,"text":"","level":"info"}'),
 ('payment','{"bank":"","account_name":"","account_number":"","qr_image":"","note":"","receipts":true}')
on conflict (key) do nothing;

-- ------------------------------------------------------------------ helpers
create or replace function public.ql__is_admin(p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from ql_admins where user_id = p_uid);
$$;
revoke all on function public.ql__is_admin(uuid) from public, anon, authenticated;

create or replace function public.ql__need_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not ql__is_admin(auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.ql__need_admin() from public, anon, authenticated;

create or replace function public.ql__default_plan()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select id from ql_plans where is_default order by sort limit 1), 'free');
$$;
revoke all on function public.ql__default_plan() from public, anon, authenticated;

-- The plan someone is on right now (paid plan until it ends, then the default plan).
create or replace function public.ql__effective_plan(p_uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.plan_id from ql_subscriptions s
      where s.user_id = p_uid and s.status = 'active' and (s.ends_at is null or s.ends_at > now())
        and exists (select 1 from ql_plans p where p.id = s.plan_id)),
    ql__default_plan());
$$;
revoke all on function public.ql__effective_plan(uuid) from public, anon, authenticated;

-- Items the account created itself (copies of shared library items are not counted).
create or replace function public.ql__usage(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if to_regclass('public.student_library_items') is null then
    return '{"quizzes":0,"pdfs":0,"folders":0,"links":0,"storage_bytes":0}'::jsonb;
  end if;
  execute $q$
    select jsonb_build_object(
      'quizzes', count(*) filter (where payload->>'kind' = 'quiz'),
      'pdfs',    count(*) filter (where payload->>'kind' = 'pdf'),
      'folders', count(*) filter (where payload->>'kind' = 'folder'),
      'links',   count(*) filter (where payload->>'kind' = 'link'),
      'storage_bytes', coalesce(sum(case when payload->>'kind' = 'pdf' and (payload->>'file_size') ~ '^[0-9]+$'
                                         then (payload->>'file_size')::bigint else 0 end), 0))
      from public.student_library_items
     where user_id = $1 and personalized
       and coalesce(payload->>'is_trashed', 'false') <> 'true'
  $q$ into v using p_uid;
  return v;
end;
$$;
revoke all on function public.ql__usage(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ everyone
-- Website settings + plans shown to students (works without signing in).
create or replace function public.ql_public_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'settings', coalesce((select jsonb_object_agg(key, value) from ql_site_settings where key in ('site','features','announcement')), '{}'::jsonb),
    'payment', (select value - 'note' || jsonb_build_object('note', value->>'note') from ql_site_settings where key = 'payment'),
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort) from ql_plans p where p.visibility <> 'hidden'), '[]'::jsonb),
    'server_time', now());
$$;
grant execute on function public.ql_public_config() to anon, authenticated;

-- My plan, end time and usage.
create or replace function public.ql_my_plan()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_pid text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  v_pid := ql__effective_plan(v_uid);
  return jsonb_build_object(
    'plan', (select to_jsonb(p) from ql_plans p where p.id = v_pid),
    'subscription', (select to_jsonb(s) from ql_subscriptions s where s.user_id = v_uid),
    'usage', ql__usage(v_uid),
    'is_admin', ql__is_admin(v_uid),
    'server_time', now());
end;
$$;
revoke all on function public.ql_my_plan() from public, anon;
grant execute on function public.ql_my_plan() to authenticated;

-- Adds days on top of what the account already has (nobody loses paid days).
create or replace function public.ql__grant(p_uid uuid, p_plan text, p_days integer)
returns ql_subscriptions language plpgsql security definer set search_path = public as $$
declare
  v_old ql_subscriptions;
  v_from timestamptz;
  v_end timestamptz;
  v_row ql_subscriptions;
begin
  select * into v_old from ql_subscriptions where user_id = p_uid;
  v_from := now();
  if v_old.user_id is not null and v_old.plan_id = p_plan and v_old.status = 'active' and v_old.ends_at > now() then
    v_from := v_old.ends_at;
  end if;
  v_end := case when p_days is null then null else v_from + make_interval(days => p_days) end;
  insert into ql_subscriptions (user_id, plan_id, starts_at, ends_at, status, updated_at)
  values (p_uid, p_plan, now(), v_end, 'active', now())
  on conflict (user_id) do update
     set plan_id = excluded.plan_id,
         starts_at = case when ql_subscriptions.plan_id = excluded.plan_id and ql_subscriptions.ends_at > now()
                          then ql_subscriptions.starts_at else now() end,
         ends_at = excluded.ends_at, status = 'active', updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.ql__grant(uuid, text, integer) from public, anon, authenticated;

create or replace function public.ql_redeem_code(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_c ql_activation_codes;
  v_sub ql_subscriptions;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_c from ql_activation_codes where code = upper(trim(p_code)) for update;
  if v_c.code is null then raise exception 'That code is not valid.'; end if;
  if v_c.cancelled then raise exception 'That code was cancelled.'; end if;
  if v_c.expires_at is not null and v_c.expires_at < now() then raise exception 'That code has expired.'; end if;
  if v_c.max_uses is not null and v_c.uses >= v_c.max_uses then raise exception 'That code has already been used.'; end if;
  if exists (select 1 from ql_code_redemptions where code = v_c.code and user_id = v_uid) then
    raise exception 'You already used this code.';
  end if;
  if not exists (select 1 from ql_plans where id = v_c.plan_id) then raise exception 'That plan no longer exists.'; end if;
  insert into ql_code_redemptions (code, user_id) values (v_c.code, v_uid);
  update ql_activation_codes set uses = uses + 1 where code = v_c.code;
  v_sub := ql__grant(v_uid, v_c.plan_id, v_c.days);
  return jsonb_build_object('plan_id', v_sub.plan_id, 'ends_at', v_sub.ends_at);
end;
$$;
revoke all on function public.ql_redeem_code(text) from public, anon;
grant execute on function public.ql_redeem_code(text) to authenticated;

create or replace function public.ql_submit_payment(p_plan text, p_period text, p_receipt text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p ql_plans;
  v_amount numeric;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from ql_plans where id = p_plan and visibility = 'public';
  if v_p.id is null then raise exception 'That plan is not available.'; end if;
  v_amount := case p_period when 'month' then v_p.price_month when 'year' then v_p.price_year when 'lifetime' then v_p.price_lifetime end;
  if v_amount is null then raise exception 'That payment option is not available.'; end if;
  if length(coalesce(p_receipt, '')) < 100 then raise exception 'Please add a photo of your receipt.'; end if;
  if length(p_receipt) > 1500000 then raise exception 'The receipt photo is too large.'; end if;
  if (select count(*) from ql_payment_requests where user_id = v_uid and status = 'waiting') >= 3 then
    raise exception 'You already have payments waiting for approval.';
  end if;
  insert into ql_payment_requests (user_id, plan_id, period, amount, receipt)
  values (v_uid, p_plan, p_period, v_amount, p_receipt) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_submit_payment(text, text, text) from public, anon;
grant execute on function public.ql_submit_payment(text, text, text) to authenticated;

create or replace function public.ql_my_payments()
returns table (id uuid, plan_id text, period text, amount numeric, status text, admin_note text, created_at timestamptz, decided_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, plan_id, period, amount, status, admin_note, created_at, decided_at
    from ql_payment_requests where user_id = auth.uid() order by created_at desc limit 50;
$$;
revoke all on function public.ql_my_payments() from public, anon;
grant execute on function public.ql_my_payments() to authenticated;

-- ------------------------------------------------------------------ limits
-- New quizzes / PDFs past the plan limit are refused by the database.
create or replace function public.ql__check_item_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_lim jsonb;
  v_use jsonb;
  v_kind text := new.payload->>'kind';
  v_extra integer;
begin
  if not coalesce(new.personalized, false) or v_kind not in ('quiz', 'pdf') then return new; end if;
  if exists (select 1 from student_library_items where user_id = new.user_id and library_id = new.library_id and id = new.id) then
    return new;   -- an edit of an existing item, not a new one
  end if;
  if exists (select 1 from ql_subscriptions where user_id = new.user_id and status = 'suspended') then
    raise exception 'plan_limit:suspended';
  end if;
  select limits into v_lim from ql_plans where id = ql__effective_plan(new.user_id);
  if v_lim is null then return new; end if;
  v_use := ql__usage(new.user_id);
  if v_kind = 'quiz' and (v_lim->>'quizzes') is not null and (v_use->>'quizzes')::int >= (v_lim->>'quizzes')::int then
    raise exception 'plan_limit:quizzes';
  end if;
  if v_kind = 'pdf' then
    if (v_lim->>'pdfs') is not null and (v_use->>'pdfs')::int >= (v_lim->>'pdfs')::int then
      raise exception 'plan_limit:pdfs';
    end if;
    select coalesce(extra_storage_mb, 0) into v_extra from ql_subscriptions where user_id = new.user_id;
    if (v_lim->>'storage_mb') is not null and (new.payload->>'file_size') ~ '^[0-9]+$' and
       (v_use->>'storage_bytes')::bigint + (new.payload->>'file_size')::bigint
         > ((v_lim->>'storage_mb')::bigint + coalesce(v_extra, 0)) * 1048576 then
      raise exception 'plan_limit:storage';
    end if;
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.student_library_items') is not null then
    execute 'drop trigger if exists ql_item_limits on public.student_library_items';
    execute 'create trigger ql_item_limits before insert on public.student_library_items for each row execute function public.ql__check_item_limits()';
  end if;
end $$;

-- ------------------------------------------------------------------ admin
create or replace function public.ql_admin_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform ql__need_admin();
  select jsonb_build_object(
    'users', (select count(*) from auth.users),
    'users_month', (select count(*) from auth.users where created_at > date_trunc('month', now())),
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
        select w, (select count(*) from auth.users u where u.created_at >= date_trunc('week', now()) - make_interval(weeks => w)
                                                    and u.created_at <  date_trunc('week', now()) - make_interval(weeks => w - 1)) as c
          from generate_series(11, 0, -1) w) x),
    'by_plan', (select coalesce(jsonb_object_agg(pid, n), '{}'::jsonb) from (
        select ql__effective_plan(u.id) as pid, count(*) as n from auth.users u group by 1) y)
  ) into v;
  return v;
end;
$$;
revoke all on function public.ql_admin_stats() from public, anon;
grant execute on function public.ql_admin_stats() to authenticated;

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
     where coalesce(p_search, '') = '' or u.email ilike '%' || p_search || '%'
        or coalesce(u.raw_user_meta_data->>'full_name', '') ilike '%' || p_search || '%'
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

create or replace function public.ql_admin_update_user(p_user uuid, p_action text, p_plan text default null, p_days integer default null, p_value integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sub ql_subscriptions;
begin
  perform ql__need_admin();
  if p_action = 'set_plan' then
    if not exists (select 1 from ql_plans where id = p_plan) then raise exception 'Unknown plan'; end if;
    insert into ql_subscriptions (user_id, plan_id, starts_at, ends_at, status)
    values (p_user, p_plan, now(), case when p_days is null then null else now() + make_interval(days => p_days) end, 'active')
    on conflict (user_id) do update set plan_id = excluded.plan_id, starts_at = now(), ends_at = excluded.ends_at, status = 'active', updated_at = now();
  elsif p_action = 'add_days' then
    v_sub := ql__grant(p_user, coalesce(p_plan, ql__effective_plan(p_user)), p_days);
  elsif p_action = 'extra_storage' then
    insert into ql_subscriptions (user_id, plan_id, extra_storage_mb) values (p_user, ql__default_plan(), greatest(0, coalesce(p_value, 0)))
    on conflict (user_id) do update set extra_storage_mb = greatest(0, coalesce(p_value, 0)), updated_at = now();
  elsif p_action = 'suspend' or p_action = 'unsuspend' then
    insert into ql_subscriptions (user_id, plan_id, status) values (p_user, ql__default_plan(), case when p_action = 'suspend' then 'suspended' else 'active' end)
    on conflict (user_id) do update set status = case when p_action = 'suspend' then 'suspended' else 'active' end, updated_at = now(),
                                        force_logout_at = case when p_action = 'suspend' then now() else ql_subscriptions.force_logout_at end;
  elsif p_action = 'logout' then
    insert into ql_subscriptions (user_id, plan_id, force_logout_at) values (p_user, ql__default_plan(), now())
    on conflict (user_id) do update set force_logout_at = now(), updated_at = now();
    if to_regclass('public.ql_active_device') is not null then
      delete from ql_active_device where user_id = p_user;
    end if;
  else
    raise exception 'Unknown action';
  end if;
  return (select to_jsonb(s) from ql_subscriptions s where s.user_id = p_user);
end;
$$;
revoke all on function public.ql_admin_update_user(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.ql_admin_update_user(uuid, text, text, integer, integer) to authenticated;

create or replace function public.ql_admin_plans()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('members',
            (select count(*) from auth.users u where ql__effective_plan(u.id) = p.id)) order by p.sort) from ql_plans p), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_plans() from public, anon;
grant execute on function public.ql_admin_plans() to authenticated;

create or replace function public.ql_admin_save_plan(p jsonb)
returns ql_plans language plpgsql security definer set search_path = public as $$
declare
  v_id text := lower(regexp_replace(coalesce(nullif(p->>'id', ''), p->>'name', ''), '[^a-zA-Z0-9]+', '_', 'g'));
  v_row ql_plans;
begin
  perform ql__need_admin();
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Give the plan a name'; end if;
  if v_id = '' then raise exception 'Plan id missing'; end if;
  insert into ql_plans (id, name, tagline, color, badge, price_month, price_year, price_lifetime, visibility, sort, limits, features, updated_at)
  values (v_id, trim(p->>'name'), coalesce(p->>'tagline', ''), coalesce(nullif(p->>'color', ''), '#6366f1'), coalesce(p->>'badge', ''),
          nullif(p->>'price_month', '')::numeric, nullif(p->>'price_year', '')::numeric, nullif(p->>'price_lifetime', '')::numeric,
          coalesce(nullif(p->>'visibility', ''), 'public'), coalesce(nullif(p->>'sort', '')::int, 100),
          coalesce(p->'limits', '{}'::jsonb), coalesce(p->'features', '{}'::jsonb), now())
  on conflict (id) do update set
    name = excluded.name, tagline = excluded.tagline, color = excluded.color, badge = excluded.badge,
    price_month = excluded.price_month, price_year = excluded.price_year, price_lifetime = excluded.price_lifetime,
    visibility = excluded.visibility, sort = excluded.sort, limits = excluded.limits, features = excluded.features, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.ql_admin_save_plan(jsonb) from public, anon;
grant execute on function public.ql_admin_save_plan(jsonb) to authenticated;

create or replace function public.ql_admin_order_plans(p_ids text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  update ql_plans p set sort = x.n * 10 from unnest(p_ids) with ordinality as x(id, n) where p.id = x.id;
end;
$$;
revoke all on function public.ql_admin_order_plans(text[]) from public, anon;
grant execute on function public.ql_admin_order_plans(text[]) to authenticated;

-- Deleting a plan moves its people to another plan (their end date is kept).
create or replace function public.ql_admin_delete_plan(p_id text, p_move_to text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if (select is_default from ql_plans where id = p_id) then raise exception 'The default (free) plan cannot be deleted'; end if;
  if not exists (select 1 from ql_plans where id = p_move_to) or p_move_to = p_id then raise exception 'Choose another plan to move people to'; end if;
  update ql_subscriptions set plan_id = p_move_to, updated_at = now() where plan_id = p_id;
  update ql_activation_codes set cancelled = true where plan_id = p_id and not cancelled;
  delete from ql_plans where id = p_id;
end;
$$;
revoke all on function public.ql_admin_delete_plan(text, text) from public, anon;
grant execute on function public.ql_admin_delete_plan(text, text) to authenticated;

create or replace function public.ql_admin_set_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_key not in ('site', 'features', 'announcement', 'payment') then raise exception 'Unknown setting'; end if;
  insert into ql_site_settings (key, value, updated_at) values (p_key, coalesce(p_value, '{}'::jsonb), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;
revoke all on function public.ql_admin_set_setting(text, jsonb) from public, anon;
grant execute on function public.ql_admin_set_setting(text, jsonb) to authenticated;

create or replace function public.ql_admin_create_codes(p_plan text, p_days integer, p_max_uses integer, p_valid_days integer, p_note text, p_count integer, p_custom text default null)
returns setof ql_activation_codes language plpgsql security definer set search_path = public as $$
declare
  v_alpha text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text; v_bytes bytea; i int; k int; v_prefix text;
begin
  perform ql__need_admin();
  if not exists (select 1 from ql_plans where id = p_plan) then raise exception 'Unknown plan'; end if;
  v_prefix := 'QL' || upper(left(p_plan, 1));
  for k in 1..greatest(1, least(coalesce(p_count, 1), 200)) loop
    if coalesce(trim(p_custom), '') <> '' and k = 1 then
      v_code := upper(regexp_replace(trim(p_custom), '[^A-Za-z0-9-]', '', 'g'));
    else
      loop
        v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
        v_code := v_prefix || '-';
        for i in 0..7 loop
          if i = 4 then v_code := v_code || '-'; end if;
          v_code := v_code || substr(v_alpha, 1 + (get_byte(v_bytes, i) % length(v_alpha)), 1);
        end loop;
        exit when not exists (select 1 from ql_activation_codes where code = v_code);
      end loop;
    end if;
    insert into ql_activation_codes (code, plan_id, days, max_uses, expires_at, note)
    values (v_code, p_plan, p_days, p_max_uses,
            case when p_valid_days is null then null else now() + make_interval(days => p_valid_days) end, coalesce(p_note, ''));
    return query select * from ql_activation_codes where code = v_code;
  end loop;
end;
$$;
revoke all on function public.ql_admin_create_codes(text, integer, integer, integer, text, integer, text) from public, anon;
grant execute on function public.ql_admin_create_codes(text, integer, integer, integer, text, integer, text) to authenticated;

create or replace function public.ql_admin_codes()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('used_by',
           (select coalesce(jsonb_agg(coalesce(u.raw_user_meta_data->>'full_name', u.email) order by r.redeemed_at), '[]'::jsonb)
              from ql_code_redemptions r join auth.users u on u.id = r.user_id where r.code = c.code)) order by c.created_at desc)
    from ql_activation_codes c), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_codes() from public, anon;
grant execute on function public.ql_admin_codes() to authenticated;

create or replace function public.ql_admin_cancel_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  update ql_activation_codes set cancelled = true where code = p_code;
end;
$$;
revoke all on function public.ql_admin_cancel_code(text) from public, anon;
grant execute on function public.ql_admin_cancel_code(text) to authenticated;

create or replace function public.ql_admin_payments(p_status text default 'waiting')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object(
           'email', u.email, 'name', coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))) order by r.created_at desc)
    from ql_payment_requests r left join auth.users u on u.id = r.user_id
    where r.status = p_status), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_payments(text) from public, anon;
grant execute on function public.ql_admin_payments(text) to authenticated;

create or replace function public.ql_admin_decide_payment(p_id uuid, p_approve boolean, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
declare r ql_payment_requests;
begin
  perform ql__need_admin();
  select * into r from ql_payment_requests where id = p_id for update;
  if r.id is null or r.status <> 'waiting' then raise exception 'This payment was already handled'; end if;
  update ql_payment_requests set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = coalesce(p_note, ''), decided_at = now() where id = p_id;
  if p_approve then
    perform ql__grant(r.user_id, r.plan_id, case r.period when 'month' then 30 when 'year' then 365 else null end);
  end if;
end;
$$;
revoke all on function public.ql_admin_decide_payment(uuid, boolean, text) from public, anon;
grant execute on function public.ql_admin_decide_payment(uuid, boolean, text) to authenticated;

create or replace function public.ql_am_i_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select ql__is_admin(auth.uid());
$$;
grant execute on function public.ql_am_i_admin() to authenticated;

-- Instant updates on students' screens when you change something.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['ql_site_settings', 'ql_plans', 'ql_subscriptions'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ### ADMIN EMAIL ### — the account that may open admin.html
insert into public.ql_admins (user_id)
select id from auth.users where lower(email) = lower('nni090450@gmail.com')
on conflict do nothing;

notify pgrst, 'reload schema';
