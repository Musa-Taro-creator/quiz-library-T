-- Quiz Library — Make Google Form: limits per PLAN (Admin → Plans & Limits → Edit plan).
--
-- Run once in Supabase → SQL Editor, after google_forms.sql and google_forms_user_limits.sql.
-- Safe to run again. It only adds or replaces functions; no tables or plans are changed,
-- so nothing is different until you edit a plan.
--
-- In Edit plan, "Make Google Form" now has two boxes (saved in the plan's limits):
--   limits.gform_total     — HOW MANY Google Forms in total for the plan (0–100000) or "unlimited".
--                            Every form made counts, also after it is deleted; failed ones do not.
--   limits.gform_per_day   — older plans: a number a day or "unlimited" (used when gform_total is not set);
--                            neither set = the global number a day (5).
--   limits.gform_questions — questions per form, 1–200; not set or Unlimited = 200.
-- Daily number, highest priority first: admin account = Unlimited → Users → Manage →
-- the plan → the global "Forms per student per day". Unlimited (person or plan) still
-- stops at the safety cap in Settings (default 100 a day).
--
-- The three functions below are kept identical in google_forms.sql,
-- google_forms_user_limits.sql and this file (a test checks it), so running any of
-- these files again keeps everything working.

-- ------------------------------------------------------------------ same as google_forms.sql
-- All Google Forms this person has made, ever: a plan's total ("How many Google Forms").
-- Deleted forms (removed) still count; forms that failed to make do not.
create or replace function public.ql__gform_used_total(p_uid uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer from ql_google_forms where user_id = p_uid and status in ('making', 'ready');
$$;
revoke all on function public.ql__gform_used_total(uuid) from public, anon, authenticated;

-- This person's rule, highest priority first:
--   admin account → Unlimited; Admin → Users → Manage (a number or Unlimited);
--   the person's PLAN: limits.gform_total (a TOTAL for the plan: a number or "unlimited"),
--   or the older limits.gform_per_day (a number a day or "unlimited"); else the global number a day.
-- Unlimited (person or plan) still stops at the safety cap (Settings, default 100 a day).
-- Questions per form: the plan's limits.gform_questions (1–200), else 200.
-- Returns mode admin | unlimited | custom | plan | plan_total | default, limit (null = unlimited),
-- cap, global, max_questions, plan, plan_name. plan_total = limit is the plan's total, not per day.
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
  elsif v_pl->>'gform_total' = 'unlimited' then
    return v_base || jsonb_build_object('mode', 'plan', 'limit', null);
  elsif jsonb_typeof(v_pl->'gform_total') = 'number' then
    return v_base || jsonb_build_object('mode', 'plan_total', 'limit', greatest(0, least(100000, round((v_pl->>'gform_total')::numeric)::integer)));
  elsif v_pl->>'gform_per_day' = 'unlimited' then
    return v_base || jsonb_build_object('mode', 'plan', 'limit', null);
  elsif jsonb_typeof(v_pl->'gform_per_day') = 'number' then
    return v_base || jsonb_build_object('mode', 'plan', 'limit', greatest(0, least(1000, round((v_pl->>'gform_per_day')::numeric)::integer)));
  end if;
  return v_base || jsonb_build_object('mode', 'default', 'limit', v_global);
end;
$$;
revoke all on function public.ql__gform_user_rule(uuid) from public, anon, authenticated;

-- The list, this person's limit and how many are left (today, or in total for plan_total).
create or replace function public.ql_gform_mine()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rule jsonb;
  v_unl boolean;
  v_max integer;
  v_used integer;
  v_total boolean;
  v_used_total integer;
  v_left integer;
  v_cap integer;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  v_rule := ql__gform_user_rule(v_uid);
  v_unl := v_rule->'limit' = 'null'::jsonb;
  v_max := case when v_unl then (v_rule->>'cap')::integer else (v_rule->>'limit')::integer end;
  v_used := ql__gform_used(v_uid);
  v_total := v_rule->>'mode' = 'plan_total';
  v_used_total := ql__gform_used_total(v_uid);
  v_cap := (v_rule->>'cap')::integer;
  v_left := case when v_total then greatest(0, least(v_max - v_used_total, v_cap - v_used)) else greatest(0, v_max - v_used) end;
  return jsonb_build_object(
    'period', case when v_total then 'total' else 'day' end, 'used_total', v_used_total,
    'enabled', ql__feature_ok(v_uid, 'gform'),
    'set_up', exists (select 1 from ql_gform_owners where active),
    'unlimited', v_unl, 'mode', v_rule->>'mode', 'cap', (v_rule->>'cap')::integer,
    'plan_name', v_rule->>'plan_name', 'max_questions', (v_rule->>'max_questions')::integer,
    'limit', case when v_unl then null else v_max end,
    'used_today', v_used, 'left', v_left,
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
  v_used_total integer;
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
  if v_rule->>'mode' in ('plan', 'plan_total') and v_max = 0 then
    raise exception 'Your plan does not include Google Forms.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('ql_gform:' || v_uid::text));
  -- a form that never finished (closed tab, timeout) stops counting after 10 minutes
  update ql_google_forms set status = 'failed', error = coalesce(error, 'timed out'), updated_at = now()
   where user_id = v_uid and status = 'making' and created_at < now() - interval '10 minutes';
  v_used := ql__gform_used(v_uid);
  if v_rule->>'mode' = 'plan_total' then
    v_used_total := ql__gform_used_total(v_uid);
    if v_used_total >= v_max then
      raise exception 'You have made all % Google Form% in the % plan. Forms you delete still count. Upgrade to make more.',
        v_max, case when v_max = 1 then '' else 's' end, coalesce(v_rule->>'plan_name', 'your') using errcode = '42501';
    end if;
    if v_used >= (v_rule->>'cap')::integer then
      raise exception 'You made % Google Forms today, the safety limit. Try again tomorrow.', (v_rule->>'cap')::integer;
    end if;
  elsif v_used >= v_max then
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
                            'left', case when v_rule->>'mode' = 'plan_total' then greatest(0, least(v_max - v_used_total, (v_rule->>'cap')::integer - v_used) - 1)
                                         else greatest(0, v_max - v_used - 1) end);
end;
$$;
revoke all on function public.ql_gform_reserve(text, integer, text) from public, anon;
grant execute on function public.ql_gform_reserve(text, integer, text) to authenticated;
-- ------------------------------------------------------------------ end of "same as google_forms.sql"

-- Admin → Users → Manage: this person's rule + forms made today and in total (also in google_forms_user_limits.sql).
create or replace function public.ql_admin_gform_user_rule_get(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return ql__gform_user_rule(p_user) || jsonb_build_object('used_today', ql__gform_used(p_user), 'used_total', ql__gform_used_total(p_user));
end;
$$;
revoke all on function public.ql_admin_gform_user_rule_get(uuid) from public, anon;
grant execute on function public.ql_admin_gform_user_rule_get(uuid) to authenticated;


notify pgrst, 'reload schema';
