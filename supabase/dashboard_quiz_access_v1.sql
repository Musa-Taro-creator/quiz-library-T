-- Dashboard quiz taking: private account results and Tools preferences.
-- Run once in Supabase SQL Editor after the existing Dashboard setup.
-- Additive: does not replace login, sharing, library, plan or device functions.
begin;

create table if not exists public.ql_dash_quiz_preferences_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.ql_dash_posts(id) on delete cascade,
  quiz_ref text not null,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id,post_id,quiz_ref)
);
create table if not exists public.ql_dash_quiz_attempts_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  post_id uuid not null references public.ql_dash_posts(id) on delete cascade,
  quiz_ref text not null,
  revision text not null,
  session_name text,
  started_at timestamptz,
  submitted_at timestamptz not null default now(),
  result jsonb not null,
  primary key (user_id,id)
);
create index if not exists ql_dash_quiz_attempts_history_v1
  on public.ql_dash_quiz_attempts_v1(user_id,post_id,quiz_ref,submitted_at desc);
alter table public.ql_dash_quiz_preferences_v1 enable row level security;
alter table public.ql_dash_quiz_attempts_v1 enable row level security;
-- Access is exclusively through account-scoped RPCs below.
revoke all on public.ql_dash_quiz_preferences_v1,public.ql_dash_quiz_attempts_v1 from public,anon,authenticated;

