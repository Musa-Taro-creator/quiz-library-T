-- Quiz Library — "Make Google Form" (Option A: one Google account makes the forms).
--
-- Run once in Supabase → SQL Editor, after plans_admin.sql, dashboard.sql and
-- item_sharing.sql. Safe to run again. Per-person limits: google_forms_user_limits.sql.
--
-- How it fits together:
--   app  →  Edge Function ql-gform (checks the login)  →  this database (5 a day)
--        →  Apps Script web app owned by the forms Gmail (makes the form)  →  back.
-- The Apps Script address and its secret live in ql_gform_owners. Nobody can read
-- that table from the app; only Admin (through the functions below) and the Edge
-- Function (with the service key) can. Each form record keeps the Gmail that made
-- it, so switching to another Gmail later keeps old forms working while the old
-- Apps Script is still deployed.

-- ------------------------------------------------------------------ tables
create table if not exists public.ql_gform_owners (
  id          uuid        primary key default gen_random_uuid(),
  script_url  text        not null unique,
  secret      text        not null,
  owner_email text,
  active      boolean     not null default false,
  created_at  timestamptz not null default now(),
  checked_at  timestamptz
);
alter table public.ql_gform_owners enable row level security;
revoke all on public.ql_gform_owners from anon, authenticated;

create table if not exists public.ql_google_forms (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users (id) on delete cascade,
  status         text        not null default 'making' check (status in ('making', 'ready', 'failed')),
  title          text        not null default '',
  question_count integer     not null default 0,
  source         text,
  form_id        text,
  responder_url  text,
  edit_url       text,
  folder_url     text,
  owner_email    text,
  editor_email   text,
  accepting      boolean     not null default true,
  removed        boolean     not null default false,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ql_google_forms_user on public.ql_google_forms (user_id, created_at desc);
alter table public.ql_google_forms enable row level security;
revoke all on public.ql_google_forms from anon, authenticated;

-- daily limit (not secret, so it sits with the other website settings)
insert into public.ql_site_settings (key, value) values ('gform', '{"daily_limit":5}')
on conflict (key) do nothing;

-- ------------------------------------------------------------------ helpers
-- "Today" is the Cambodia day, so the 5 reset at midnight in Phnom Penh.
create or replace function public.ql__gform_day(p_at timestamptz)
returns date language sql immutable as $$ select (p_at at time zone 'Asia/Phnom_Penh')::date $$;

create or replace function public.ql__gform_limit()
returns integer language sql stable security definer set search_path = public as $$
  select greatest(0, least(100, coalesce((select (value->>'daily_limit')::integer from ql_site_settings where key = 'gform'), 5)));
$$;
revoke all on function public.ql__gform_limit() from public, anon, authenticated;

create or replace function public.ql__gform_used(p_uid uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer from ql_google_forms
   where user_id = p_uid and status in ('making', 'ready')
     and ql__gform_day(created_at) = ql__gform_day(now());
$$;
revoke all on function public.ql__gform_used(uuid) from public, anon, authenticated;

create or replace function public.ql__gform_row(r public.ql_google_forms)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', r.id, 'title', r.title, 'question_count', r.question_count, 'source', r.source,
    'form_id', r.form_id, 'responder_url', r.responder_url, 'edit_url', r.edit_url, 'folder_url', r.folder_url,
    'owner_email', r.owner_email, 'editor_email', r.editor_email, 'accepting', r.accepting, 'created_at', r.created_at);
$$;

-- ------------------------------------------------------------------ for the student (app)
-- ------------------------------------------------------------------ same as google_forms.sql
-- This person's rule, highest priority first:
--   admin account → Unlimited; Admin → Users → Manage (a number or Unlimited);
--   the person's PLAN (limits.gform_per_day: a number or "unlimited"); else the global number.
-- Unlimited (person or plan) still stops at the safety cap (Settings, default 100 a day).
-- Questions per form: the plan's limits.gform_questions (1–200), else 200.
-- Returns mode admin | unlimited | custom | plan | default, limit (null = unlimited), cap, global,
-- max_questions, plan, plan_name.
create or replace function public.ql__gform_user_rule(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_global integer := ql__gform_limit();
  v_cap integer;
  v_unl boolean;
  v_lim integer;
  v_rows integer := 0;
  v_plan text;
  v_plan_name text;
  v_pl jsonb;
  v_q integer := 200;
  v_base jsonb;
begin
  v_cap := greatest(1, least(1000, coalesce((select (value->>'unlimited_cap')::integer from ql_site_settings where key = 'gform'), 100)));
  if p_uid is not null then
    begin
      v_plan := ql__effective_plan(p_uid);
    exception when others then
      v_plan := null;
    end;
    select name, limits into v_plan_name, v_pl from ql_plans where id = v_plan;
    if jsonb_typeof(v_pl->'gform_questions') = 'number' then
      v_q := greatest(1, least(200, round((v_pl->>'gform_questions')::numeric)::integer));
    end if;
  end if;
  v_base := jsonb_build_object('cap', v_cap, 'global', v_global, 'max_questions', v_q, 'plan', v_plan, 'plan_name', v_plan_name);
  if ql__is_admin(p_uid) then
    return v_base || jsonb_build_object('mode', 'admin', 'limit', null, 'max_questions', 200);
  end if;
  if to_regclass('public.ql_gform_user_limits') is not null then
    execute 'select unlimited, daily_limit from public.ql_gform_user_limits where user_id = $1' into v_unl, v_lim using p_uid;
    get diagnostics v_rows = row_count;
  end if;
  if v_rows > 0 and v_unl then
    return v_base || jsonb_build_object('mode', 'unlimited', 'limit', null);
  elsif v_rows > 0 then
    return v_base || jsonb_build_object('mode', 'custom', 'limit', v_lim);
  elsif v_pl->>'gform_per_day' = 'unlimited' then
    return v_base || jsonb_build_object('mode', 'plan', 'limit', null);
  elsif jsonb_typeof(v_pl->'gform_per_day') = 'number' then
    return v_base || jsonb_build_object('mode', 'plan', 'limit', greatest(0, least(1000, round((v_pl->>'gform_per_day')::numeric)::integer)));
  end if;
  return v_base || jsonb_build_object('mode', 'default', 'limit', v_global);
end;
$$;
revoke all on function public.ql__gform_user_rule(uuid) from public, anon, authenticated;

-- The list, this person's limit and how many are left today.
create or replace function public.ql_gform_mine()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rule jsonb;
  v_unl boolean;
  v_max integer;
  v_used integer;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  v_rule := ql__gform_user_rule(v_uid);
  v_unl := v_rule->'limit' = 'null'::jsonb;
  v_max := case when v_unl then (v_rule->>'cap')::integer else (v_rule->>'limit')::integer end;
  v_used := ql__gform_used(v_uid);
  return jsonb_build_object(
    'enabled', ql__feature_ok(v_uid, 'gform'),
    'set_up', exists (select 1 from ql_gform_owners where active),
    'unlimited', v_unl, 'mode', v_rule->>'mode', 'cap', (v_rule->>'cap')::integer,
    'plan_name', v_rule->>'plan_name', 'max_questions', (v_rule->>'max_questions')::integer,
    'limit', case when v_unl then null else v_max end,
    'used_today', v_used, 'left', greatest(0, v_max - v_used),
    'forms', coalesce((select jsonb_agg(ql__gform_row(f) order by f.created_at desc)
                         from (select * from ql_google_forms where user_id = v_uid and status = 'ready' and not removed
                                order by created_at desc limit 300) f), '[]'::jsonb));
end;
$$;
revoke all on function public.ql_gform_mine() from public, anon;
grant execute on function public.ql_gform_mine() to authenticated;

-- Takes one of today's forms (or says why not). Called by the Edge Function as the student.
create or replace function public.ql_gform_reserve(p_title text, p_question_count integer, p_source text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rule jsonb;
  v_unl boolean;
  v_max integer;
  v_maxq integer;
  v_used integer;
  v_id uuid;
  v_label text;
  v_p jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not ql__feature_ok(v_uid, 'gform') then raise exception 'Make Google Form is turned off.' using errcode = '42501'; end if;
  if exists (select 1 from ql_subscriptions where user_id = v_uid and status = 'suspended') then
    raise exception 'Account suspended' using errcode = '42501';
  end if;
  if not exists (select 1 from ql_gform_owners where active) then
    raise exception 'Make Google Form is not set up yet. Please try again later.';
  end if;
  if coalesce(p_question_count, 0) < 1 then raise exception 'Add at least one question.'; end if;
  if p_question_count > 200 then raise exception 'A Google Form can have up to 200 questions from Quiz Library.'; end if;
  v_rule := ql__gform_user_rule(v_uid);
  v_maxq := (v_rule->>'max_questions')::integer;
  if p_question_count > v_maxq then
    raise exception 'Your plan allows % questions per form — this has %.', v_maxq, p_question_count using errcode = '42501';
  end if;
  v_unl := v_rule->'limit' = 'null'::jsonb;
  v_max := case when v_unl then (v_rule->>'cap')::integer else (v_rule->>'limit')::integer end;
  if v_rule->>'mode' = 'custom' and v_max = 0 then
    raise exception 'Making Google Forms is turned off for your account.' using errcode = '42501';
  end if;
  if v_rule->>'mode' = 'plan' and v_max = 0 then
    raise exception 'Your plan does not include Google Forms.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('ql_gform:' || v_uid::text));
  -- a form that never finished (closed tab, timeout) stops counting after 10 minutes
  update ql_google_forms set status = 'failed', error = coalesce(error, 'timed out'), updated_at = now()
   where user_id = v_uid and status = 'making' and created_at < now() - interval '10 minutes';
  v_used := ql__gform_used(v_uid);
  if v_used >= v_max then
    if v_unl then
      raise exception 'You made % Google Forms today, the safety limit. Try again tomorrow.', v_max;
    end if;
    raise exception 'You can make % Google Form% a day. Try again tomorrow.', v_max, case when v_max = 1 then '' else 's' end;
  end if;
  insert into ql_google_forms (user_id, title, question_count, source)
  values (v_uid, left(coalesce(nullif(trim(p_title), ''), 'Quiz'), 200), p_question_count, left(p_source, 20))
  returning id into v_id;
  begin
    v_p := ql__share_profile(null, v_uid);
    v_label := nullif(trim(coalesce(v_p->>'display_name', '')), '');
    if v_p->>'share_id' is not null then v_label := coalesce(v_label, 'Student') || ' (' || (v_p->>'share_id') || ')'; end if;
  exception when others then v_label := null;
  end;
  if v_label is null then
    v_label := coalesce(split_part((select email from auth.users where id = v_uid), '@', 1), 'Student') || ' (' || left(v_uid::text, 8) || ')';
  end if;
  return jsonb_build_object('record_id', v_id, 'user_id', v_uid, 'user_label', left(v_label, 120),
                            'unlimited', v_unl, 'limit', case when v_unl then null else v_max end,
                            'mode', v_rule->>'mode', 'plan_name', v_rule->>'plan_name',
                            'left', greatest(0, v_max - v_used - 1));
end;
$$;
revoke all on function public.ql_gform_reserve(text, integer, text) from public, anon;
grant execute on function public.ql_gform_reserve(text, integer, text) to authenticated;
-- ------------------------------------------------------------------ end of "same as google_forms.sql"

-- One of my forms (the Edge Function uses this to check the form is really mine).
create or replace function public.ql_gform_get(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select ql__gform_row(f) || jsonb_build_object('user_id', f.user_id)
    from ql_google_forms f where f.id = p_id and f.user_id = auth.uid() and f.status = 'ready' and not f.removed;
$$;
revoke all on function public.ql_gform_get(uuid) from public, anon;
grant execute on function public.ql_gform_get(uuid) to authenticated;

-- "Remove from list": hides it here; the Google Form itself stays in Drive.
create or replace function public.ql_gform_remove(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update ql_google_forms set removed = true, updated_at = now() where id = p_id and user_id = auth.uid();
$$;
revoke all on function public.ql_gform_remove(uuid) from public, anon;
grant execute on function public.ql_gform_remove(uuid) to authenticated;

-- ------------------------------------------------------------------ for the Edge Function only (service key)
create or replace function public.ql_gform__owner(p_owner_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('script_url', o.script_url, 'secret', o.secret, 'owner_email', o.owner_email)
    from ql_gform_owners o
   where (p_owner_email is null and o.active)
      or (p_owner_email is not null and lower(o.owner_email) = lower(p_owner_email))
   order by o.active desc, o.checked_at desc nulls last
   limit 1;
$$;

create or replace function public.ql_gform__finish(p_id uuid, p_data jsonb)
returns jsonb language sql security definer set search_path = public as $$
  update ql_google_forms set status = 'ready', error = null, updated_at = now(),
         form_id = p_data->>'form_id', title = left(coalesce(nullif(p_data->>'title', ''), title), 200),
         question_count = coalesce((p_data->>'question_count')::integer, question_count),
         responder_url = p_data->>'responder_url', edit_url = p_data->>'edit_url', folder_url = p_data->>'folder_url',
         owner_email = p_data->>'owner', editor_email = nullif(p_data->>'editor_email', '')
   where id = p_id and status = 'making'
  returning ql__gform_row(ql_google_forms.*);
$$;

create or replace function public.ql_gform__fail(p_id uuid, p_error text)
returns void language sql security definer set search_path = public as $$
  update ql_google_forms set status = 'failed', error = left(p_error, 500), updated_at = now()
   where id = p_id and status = 'making';
$$;

-- rename / open-close; and "Add my Gmail as editor" (the folder is shared, so all
-- of this student's forms made by that Gmail get it)
create or replace function public.ql_gform__update(p_id uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r ql_google_forms;
begin
  select * into r from ql_google_forms where id = p_id;
  if not found then return; end if;
  update ql_google_forms set
    title = case when p_data ? 'title' then left(p_data->>'title', 200) else title end,
    accepting = case when p_data ? 'accepting' then (p_data->>'accepting')::boolean else accepting end,
    updated_at = now()
   where id = p_id;
  if p_data ? 'editor_email' then
    update ql_google_forms set editor_email = p_data->>'editor_email', folder_url = coalesce(p_data->>'folder_url', folder_url), updated_at = now()
     where user_id = r.user_id and lower(coalesce(owner_email, '')) = lower(coalesce(r.owner_email, ''));
  end if;
end;
$$;

create or replace function public.ql_gform__checked(p_script_url text, p_owner_email text)
returns void language sql security definer set search_path = public as $$
  update ql_gform_owners set owner_email = p_owner_email, checked_at = now() where script_url = p_script_url;
$$;

do $$
declare f text;
begin
  foreach f in array array['ql_gform__owner(text)', 'ql_gform__finish(uuid, jsonb)', 'ql_gform__fail(uuid, text)',
                           'ql_gform__update(uuid, jsonb)', 'ql_gform__checked(text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------------ for Admin
create or replace function public.ql_gform_admin_check()
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return true;
end;
$$;
revoke all on function public.ql_gform_admin_check() from public, anon;
grant execute on function public.ql_gform_admin_check() to authenticated;

-- Admin sees the addresses and which Gmail made them, never the secret.
create or replace function public.ql_admin_gform_get()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return jsonb_build_object(
    'daily_limit', ql__gform_limit(),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'script_url', script_url, 'owner_email', owner_email,
                                   'active', active, 'checked_at', checked_at, 'created_at', created_at) order by active desc, created_at desc)
                          from ql_gform_owners), '[]'::jsonb),
    'made_today', (select count(*) from ql_google_forms where status = 'ready' and ql__gform_day(created_at) = ql__gform_day(now())),
    'made_total', (select count(*) from ql_google_forms where status = 'ready'));
end;
$$;
revoke all on function public.ql_admin_gform_get() from public, anon;
grant execute on function public.ql_admin_gform_get() to authenticated;

-- Paste a (new) Apps Script address + secret: it becomes the one used for new forms.
-- Leave the secret empty to keep the saved one for that same address.
create or replace function public.ql_admin_gform_save(p_script_url text, p_secret text, p_daily_limit integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_url text := trim(coalesce(p_script_url, ''));
begin
  perform ql__need_admin();
  if p_daily_limit is not null then
    if p_daily_limit < 0 or p_daily_limit > 100 then raise exception 'Daily limit must be between 0 and 100.'; end if;
    insert into ql_site_settings (key, value) values ('gform', jsonb_build_object('daily_limit', p_daily_limit))
    on conflict (key) do update set value = ql_site_settings.value || jsonb_build_object('daily_limit', p_daily_limit);
  end if;
  if v_url <> '' then
    if v_url !~ '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$' then
      raise exception 'Paste the Web app URL from Apps Script. It starts with https://script.google.com/macros/s/ and ends with /exec';
    end if;
    if nullif(trim(coalesce(p_secret, '')), '') is null and not exists (select 1 from ql_gform_owners where script_url = v_url) then
      raise exception 'Paste the secret from the Apps Script log too.';
    end if;
    insert into ql_gform_owners (script_url, secret) values (v_url, trim(p_secret))
    on conflict (script_url) do update set secret = coalesce(nullif(trim(excluded.secret), ''), ql_gform_owners.secret);
    -- Supabase blocks UPDATE/DELETE without WHERE (safeupdate); only rows that change are touched.
    update ql_gform_owners set active = (script_url = v_url) where active or script_url = v_url;
  end if;
  return ql_admin_gform_get();
end;
$$;
revoke all on function public.ql_admin_gform_save(text, text, integer) from public, anon;
grant execute on function public.ql_admin_gform_save(text, text, integer) to authenticated;

notify pgrst, 'reload schema';
