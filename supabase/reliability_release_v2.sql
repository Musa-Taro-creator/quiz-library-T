-- Reviewed release SQL. Adds quiz-save protection and resumable Dashboard posting.
-- Does not rewrite existing quiz questions/settings or student attempts.
-- Existing old editors must refresh after the matching website release.
-- Run this combined script OR the two component files, not both forms.
begin;
-- Quiz save protocol v2. Apply as ONE transaction only after schema review.
-- No existing question contents are rewritten. Old unsafe quiz writers are retired.
-- Fail before changing permissions if the deployed base schema differs.
-- This is a guard, not a substitute for reviewing its existing RPCs/triggers.
do $$
declare r record;actual text;
begin
 for r in select * from (values
  ('student_library_items','user_id',array['uuid']),
  ('student_library_items','library_id',array['text','uuid','character varying']),
  ('student_library_items','id',array['text','uuid','character varying']),
  ('student_library_items','payload',array['jsonb']),
  ('student_library_items','personalized',array['boolean']),
  ('student_library_items','source_updated_at',array['timestamp with time zone','timestamp without time zone','text']),
  ('student_library_items','updated_at',array['timestamp with time zone','timestamp without time zone']),
  ('student_quiz_questions','user_id',array['uuid']),
  ('student_quiz_questions','library_id',array['text']),
  ('student_quiz_questions','item_id',array['text']),
  ('student_quiz_questions','id',array['text']),
  ('student_quiz_questions','position',array['integer']),
  ('student_quiz_questions','data',array['jsonb']),
  ('student_quiz_questions','updated_at',array['timestamp with time zone','timestamp without time zone'])
 ) required(table_name,column_name,types) loop
  select format_type(a.atttypid,null) into actual from pg_attribute a
   join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname=r.table_name and a.attname=r.column_name and not a.attisdropped;
  if actual is null or not(actual=any(r.types)) then
   raise exception 'QL_PROTOCOL: Schema review required for %.% (type %)',r.table_name,r.column_name,coalesce(actual,'missing');
  end if;
 end loop;
end $$;
create table if not exists public.student_quiz_save_versions_v2 (
  user_id uuid not null references auth.users(id) on delete cascade,
  library_id text not null,
  item_id text not null,
  revision bigint not null default 0,
  primary key (user_id, library_id, item_id)
);
create table if not exists public.student_quiz_saves_v2 (
  user_id uuid not null references auth.users(id) on delete cascade,
  save_id uuid not null,
  library_id text not null,
  item_id text not null,
  question_count integer not null check (question_count >= 0),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  base_revision bigint,
  committed_revision bigint,
  result jsonb,
  mode text not null default 'full',
  content_hash text,
  expires_at timestamptz not null default now() + interval '24 hours',
  primary key (user_id, save_id)
);
create index if not exists student_quiz_saves_v2_expiry on public.student_quiz_saves_v2 (user_id, expires_at);
create table if not exists public.student_quiz_save_batches_v2 (
  user_id uuid not null references auth.users(id) on delete cascade,
  save_id uuid not null,
  batch_index integer not null check (batch_index >= 0),
  questions jsonb check (questions is null or jsonb_typeof(questions) = 'array'),
  fingerprint text not null,
  primary key (user_id, save_id, batch_index),
  foreign key (user_id, save_id) references public.student_quiz_saves_v2 on delete cascade
);

alter table public.student_quiz_save_versions_v2 enable row level security;
alter table public.student_quiz_saves_v2 enable row level security;
alter table public.student_quiz_save_batches_v2 enable row level security;
revoke all on public.student_quiz_save_versions_v2, public.student_quiz_saves_v2,
  public.student_quiz_save_batches_v2 from public, anon, authenticated;
-- No client writes: RPCs alone enforce immutable batches and completion checks.
-- Read policies also isolate accounts if SELECT is granted later.
drop policy if exists "own save sessions" on public.student_quiz_saves_v2;
create policy "own save sessions" on public.student_quiz_saves_v2
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "own save batches" on public.student_quiz_save_batches_v2;
create policy "own save batches" on public.student_quiz_save_batches_v2
  for select to authenticated using (user_id = auth.uid());
-- Staging bodies are available only through owner-checking RPCs.

-- Track all question writers, including existing partial upserts/legacy RPCs.
-- Statement triggers bump once per affected quiz, not once per question.
create or replace function public.student_quiz_questions_version_v2()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare r record; source_sql text;
begin
  source_sql := case tg_op
    when 'INSERT' then 'select user_id, library_id, item_id from new_quiz_rows'
    when 'DELETE' then 'select user_id, library_id, item_id from old_quiz_rows'
    else 'select user_id, library_id, item_id from old_quiz_rows union select user_id, library_id, item_id from new_quiz_rows'
  end;
  for r in execute 'select distinct user_id, library_id, item_id from (' || source_sql || ') q order by user_id, library_id, item_id' loop
    if not exists(select 1 from auth.users where id=r.user_id) then continue;end if;
    insert into public.student_quiz_save_versions_v2 as v (user_id, library_id, item_id, revision)
    values (r.user_id, r.library_id, r.item_id, 1)
    on conflict (user_id, library_id, item_id) do update set revision = v.revision + 1;
  end loop;
  return null;
