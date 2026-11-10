-- Quiz Library — Make Google Form: a daily limit per person (set by Admin).
--
-- Run once in Supabase → SQL Editor, after google_forms.sql. Safe to run again.
-- Every UPDATE/DELETE has a WHERE (Supabase safeupdate is on).
--
-- Each person's "Google Forms per day":
--   Admin accounts         → Unlimited, always.
--   Admin set a number     → that number (0–1000; 0 = this person cannot make forms).
--   Admin set Unlimited    → Unlimited.
--   Nothing set (Default)  → the global "Forms per student per day" (Admin → Settings, 5).
-- Unlimited still has a safety cap per person per day (default 100, Admin → Settings),
-- so a mistake or a stuck script can't make hundreds of forms in one day.
--
-- The three functions marked "same as google_forms.sql" are kept identical in
-- google_forms.sql, this file and google_forms_plan_limits.sql (a test checks it),
-- so running any of them again never undoes the others.

create table if not exists public.ql_gform_user_limits (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  unlimited   boolean     not null default false,
  daily_limit integer     check (daily_limit between 0 and 1000),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check (unlimited or daily_limit is not null)
);
alter table public.ql_gform_user_limits enable row level security;
revoke all on public.ql_gform_user_limits from anon, authenticated;

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

-- ------------------------------------------------------------------ Admin
-- One person's setting (Admin → Users → Manage).
create or replace function public.ql_admin_gform_user_rule_get(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return ql__gform_user_rule(p_user) || jsonb_build_object('used_today', ql__gform_used(p_user));
end;
$$;
revoke all on function public.ql_admin_gform_user_rule_get(uuid) from public, anon;
grant execute on function public.ql_admin_gform_user_rule_get(uuid) to authenticated;

-- p_mode: 'default' (use the global number), 'custom' (p_limit 0–1000) or 'unlimited'.
create or replace function public.ql_admin_gform_user_rule_set(p_user uuid, p_mode text, p_limit integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then raise exception 'User not found.'; end if;
  if p_mode = 'default' then
    delete from ql_gform_user_limits where user_id = p_user;
  elsif p_mode = 'unlimited' then
    insert into ql_gform_user_limits (user_id, unlimited, daily_limit, updated_by)
    values (p_user, true, null, auth.uid())
    on conflict (user_id) do update set unlimited = true, daily_limit = null, updated_at = now(), updated_by = auth.uid();
  elsif p_mode = 'custom' then
    if p_limit is null or p_limit < 0 or p_limit > 1000 then raise exception 'Type a number from 0 to 1000.'; end if;
    insert into ql_gform_user_limits (user_id, unlimited, daily_limit, updated_by)
    values (p_user, false, p_limit, auth.uid())
    on conflict (user_id) do update set unlimited = false, daily_limit = excluded.daily_limit, updated_at = now(), updated_by = auth.uid();
  else
    raise exception 'Choose Default, a number or Unlimited.';
  end if;
  return ql_admin_gform_user_rule_get(p_user);
end;
$$;
revoke all on function public.ql_admin_gform_user_rule_set(uuid, text, integer) from public, anon;
grant execute on function public.ql_admin_gform_user_rule_set(uuid, text, integer) to authenticated;

-- Everyone with an own setting, for the small badge in the users list: {user_id: {unlimited, daily_limit}}.
create or replace function public.ql_admin_gform_user_rules()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_object_agg(user_id::text, jsonb_build_object('unlimited', unlimited, 'daily_limit', daily_limit))
                     from ql_gform_user_limits), '{}'::jsonb);
end;
$$;
revoke all on function public.ql_admin_gform_user_rules() from public, anon;
grant execute on function public.ql_admin_gform_user_rules() to authenticated;

-- Safety cap for Unlimited (Admin → Settings → Make Google Form).
create or replace function public.ql_admin_gform_cap_get()
returns integer language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return (ql__gform_user_rule(null)->>'cap')::integer;
end;
$$;
revoke all on function public.ql_admin_gform_cap_get() from public, anon;
grant execute on function public.ql_admin_gform_cap_get() to authenticated;

create or replace function public.ql_admin_gform_cap_set(p_cap integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_cap is null or p_cap < 1 or p_cap > 1000 then raise exception 'Type a number from 1 to 1000.'; end if;
  insert into ql_site_settings (key, value) values ('gform', jsonb_build_object('daily_limit', 5, 'unlimited_cap', p_cap))
  on conflict (key) do update set value = ql_site_settings.value || jsonb_build_object('unlimited_cap', p_cap);
  return p_cap;
end;
$$;
revoke all on function public.ql_admin_gform_cap_set(integer) from public, anon;
grant execute on function public.ql_admin_gform_cap_set(integer) to authenticated;

notify pgrst, 'reload schema';