create or replace function public.ql__dash_quiz_node_v1(p_post_id uuid,p_quiz_ref text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare n jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to take a Dashboard quiz.' using errcode='28000'; end if;
  if exists(select 1 from public.ql_subscriptions where user_id=auth.uid() and status='suspended') then
    raise exception 'This account is suspended.';
  end if;
  select x.value into n from public.ql_dash_posts d
    cross join lateral jsonb_array_elements(d.payload->'nodes') x
    where d.id=p_post_id and d.status='approved' and x.value->>'kind'='quiz'
      and x.value->>'ref'=p_quiz_ref limit 1;
  if n is null then raise exception 'This quiz is no longer on the Dashboard.' using errcode='P0002'; end if;
  if jsonb_typeof(n->'questions') is distinct from 'array' or jsonb_array_length(n->'questions')=0 then
    raise exception 'This posted quiz has no questions. Its author needs to repost it.';
  end if;
  return n;
end $$;
revoke all on function public.ql__dash_quiz_node_v1(uuid,text) from public,anon,authenticated;

-- Matches normal quiz grading: multi-answer sets, strict True/False, and
-- case-insensitive short answers. Never accepts a client-computed score.
create or replace function public.ql__dash_quiz_grade_v1(q jsonb,given jsonb)
returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare ca jsonb:=q->'correct_answer'; ok boolean:=false; actual numeric[]; expected numeric[]; pts numeric;
begin
  pts:=coalesce(nullif((q->>'points')::numeric,0),1);
  if given is not null and given<>'null'::jsonb and given<>'""'::jsonb then
    case q->>'type'
      when 'mcq' then
        if jsonb_typeof(ca)='array' then
          if jsonb_typeof(given)='array' then
            select array_agg(v order by v) into actual from (select distinct value::numeric v from jsonb_array_elements_text(given)) a;
            select array_agg(v order by v) into expected from (select distinct value::numeric v from jsonb_array_elements_text(ca)) a;
            ok:=actual is not distinct from expected;
          end if;
        else ok:=(given#>>'{}')=(ca#>>'{}'); end if;
      when 'true_false' then
        ok:=given in ('true'::jsonb,'false'::jsonb,'"true"'::jsonb,'"false"'::jsonb)
          and ((given#>>'{}')='true')=(ca in ('true'::jsonb,'"true"'::jsonb));
      when 'short_answer' then
        select exists(select 1 from jsonb_array_elements(case when jsonb_typeof(ca)='array' then ca else jsonb_build_array(ca) end) a
          where lower(btrim(a.value#>>'{}'))=lower(btrim(given#>>'{}'))) into ok;
      else ok:=false;
    end case;
  end if;
  return jsonb_build_object('correct',coalesce(ok,false),'correct_answer',ca,'explanation',q->'explanation','points',pts);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('correct',false,'correct_answer',ca,'explanation',q->'explanation','points',1);
end $$;
revoke all on function public.ql__dash_quiz_grade_v1(jsonb,jsonb) from public,anon,authenticated;

create or replace function public.ql_dash_quiz_get_v1(p_post_id uuid,p_quiz_ref text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare n jsonb; prefs jsonb;
begin
  n:=public.ql__dash_quiz_node_v1(p_post_id,p_quiz_ref);
  select settings into prefs from public.ql_dash_quiz_preferences_v1
    where user_id=auth.uid() and post_id=p_post_id and quiz_ref=p_quiz_ref;
  return jsonb_build_object('title',n->>'title','revision',md5(n::text),
    'settings',coalesce(n->'quiz_settings','{}'::jsonb)||coalesce(prefs,'{}'::jsonb),
    'questions',(select jsonb_agg(q.value-'correct_answer'-'explanation' order by q.ord)
      from jsonb_array_elements(n->'questions') with ordinality q(value,ord)));
end $$;

create or replace function public.ql_dash_quiz_tools_v1(p_post_id uuid,p_quiz_ref text,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare patch jsonb; saved jsonb;
begin
  perform public.ql__dash_quiz_node_v1(p_post_id,p_quiz_ref);
  if jsonb_typeof(p_patch) is distinct from 'object' or octet_length(p_patch::text)>65536 then raise exception 'Invalid quiz preferences.'; end if;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into patch from jsonb_each(p_patch)
    where key in ('layout','show_answer_immediately','auto_advance','shuffle_mode','shuffle','session_overrides','exam_ui');
  insert into public.ql_dash_quiz_preferences_v1 as t(user_id,post_id,quiz_ref,settings)
    values(auth.uid(),p_post_id,p_quiz_ref,patch)
    on conflict(user_id,post_id,quiz_ref) do update set settings=t.settings||excluded.settings,updated_at=now()
    returning settings into saved;
  return saved;
end $$;

create or replace function public.ql_dash_quiz_grade_v1(p_post_id uuid,p_quiz_ref text,p_question_id text,p_given_answer jsonb,p_revision text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare n jsonb; q jsonb;
begin
  n:=public.ql__dash_quiz_node_v1(p_post_id,p_quiz_ref);
  if md5(n::text) is distinct from p_revision then raise exception 'This post changed. Reopen the quiz.'; end if;
  select value into q from jsonb_array_elements(n->'questions') where value->>'id'=p_question_id limit 1;
  if q is null then raise exception 'Question not found in this posted quiz.'; end if;
  return public.ql__dash_quiz_grade_v1(q,p_given_answer);
end $$;

create or replace function public.ql_dash_quiz_submit_v1(p_post_id uuid,p_quiz_ref text,p_answers jsonb,p_started_at timestamptz,p_session_name text,p_revision text,p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n jsonb; qs jsonb; q jsonb; a jsonb; g jsonb; answer_map jsonb;
  detail jsonb:='[]'::jsonb; score numeric:=0; maximum numeric:=0; pct numeric; pass numeric;
  result jsonb; prior public.ql_dash_quiz_attempts_v1; display_name text;
begin
  n:=public.ql__dash_quiz_node_v1(p_post_id,p_quiz_ref);
  if p_attempt_id is null then raise exception 'Missing attempt identifier.'; end if;
  select * into prior from public.ql_dash_quiz_attempts_v1 where user_id=auth.uid() and id=p_attempt_id;
  if prior.id is not null then
    if prior.post_id<>p_post_id or prior.quiz_ref<>p_quiz_ref then raise exception 'Attempt identifier belongs to another quiz.'; end if;
    return prior.result;
  end if;
  if md5(n::text) is distinct from p_revision then raise exception 'This post changed. Reopen the quiz.'; end if;
  if jsonb_typeof(p_answers) is distinct from 'array' then raise exception 'Invalid answers.'; end if;
  select coalesce(jsonb_agg(value),'[]'::jsonb) into qs from jsonb_array_elements(n->'questions')
    where nullif(p_session_name,'') is null or case when jsonb_typeof(value->'session_labels')='array'
      then (value->'session_labels') ? p_session_name else value->>'session_label'=p_session_name end;
  if jsonb_array_length(qs)=0 then raise exception 'This section has no questions.'; end if;
  if jsonb_array_length(p_answers)<>jsonb_array_length(qs)
    or (select count(distinct value->>'question_id') from jsonb_array_elements(p_answers))<>jsonb_array_length(qs)
    or exists(select 1 from jsonb_array_elements(p_answers) a where not exists(select 1 from jsonb_array_elements(qs) q where q.value->>'id'=a.value->>'question_id')) then
    raise exception 'Submit all questions in the selected section, including unanswered questions.';
  end if;
  select jsonb_object_agg(value->>'question_id',value->'given_answer') into answer_map from jsonb_array_elements(p_answers);
  for q in select value from jsonb_array_elements(qs) loop
    a:=coalesce(answer_map->(q->>'id'),'null'::jsonb);
    g:=public.ql__dash_quiz_grade_v1(q,a);
    maximum:=maximum+(g->>'points')::numeric;
    if (g->>'correct')::boolean then score:=score+(g->>'points')::numeric; end if;
    detail:=detail||jsonb_build_array((g-'points')||jsonb_build_object('question_id',q->>'id','given',a));
  end loop;
  pct:=case when maximum>0 then round(score/maximum*100,1) else 0 end;
  pass:=(n->'quiz_settings'->>'pass_percent')::numeric;
  select left(coalesce(nullif(raw_user_meta_data->>'full_name',''),nullif(raw_user_meta_data->>'name',''),split_part(email,'@',1),'Student'),120)
    into display_name from auth.users where id=auth.uid();
  result:=jsonb_build_object('id',p_attempt_id,'attempt_id',p_attempt_id,'user_id',auth.uid(),
    'taker_name',display_name,'taker_identifier','auth:'||auth.uid()::text,'identity_mode','account','is_owner',false,
    'session_name',nullif(p_session_name,''),'started_at',p_started_at,'submitted_at',now(),
    'score',score,'max_score',maximum,'percent',pct,'passed',case when pass is null then null else pct>=pass end,'detail',detail);
  insert into public.ql_dash_quiz_attempts_v1(user_id,id,post_id,quiz_ref,revision,session_name,started_at,result)
    values(auth.uid(),p_attempt_id,p_post_id,p_quiz_ref,p_revision,nullif(p_session_name,''),p_started_at,result)
    on conflict(user_id,id) do nothing;
  select * into prior from public.ql_dash_quiz_attempts_v1 where user_id=auth.uid() and id=p_attempt_id;
  if prior.post_id<>p_post_id or prior.quiz_ref<>p_quiz_ref then raise exception 'Attempt identifier belongs to another quiz.'; end if;
  return prior.result;
end $$;

create or replace function public.ql_dash_quiz_history_v1(p_post_id uuid,p_quiz_ref text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  perform public.ql__dash_quiz_node_v1(p_post_id,p_quiz_ref);
  return coalesce((select jsonb_agg(result order by submitted_at desc) from public.ql_dash_quiz_attempts_v1
    where user_id=auth.uid() and post_id=p_post_id and quiz_ref=p_quiz_ref),'[]'::jsonb);
end $$;

revoke all on function public.ql_dash_quiz_get_v1(uuid,text),public.ql_dash_quiz_tools_v1(uuid,text,jsonb),
  public.ql_dash_quiz_grade_v1(uuid,text,text,jsonb,text),public.ql_dash_quiz_submit_v1(uuid,text,jsonb,timestamptz,text,text,uuid),
  public.ql_dash_quiz_history_v1(uuid,text) from public,anon;
grant execute on function public.ql_dash_quiz_get_v1(uuid,text),public.ql_dash_quiz_tools_v1(uuid,text,jsonb),
  public.ql_dash_quiz_grade_v1(uuid,text,text,jsonb,text),public.ql_dash_quiz_submit_v1(uuid,text,jsonb,timestamptz,text,text,uuid),
  public.ql_dash_quiz_history_v1(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
select 'Dashboard quiz access update complete' as result;