end;
$$;
revoke all on function public.student_quiz_questions_version_v2() from public, anon, authenticated;
drop trigger if exists student_quiz_version_insert_v2 on public.student_quiz_questions;
create trigger student_quiz_version_insert_v2 after insert on public.student_quiz_questions
  referencing new table as new_quiz_rows for each statement execute function public.student_quiz_questions_version_v2();
drop trigger if exists student_quiz_version_update_v2 on public.student_quiz_questions;
create trigger student_quiz_version_update_v2 after update on public.student_quiz_questions
  referencing old table as old_quiz_rows new table as new_quiz_rows for each statement execute function public.student_quiz_questions_version_v2();
drop trigger if exists student_quiz_version_delete_v2 on public.student_quiz_questions;
create trigger student_quiz_version_delete_v2 after delete on public.student_quiz_questions
  referencing old table as old_quiz_rows for each statement execute function public.student_quiz_questions_version_v2();

-- Track quiz settings/legacy question changes and deletion/recreation as well.
-- Favorites, titles and other unrelated item changes do not invalidate a save.
create or replace function public.student_quiz_item_version_v2()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare r record;
begin
  if tg_op = 'UPDATE' and new.user_id = old.user_id and new.library_id = old.library_id and new.id = old.id
     and new.payload->'quiz_settings' is not distinct from old.payload->'quiz_settings'
     and new.payload->'_student_questions' is not distinct from old.payload->'_student_questions'
     and new.payload->'_student_q_split' is not distinct from old.payload->'_student_q_split'
     and new.payload->'kind' is not distinct from old.payload->'kind' then return null; end if;
  -- Updating an item's key is not a normal app operation; cover both identities.
  for r in select distinct x.user_id, x.library_id, x.item_id from (
    select old.user_id::uuid as user_id, old.library_id::text as library_id, old.id::text as item_id
      where tg_op <> 'INSERT' and old.payload->>'kind' = 'quiz'
    union all
    select new.user_id::uuid, new.library_id::text, new.id::text
      where tg_op <> 'DELETE' and new.payload->>'kind' = 'quiz'
  ) x order by x.user_id, x.library_id, x.item_id loop
    if not exists(select 1 from auth.users where id=r.user_id) then continue;end if;
    insert into public.student_quiz_save_versions_v2 as v (user_id, library_id, item_id, revision)
    values (r.user_id, r.library_id, r.item_id, 1)
    on conflict (user_id, library_id, item_id) do update set revision = v.revision + 1;
  end loop;
  return null;
end;
$$;
revoke all on function public.student_quiz_item_version_v2() from public, anon, authenticated;
drop trigger if exists student_quiz_item_version_v2 on public.student_library_items;
create trigger student_quiz_item_version_v2 after insert or update or delete on public.student_library_items
  for each row execute function public.student_quiz_item_version_v2();

-- Serializes every content writer with version-consistent paginated reads.
create or replace function public.student_quiz_lock_v2(p_library text,p_item text,p_shared boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 if p_shared then perform pg_advisory_xact_lock_shared(hashtextextended(auth.uid()::text||':'||p_library||':'||p_item,0));
 else perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':'||p_library||':'||p_item,0));end if;
end $$;
revoke all on function public.student_quiz_lock_v2(text,text,boolean) from public,anon,authenticated;

create or replace function public.student_quiz_guard_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_table_name='student_library_items' then
  if (old.payload->>'kind'='quiz' or new.payload->>'kind'='quiz') and
    (old.payload->'quiz_settings' is distinct from new.payload->'quiz_settings' or
     old.payload->'_student_questions' is distinct from new.payload->'_student_questions' or
     old.payload->'_student_q_split' is distinct from new.payload->'_student_q_split') and
    coalesce(current_setting('ql.quiz_write_v2',true),'')<>'on' and current_setting('role',true)='authenticated' then
   raise exception 'QL_PROTOCOL: Please refresh the website before editing this quiz.';
  end if;
  return new;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function public.student_quiz_guard_v2() from public,anon,authenticated;
drop trigger if exists student_quiz_guard_v2 on public.student_library_items;
create trigger student_quiz_guard_v2 before update on public.student_library_items for each row execute function public.student_quiz_guard_v2();

create or replace function public.student_read_quiz_page_v2(p_library_id text,p_item_id text,p_offset integer default 0,p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare i public.student_library_items;v bigint;qs jsonb;n integer;
begin
 perform public.student_quiz_lock_v2(p_library_id,p_item_id,true);
 select * into i from public.student_library_items where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id;
 if not found or i.payload->>'kind'<>'quiz' then raise exception 'Quiz not found' using errcode='42501';end if;
 select coalesce((select revision from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id),0) into v;
 if p_revision is not null and p_revision<>v then raise exception 'QL_CONFLICT: Quiz changed while loading. Retry the complete read.';end if;
 if p_offset<0 then raise exception 'QL_INVALID: Invalid page';end if;
 if coalesce((i.payload->>'_student_q_split')::boolean,false) then
  select count(*) into n from public.student_quiz_questions where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id;
  select coalesce(jsonb_agg(data||jsonb_build_object('id',id,'question_position',position) order by position,id),'[]') into qs
   from (select id,position,data from public.student_quiz_questions where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id order by position,id limit 1000 offset p_offset) q;
 else
  n:=jsonb_array_length(case when jsonb_typeof(i.payload->'_student_questions')='array' then i.payload->'_student_questions' else '[]'::jsonb end);
  select coalesce(jsonb_agg(value order by ord),'[]') into qs from jsonb_array_elements(case when jsonb_typeof(i.payload->'_student_questions')='array' then i.payload->'_student_questions' else '[]'::jsonb end) with ordinality q(value,ord) where ord>p_offset and ord<=p_offset+1000;
 end if;
 return jsonb_build_object('revision',v,'item',to_jsonb(i),'questions',qs,'count',n);
end $$;
revoke all on function public.student_read_quiz_page_v2(text,text,integer,bigint) from public,anon;
grant execute on function public.student_read_quiz_page_v2(text,text,integer,bigint) to authenticated;

create or replace function public.student_quiz_receipt_v2(p_save_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.student_quiz_saves_v2;i public.student_library_items;v bigint;
begin
 select * into s from public.student_quiz_saves_v2 where user_id=auth.uid() and save_id=p_save_id;
 if not found then raise exception 'Save not found' using errcode='42501';end if;
 perform public.student_quiz_lock_v2(s.library_id,s.item_id);
 select * into i from public.student_library_items where user_id=auth.uid() and library_id::text=s.library_id and id::text=s.item_id;
 select revision into v from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=s.library_id and item_id=s.item_id;
 return jsonb_build_object('save_id',s.save_id,'committed_revision',s.committed_revision,'current_revision',v,'item',to_jsonb(i));
end $$;
revoke all on function public.student_quiz_receipt_v2(uuid) from public,anon,authenticated;

create index if not exists student_quiz_saves_global_expiry_v2 on public.student_quiz_saves_v2(expires_at);
create or replace function public.student_quiz_expire_v2()
returns void language sql security definer set search_path=pg_catalog as $$
 with expired as (select user_id,save_id from public.student_quiz_saves_v2 where expires_at<now() order by expires_at for update skip locked limit 200)
 delete from public.student_quiz_saves_v2 target using expired e where target.user_id=e.user_id and target.save_id=e.save_id;
$$;
revoke all on function public.student_quiz_expire_v2() from public,anon,authenticated;

create or replace function public.student_begin_quiz_save_v2(p_save_id uuid,p_library_id text,p_item_id text,p_question_count integer,p_settings jsonb,p_expected_revision bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s public.student_quiz_saves_v2;v bigint;
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':quiz-quota',0));
 perform public.student_quiz_lock_v2(p_library_id,p_item_id);
 perform public.student_quiz_expire_v2();
 if p_save_id is null or p_expected_revision is null or p_question_count is null or p_question_count<0 or p_question_count>100000 or jsonb_typeof(p_settings) is distinct from 'object' or octet_length(p_settings::text)>8388608 then raise exception 'QL_INVALID: Invalid quiz save or resource limit exceeded';end if;
 select * into s from public.student_quiz_saves_v2 where user_id=auth.uid() and save_id=p_save_id for update;
 if found then
  if s.library_id<>p_library_id or s.item_id<>p_item_id or s.question_count<>p_question_count or s.settings<>p_settings or s.base_revision<>p_expected_revision or s.mode<>'full' then raise exception 'QL_INVALID: Save ID reused for different content';end if;
  return;
 end if;
 if (select count(*) from public.student_quiz_saves_v2 where user_id=auth.uid() and result is null)>=8 then raise exception 'QL_LIMIT: Too many unfinished saves';end if;
 if not exists(select 1 from public.student_library_items where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id and payload->>'kind'='quiz') then raise exception 'Quiz not found' using errcode='42501';end if;
 insert into public.student_quiz_save_versions_v2(user_id,library_id,item_id) values(auth.uid(),p_library_id,p_item_id) on conflict do nothing;
 select revision into v from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id for update;
 if v<>p_expected_revision then raise exception 'QL_CONFLICT: Another save changed this quiz. Your draft is retained.';end if;
 insert into public.student_quiz_saves_v2(user_id,save_id,library_id,item_id,question_count,settings,base_revision) values(auth.uid(),p_save_id,p_library_id,p_item_id,p_question_count,p_settings,v);
end $$;
revoke all on function public.student_begin_quiz_save_v2(uuid,text,text,integer,jsonb,bigint) from public,anon;
grant execute on function public.student_begin_quiz_save_v2(uuid,text,text,integer,jsonb,bigint) to authenticated;

create or replace function public.student_stage_quiz_batch_v2(p_save_id uuid,p_batch_index integer,p_questions jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s public.student_quiz_saves_v2;b public.student_quiz_save_batches_v2;h text;n integer;
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':quiz-quota',0));
 select * into s from public.student_quiz_saves_v2 where user_id=auth.uid() and save_id=p_save_id for update;
 if not found then raise exception 'Save not found' using errcode='42501';end if;
 if s.expires_at<now() then raise exception 'QL_EXPIRED: Quiz save expired';end if;
 if s.mode<>'full' or p_batch_index is null or p_batch_index<0 or p_batch_index>=greatest(1,ceil(s.question_count::numeric/2000)::integer) or jsonb_typeof(p_questions) is distinct from 'array' then raise exception 'QL_INVALID: Invalid batch';end if;
 n:=least(2000,s.question_count-p_batch_index*2000);
 if jsonb_array_length(p_questions)<>n then raise exception 'QL_INVALID: Incomplete batch';end if;
 if octet_length(p_questions::text)>8388608 then raise exception 'QL_LIMIT: Batch exceeds 8 MB';end if;
 if exists(select 1 from jsonb_array_elements(p_questions) with ordinality q(value,ord) where jsonb_typeof(value)<>'object' or jsonb_typeof(value->'id') is distinct from 'string' or coalesce(value->>'id','')='' or value->'question_position' is distinct from to_jsonb(p_batch_index::bigint*2000+ord-1)) then raise exception 'QL_INVALID: Invalid question identity/order';end if;
 h:=encode(sha256(convert_to(p_questions::text,'UTF8')),'hex');
 select * into b from public.student_quiz_save_batches_v2 where user_id=auth.uid() and save_id=p_save_id and batch_index=p_batch_index;
 if found then if b.fingerprint<>h then raise exception 'QL_INVALID: Batch retry changed';end if;return;end if;
 if s.result is not null then raise exception 'QL_INVALID: Already completed';end if;
 if coalesce((select sum(octet_length(questions::text)) from public.student_quiz_save_batches_v2 where user_id=auth.uid()),0)+octet_length(p_questions::text)>67108864 then raise exception 'QL_LIMIT: Unfinished uploads exceed 64 MB';end if;
 insert into public.student_quiz_save_batches_v2(user_id,save_id,batch_index,questions,fingerprint) values(auth.uid(),p_save_id,p_batch_index,p_questions,h);
end $$;
revoke all on function public.student_stage_quiz_batch_v2(uuid,integer,jsonb) from public,anon;
grant execute on function public.student_stage_quiz_batch_v2(uuid,integer,jsonb) to authenticated;

create or replace function public.student_finalize_quiz_save_v2(p_save_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.student_quiz_saves_v2;v bigint;n bigint;d bigint;b integer;
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 select * into s from public.student_quiz_saves_v2 where user_id=auth.uid() and save_id=p_save_id;
 if not found then raise exception 'Save not found' using errcode='42501';end if;
 perform public.student_quiz_lock_v2(s.library_id,s.item_id);
 select * into s from public.student_quiz_saves_v2 where user_id=auth.uid() and save_id=p_save_id for update;
 if s.expires_at<now() then raise exception 'QL_EXPIRED: Save expired';end if;
 if s.result is not null then return public.student_quiz_receipt_v2(p_save_id);end if;
 if s.mode<>'full' then raise exception 'QL_INVALID: Not a full save';end if;
 select revision into v from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=s.library_id and item_id=s.item_id for update;
 if v<>s.base_revision then raise exception 'QL_CONFLICT: Quiz changed during saving. Draft retained.';end if;
 if not exists(select 1 from public.student_library_items where user_id=auth.uid() and library_id::text=s.library_id and id::text=s.item_id and payload->>'kind'='quiz') then raise exception 'Quiz not found' using errcode='42501';end if;
 select count(*) into b from public.student_quiz_save_batches_v2 where user_id=auth.uid() and save_id=p_save_id;
 select count(*),count(distinct value->>'id') into n,d from public.student_quiz_save_batches_v2 cross join lateral jsonb_array_elements(questions) q(value) where user_id=auth.uid() and save_id=p_save_id;
 if b<>greatest(1,ceil(s.question_count::numeric/2000)::integer) or n<>s.question_count or d<>n then raise exception 'QL_INVALID: Incomplete save or duplicate IDs';end if;
 perform set_config('ql.quiz_write_v2','on',true);
 delete from public.student_quiz_questions where user_id=auth.uid() and library_id=s.library_id and item_id=s.item_id;
 insert into public.student_quiz_questions(user_id,library_id,item_id,id,position,data,updated_at)
 select auth.uid(),s.library_id,s.item_id,value->>'id',(value->>'question_position')::integer,value,clock_timestamp() from public.student_quiz_save_batches_v2 cross join lateral jsonb_array_elements(questions) q(value) where user_id=auth.uid() and save_id=p_save_id;
 update public.student_library_items set payload=(payload-'_student_questions')||jsonb_build_object('quiz_settings',s.settings||jsonb_build_object('question_count',s.question_count),'_student_q_split',true,'updated_at',clock_timestamp()),personalized=true,updated_at=clock_timestamp() where user_id=auth.uid() and library_id::text=s.library_id and id::text=s.item_id;
 perform set_config('ql.quiz_write_v2','off',true);
 select revision into v from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=s.library_id and item_id=s.item_id;
 update public.student_quiz_saves_v2 set result='{"committed":true}',committed_revision=v where user_id=auth.uid() and save_id=p_save_id;
 update public.student_quiz_save_batches_v2 set questions=null where user_id=auth.uid() and save_id=p_save_id;
 return public.student_quiz_receipt_v2(p_save_id);
end $$;
revoke all on function public.student_finalize_quiz_save_v2(uuid) from public,anon;
grant execute on function public.student_finalize_quiz_save_v2(uuid) to authenticated;
-- Partial edits and settings use the SAME revision and transaction boundary.
create or replace function public.student_patch_quiz_v2(p_save_id uuid,p_library_id text,p_item_id text,p_changed jsonb,p_settings jsonb,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.student_quiz_saves_v2;v bigint;h text;n integer;affected integer;
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':quiz-quota',0));
 perform public.student_quiz_lock_v2(p_library_id,p_item_id);
 perform public.student_quiz_expire_v2();
 if p_save_id is null or p_expected_revision is null or jsonb_typeof(p_changed) is distinct from 'array' or jsonb_typeof(p_settings) is distinct from 'object' or octet_length(p_changed::text)+octet_length(p_settings::text)>8388608 then raise exception 'QL_INVALID: Invalid partial save';end if;
 h:=encode(sha256(convert_to(jsonb_build_array(p_changed,p_settings,p_expected_revision)::text,'UTF8')),'hex');
 select * into s from public.student_quiz_saves_v2 where user_id=auth.uid() and save_id=p_save_id for update;
 if found then
  if s.mode<>'partial' or s.library_id<>p_library_id or s.item_id<>p_item_id or s.content_hash<>h then raise exception 'QL_INVALID: Save ID reused';end if;
  if s.expires_at<now() then raise exception 'QL_EXPIRED: Save expired';end if;
  return public.student_quiz_receipt_v2(p_save_id);
 end if;
 if not exists(select 1 from public.student_library_items where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id and payload->>'kind'='quiz' and payload->>'_student_q_split'='true') then raise exception 'QL_INVALID: Split quiz not found';end if;
 select revision into v from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id for update;
 if v is distinct from p_expected_revision then raise exception 'QL_CONFLICT: Quiz changed. Draft retained.';end if;
 select count(*) into n from public.student_quiz_questions where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_changed))<>jsonb_array_length(p_changed) or exists(select 1 from jsonb_array_elements(p_changed) q(value) where not exists(select 1 from public.student_quiz_questions where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id and id=q.value->>'id') or jsonb_typeof(value->'position') is distinct from 'number' or (value->>'position')::numeric<>trunc((value->>'position')::numeric) or (value->>'position')::integer<0 or (value->>'position')::integer>=n) then raise exception 'QL_CONFLICT: A question was removed or its position changed';end if;
 insert into public.student_quiz_saves_v2(user_id,save_id,library_id,item_id,question_count,settings,base_revision,mode,content_hash) values(auth.uid(),p_save_id,p_library_id,p_item_id,n,p_settings,v,'partial',h);
 perform set_config('ql.quiz_write_v2','on',true);
 update public.student_quiz_questions t set data=t.data||(q.value-'position')||jsonb_build_object('question_position',(q.value->>'position')::integer),position=(q.value->>'position')::integer,updated_at=clock_timestamp() from jsonb_array_elements(p_changed) q(value) where t.user_id=auth.uid() and t.library_id=p_library_id and t.item_id=p_item_id and t.id=q.value->>'id';
 if (select count(distinct position) from public.student_quiz_questions where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id)<>n then raise exception 'QL_INVALID: Question positions are incomplete';end if;
 update public.student_library_items set payload=payload||jsonb_build_object('quiz_settings',p_settings||jsonb_build_object('question_count',n),'updated_at',clock_timestamp()),personalized=true,updated_at=clock_timestamp() where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id;
 perform set_config('ql.quiz_write_v2','off',true);
 select revision into v from public.student_quiz_save_versions_v2 where user_id=auth.uid() and library_id=p_library_id and item_id=p_item_id;
 update public.student_quiz_saves_v2 set result='{"committed":true}',committed_revision=v where user_id=auth.uid() and save_id=p_save_id;
 return public.student_quiz_receipt_v2(p_save_id);
end $$;
revoke all on function public.student_patch_quiz_v2(uuid,text,text,jsonb,jsonb,bigint) from public,anon;
grant execute on function public.student_patch_quiz_v2(uuid,text,text,jsonb,jsonb,bigint) to authenticated;

-- Narrow metadata patches merge with CURRENT data, never a stale full payload.
create or replace function public.student_patch_item_v2(p_library_id text,p_item_id text,p_patch jsonb,p_personalize boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare i public.student_library_items;
begin
 perform public.student_quiz_lock_v2(p_library_id,p_item_id);
 if jsonb_typeof(p_patch) is distinct from 'object' or p_patch ?| array['id','library_id','user_id','quiz_settings','_student_questions','_student_q_split','kind'] then raise exception 'QL_INVALID: Protected quiz fields require the quiz-save protocol';end if;
 select * into i from public.student_library_items where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id for update;
 if not found then raise exception 'Item not found' using errcode='42501';end if;
 update public.student_library_items set payload=payload||p_patch||jsonb_build_object('updated_at',clock_timestamp()),personalized=personalized or p_personalize,updated_at=clock_timestamp() where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id returning * into i;
 return to_jsonb(i);
end $$;
revoke all on function public.student_patch_item_v2(text,text,jsonb,boolean) from public,anon;
grant execute on function public.student_patch_item_v2(text,text,jsonb,boolean) to authenticated;

-- Shared-source reconciliation refuses a delayed update once the student edits.
create or replace function public.student_reconcile_item_v2(p_library_id text,p_item_id text,p_payload jsonb,p_source_updated_at text,p_expected_source text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare i public.student_library_items;r public.student_library_items;
begin
 perform public.student_quiz_lock_v2(p_library_id,p_item_id);
 select * into i from public.student_library_items where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id for update;
 if not found then raise exception 'Item not found' using errcode='42501';end if;
 r:=jsonb_populate_record(i,jsonb_build_object('source_updated_at',p_expected_source));
 if i.personalized or i.source_updated_at is distinct from r.source_updated_at then return to_jsonb(i);end if;
 r:=jsonb_populate_record(i,jsonb_build_object('source_updated_at',p_source_updated_at));
 if p_source_updated_at is not null and i.source_updated_at is not null and p_source_updated_at::timestamptz<i.source_updated_at::text::timestamptz then return to_jsonb(i);end if;
 perform set_config('ql.quiz_write_v2','on',true);
 update public.student_library_items set payload=(p_payload-'student_favorite'-'_student_attempts')||jsonb_build_object('student_favorite',coalesce(i.payload->'student_favorite','false'::jsonb),'_student_attempts',coalesce(i.payload->'_student_attempts','[]'::jsonb)),source_updated_at=r.source_updated_at,updated_at=clock_timestamp() where user_id=auth.uid() and library_id::text=p_library_id and id::text=p_item_id returning * into i;
 perform set_config('ql.quiz_write_v2','off',true);return to_jsonb(i);
end $$;
revoke all on function public.student_reconcile_item_v2(text,text,jsonb,text,text) from public,anon;
grant execute on function public.student_reconcile_item_v2(text,text,jsonb,text,text) to authenticated;

-- Keep permanent deletion working after withdrawing direct question writes.
create or replace function public.student_quiz_cleanup()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 delete from public.student_quiz_questions where user_id=old.user_id::uuid and library_id=old.library_id::text and item_id=old.id::text;
 delete from public.student_quiz_attempts where user_id=old.user_id::uuid and library_id=old.library_id::text and item_id=old.id::text;
 delete from public.student_quiz_saves_v2 where user_id=old.user_id::uuid and library_id=old.library_id::text and item_id=old.id::text;
 return old;
end $$;
revoke all on function public.student_quiz_cleanup() from public,anon,authenticated;
-- TRUNCATE bypasses RLS and row/version triggers; client roles never need it.
revoke truncate on public.student_library_items,public.student_quiz_questions from public,anon,authenticated;
revoke insert,update,delete on public.student_quiz_questions from authenticated;
revoke all on function public.student_replace_quiz_questions(text,text,jsonb,boolean) from public,anon,authenticated;
do $$begin
 if to_regprocedure('public.student_patch_quiz_questions(text,text,jsonb,jsonb)') is not null then
  revoke all on function public.student_patch_quiz_questions(text,text,jsonb,jsonb) from public,anon,authenticated;
 end if;
end $$;

-- Server sharing restrictions and resumable Dashboard posts. Local migration.
-- Requires plans_admin.sql, item_sharing.sql, dashboard.sql and external quiz sharing.
-- The existing daily post limit filters by owner/date. The supplied schema
-- has only a status/date index; avoid scanning every student's posts here.
create index if not exists ql_dash_posts_owner_created_v2 on public.ql_dash_posts(owner_id,created_at);
create or replace function public.ql_send_item_share(
  p_recipient_share_id text, p_kind text, p_title text, p_item_count integer, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_to jsonb;
  v_me jsonb;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.ql__feature_ok(v_uid, 'item_share_in') then raise exception 'Sharing is disabled for this account.' using errcode='42501';end if;
  if exists(select 1 from public.ql_subscriptions where user_id=v_uid and status='suspended') then raise exception 'Account suspended' using errcode='42501';end if;
  if p_kind not in ('pdf', 'link', 'folder', 'quiz') then
    raise exception 'This item cannot be shared';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'missing share content';
  end if;
  v_to := public.ql__share_profile(p_recipient_share_id, null);
  if v_to is null or v_to->>'__uid' is null then
    raise exception 'No student was found with that Quiz ID.';
  end if;
  v_me := public.ql__share_profile(null, v_uid);
  insert into public.ql_item_shares (sender_id, recipient_id, kind, title, item_count, sender_name, sender_share_id, payload)
  values (v_uid, (v_to->>'__uid')::uuid, p_kind, left(coalesce(p_title, ''), 200), greatest(coalesce(p_item_count, 1), 1),
          left(coalesce(v_me->>'display_name', ''), 120), v_me->>'share_id', p_payload)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_send_item_share(text, text, text, integer, jsonb) from public, anon;
grant execute on function public.ql_send_item_share(text, text, text, integer, jsonb) to authenticated;

create or replace function public.ql_create_external_item_share(p_kind text, p_title text, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.ql__feature_ok(v_uid, 'item_share_ex') then raise exception 'Sharing is disabled for this account.' using errcode='42501';end if;
  if exists(select 1 from public.ql_subscriptions where user_id=v_uid and status='suspended') then raise exception 'Account suspended' using errcode='42501';end if;
  if p_kind not in ('pdf', 'link', 'folder') then
    raise exception 'This item cannot be shared externally';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'missing share content';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  insert into public.ql_external_item_shares (token, owner_id, kind, title, payload)
  values (v_token, v_uid, p_kind, left(coalesce(p_title, ''), 200), p_payload);
  return v_token;
end;
$$;
revoke all on function public.ql_create_external_item_share(text, text, jsonb) from public, anon;
grant execute on function public.ql_create_external_item_share(text, text, jsonb) to authenticated;

create table if not exists public.ql_dash_uploads_v2(
 owner_id uuid not null references auth.users(id) on delete cascade,
 operation_id uuid not null,kind text not null,title text not null,item_count integer not null,
 parts integer not null,content_hash text not null,post_id uuid,
 expires_at timestamptz not null default now()+interval '24 hours',primary key(owner_id,operation_id)
);
create table if not exists public.ql_dash_upload_parts_v2(
 owner_id uuid not null,operation_id uuid not null,part integer not null,body bytea not null,
 primary key(owner_id,operation_id,part),foreign key(owner_id,operation_id) references public.ql_dash_uploads_v2 on delete cascade
);
create table if not exists public.ql_dash_quiz_preparations_v2(
 owner_id uuid not null references auth.users(id) on delete cascade,operation_id uuid not null,item_id text not null,
 fingerprint text not null,result jsonb not null,expires_at timestamptz not null default now()+interval '24 hours',
 primary key(owner_id,operation_id,item_id)
);
alter table public.ql_dash_uploads_v2 enable row level security;
alter table public.ql_dash_upload_parts_v2 enable row level security;
alter table public.ql_dash_quiz_preparations_v2 enable row level security;
revoke all on public.ql_dash_uploads_v2,public.ql_dash_upload_parts_v2,public.ql_dash_quiz_preparations_v2 from public,anon,authenticated;
create index if not exists ql_dash_upload_expiry_v2 on public.ql_dash_uploads_v2(expires_at);
create index if not exists ql_dash_preparation_expiry_v2 on public.ql_dash_quiz_preparations_v2(expires_at);
create or replace function public.ql_dash_check_v2()
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 if not public.ql__feature_ok(auth.uid(),'item_share_dash') or exists(select 1 from public.ql_subscriptions where user_id=auth.uid() and status='suspended') then raise exception 'Posting is disabled for this account' using errcode='42501';end if;
end $$;
revoke all on function public.ql_dash_check_v2() from public,anon,authenticated;

-- One quiz share per operation+quiz, INCLUDING retries after a lost response.
create or replace function public.ql_prepare_dash_quiz_v2(p_operation_id uuid,p_library_id text,p_item_id text,p_title text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;old public.ql_dash_quiz_preparations_v2;r jsonb;
begin
 perform public.ql_dash_check_v2();
 if p_operation_id is null or p_item_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>33554432 then raise exception 'QL_LIMIT: Invalid or oversized quiz preparation';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':dash:'||p_operation_id||':'||p_item_id,0));
 h:=encode(sha256(convert_to(jsonb_build_array(p_library_id,p_title,p_payload)::text,'UTF8')),'hex');
 select * into old from public.ql_dash_quiz_preparations_v2 where owner_id=auth.uid() and operation_id=p_operation_id and item_id=p_item_id;
 if found then if old.fingerprint<>h then raise exception 'QL_CONFLICT: Prepared quiz changed. Start a new posting operation.';end if;return old.result;end if;
 -- Exact deployed text/text/text/text/jsonb signature and TABLE return,
 -- verified against the user's read-only schema export on 2026-10-19.
 select to_jsonb(result) into strict r from public.ql_create_external_quiz_share(
  p_library_id,p_item_id,p_title,'guest'::text,p_payload) result;
 if coalesce(r->>'share_token',r->>'token') is null then raise exception 'QL_PROTOCOL: Unsupported external sharing result';end if;
 insert into public.ql_dash_quiz_preparations_v2(owner_id,operation_id,item_id,fingerprint,result) values(auth.uid(),p_operation_id,p_item_id,h,r);
 return r;
end $$;
revoke all on function public.ql_prepare_dash_quiz_v2(uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.ql_prepare_dash_quiz_v2(uuid,text,text,text,jsonb) to authenticated;

create or replace function public.ql_begin_dash_upload_v2(p_operation_id uuid,p_kind text,p_title text,p_item_count integer,p_parts integer,p_content_hash text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare s public.ql_dash_uploads_v2;
begin
 perform public.ql_dash_check_v2();
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':dash-quota',0));
 with expired as(select owner_id,operation_id from public.ql_dash_uploads_v2 where expires_at<now() for update skip locked limit 100) delete from public.ql_dash_uploads_v2 target using expired e where target.owner_id=e.owner_id and target.operation_id=e.operation_id;
 with expired_preparations as(select owner_id,operation_id,item_id from public.ql_dash_quiz_preparations_v2 where expires_at<now() for update skip locked limit 200) delete from public.ql_dash_quiz_preparations_v2 target using expired_preparations e where target.owner_id=e.owner_id and target.operation_id=e.operation_id and target.item_id=e.item_id;
 if p_operation_id is null or p_kind not in ('folder','quiz','pdf','link') or p_item_count<1 or p_item_count>100000 or p_parts<1 or p_parts>1024 or p_content_hash !~ '^[a-f0-9]{64}$' then raise exception 'QL_INVALID: Invalid Dashboard upload';end if;
 select * into s from public.ql_dash_uploads_v2 where owner_id=auth.uid() and operation_id=p_operation_id for update;
 if found then
  if s.kind<>p_kind or s.title<>p_title or s.item_count<>p_item_count or s.parts<>p_parts or s.content_hash<>p_content_hash then raise exception 'QL_CONFLICT: Posting operation changed';end if;
  return s.post_id;
 end if;
 if (select count(*) from public.ql_dash_uploads_v2 where owner_id=auth.uid() and post_id is null)>=8 then raise exception 'QL_LIMIT: Too many unfinished Dashboard posts';end if;
 insert into public.ql_dash_uploads_v2(owner_id,operation_id,kind,title,item_count,parts,content_hash) values(auth.uid(),p_operation_id,p_kind,p_title,p_item_count,p_parts,p_content_hash);
 return null;
end $$;
revoke all on function public.ql_begin_dash_upload_v2(uuid,text,text,integer,integer,text) from public,anon;
grant execute on function public.ql_begin_dash_upload_v2(uuid,text,text,integer,integer,text) to authenticated;
create or replace function public.ql_stage_dash_upload_v2(p_operation_id uuid,p_part integer,p_base64 text)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s public.ql_dash_uploads_v2;b bytea;old bytea;
begin
 perform public.ql_dash_check_v2();
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':dash-quota',0));
 select * into s from public.ql_dash_uploads_v2 where owner_id=auth.uid() and operation_id=p_operation_id for update;
 if not found then raise exception 'Upload not found' using errcode='42501';end if;
 if s.expires_at<now() then raise exception 'QL_EXPIRED: Posting upload expired';end if;
 if s.post_id is not null then return;end if;
 if p_part<0 or p_part>=s.parts or p_base64 is null or octet_length(p_base64)>90000 then raise exception 'QL_INVALID: Invalid upload part';end if;
 b:=decode(p_base64,'base64');if octet_length(b)>65536 then raise exception 'QL_LIMIT: Upload part too large';end if;
 select body into old from public.ql_dash_upload_parts_v2 where owner_id=auth.uid() and operation_id=p_operation_id and part=p_part;
 if found then if old<>b then raise exception 'QL_INVALID: Upload retry changed';end if;return;end if;
 if coalesce((select sum(octet_length(body)) from public.ql_dash_upload_parts_v2 where owner_id=auth.uid()),0)+octet_length(b)>67108864 then raise exception 'QL_LIMIT: Pending posts exceed 64 MB';end if;
 insert into public.ql_dash_upload_parts_v2 values(auth.uid(),p_operation_id,p_part,b);
end $$;
revoke all on function public.ql_stage_dash_upload_v2(uuid,integer,text) from public,anon;
grant execute on function public.ql_stage_dash_upload_v2(uuid,integer,text) to authenticated;
create or replace function public.ql_finalize_dash_upload_v2(p_operation_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare s public.ql_dash_uploads_v2;b bytea;p jsonb;n integer;post uuid;
begin
 perform public.ql_dash_check_v2();
 select * into s from public.ql_dash_uploads_v2 where owner_id=auth.uid() and operation_id=p_operation_id for update;
 if not found then raise exception 'Upload not found' using errcode='42501';end if;
 if s.expires_at<now() then raise exception 'QL_EXPIRED: Posting upload expired';end if;
 if s.post_id is not null then return s.post_id;end if;
 select string_agg(body,''::bytea order by part),count(*) into b,n from public.ql_dash_upload_parts_v2 where owner_id=auth.uid() and operation_id=p_operation_id;
 if n<>s.parts or encode(sha256(b),'hex')<>s.content_hash then raise exception 'QL_INVALID: Incomplete Dashboard upload';end if;
 p:=convert_from(b,'UTF8')::jsonb;
 if jsonb_typeof(p->'nodes') is distinct from 'array' or jsonb_array_length(p->'nodes')<>s.item_count or p->>'kind' is distinct from s.kind then raise exception 'QL_INVALID: Invalid Dashboard content';end if;
 post:=public.ql_dash_post(s.kind,s.title,s.item_count,p);
 update public.ql_dash_uploads_v2 set post_id=post where owner_id=auth.uid() and operation_id=p_operation_id;
 delete from public.ql_dash_upload_parts_v2 where owner_id=auth.uid() and operation_id=p_operation_id;
 return post;
end $$;
revoke all on function public.ql_finalize_dash_upload_v2(uuid) from public,anon;
grant execute on function public.ql_finalize_dash_upload_v2(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
select 'Reliability database update complete' as result;
