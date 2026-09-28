-- Quiz Library — store each student quiz question (and each quiz result) as
-- its own small row instead of inside one giant My Library row.
--
-- Run this once in Supabase → SQL Editor. It is safe to run again.
--
-- Why: a student's quiz used to live inside ONE student_library_items row
-- (payload._student_questions + payload._student_attempts). With 10,000
-- questions, changing one letter made Postgres rewrite that whole multi-MB
-- value (slow, hits the statement timeout, burns Disk IO), and every library
-- load downloaded every question of every quiz. After this script:
--   * editing a question updates one small row,
--   * the library list no longer carries any questions,
--   * a finished quiz adds one result row.
--
-- What it does to existing data:
--   1. Creates student_quiz_questions and student_quiz_attempts (row-level
--      security: each account can only see and change its own rows).
--   2. Copies every existing quiz payload into student_quiz_payload_backup
--      (untouched original, readable only from the dashboard).
--   3. Copies questions and results into the new tables.
--   4. Removes the big arrays from the My Library rows and marks those quizzes
--      as "_student_q_split": true so the app reads them from the new table.
-- Nothing is deleted without a backup copy first.

begin;

-- ---------------------------------------------------------------- tables --

create table if not exists public.student_quiz_questions (
  user_id    uuid        not null default auth.uid(),
  library_id text        not null,
  item_id    text        not null,
  id         text        not null,
  position   integer     not null default 0,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, library_id, item_id, id)
);
create index if not exists student_quiz_questions_order
  on public.student_quiz_questions (user_id, library_id, item_id, position);

create table if not exists public.student_quiz_attempts (
  user_id      uuid        not null default auth.uid(),
  library_id   text        not null,
  item_id      text        not null,
  id           text        not null,
  submitted_at timestamptz not null default now(),
  data         jsonb       not null default '{}'::jsonb,
  primary key (user_id, library_id, id)
);
create index if not exists student_quiz_attempts_by_item
  on public.student_quiz_attempts (user_id, library_id, item_id, submitted_at desc);

-- Original payloads, kept as a safety copy. RLS on with no policies = only
-- the dashboard / service role can read it; the app never downloads it.
create table if not exists public.student_quiz_payload_backup (
  user_id      uuid        not null,
  library_id   text        not null,
  item_id      text        not null,
  payload      jsonb       not null,
  backed_up_at timestamptz not null default now(),
  primary key (user_id, library_id, item_id)
);

alter table public.student_quiz_questions      enable row level security;
alter table public.student_quiz_attempts       enable row level security;
alter table public.student_quiz_payload_backup enable row level security;

drop policy if exists "own quiz questions" on public.student_quiz_questions;
create policy "own quiz questions" on public.student_quiz_questions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own quiz attempts" on public.student_quiz_attempts;
create policy "own quiz attempts" on public.student_quiz_attempts
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.student_quiz_questions to authenticated;
grant select, insert, update, delete on public.student_quiz_attempts  to authenticated;
revoke all on public.student_quiz_payload_backup from anon, authenticated;

-- ------------------------------------------------------------- functions --

-- Replace (p_reset = true) or append to a quiz's question rows in one call.
-- The app sends large quizzes in chunks: first chunk resets, the rest append.
create or replace function public.student_replace_quiz_questions(
  p_library_id text,
  p_item_id    text,
  p_questions  jsonb,
  p_reset      boolean default true
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_reset then
    delete from student_quiz_questions
     where user_id = v_uid and library_id = p_library_id and item_id = p_item_id;
  end if;
  insert into student_quiz_questions (user_id, library_id, item_id, id, position, data, updated_at)
  select v_uid, p_library_id, p_item_id,
         q.value ->> 'id',
         coalesce(floor((q.value ->> 'question_position')::numeric)::int, (q.ord - 1)::int),
         q.value,
         now()
    from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) with ordinality as q(value, ord)
   where coalesce(q.value ->> 'id', '') <> ''
  on conflict (user_id, library_id, item_id, id) do update
     set position = excluded.position, data = excluded.data, updated_at = excluded.updated_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.student_replace_quiz_questions(text, text, jsonb, boolean) from public, anon;
grant execute on function public.student_replace_quiz_questions(text, text, jsonb, boolean) to authenticated;

-- When a My Library item is deleted (Trash → delete forever, or a shared quiz
-- disappearing), remove its question and result rows too.
create or replace function public.student_quiz_cleanup()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from student_quiz_questions
   where user_id = old.user_id::uuid and library_id = old.library_id::text and item_id = old.id::text;
  delete from student_quiz_attempts
   where user_id = old.user_id::uuid and library_id = old.library_id::text and item_id = old.id::text;
  return old;
end;
$$;
drop trigger if exists student_quiz_cleanup on public.student_library_items;
create trigger student_quiz_cleanup
  after delete on public.student_library_items
  for each row execute function public.student_quiz_cleanup();

-- Tolerant timestamp parser for old results.
create or replace function public.student_quiz_safe_ts(p text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  return p::timestamptz;
exception when others then
  return null;
end;
$$;

-- ------------------------------------------------------ move existing data --

-- 1. Safety copy of every payload that still carries questions or results.
insert into public.student_quiz_payload_backup (user_id, library_id, item_id, payload)
select s.user_id::uuid, s.library_id::text, s.id::text, s.payload
  from public.student_library_items s
 where jsonb_typeof(s.payload -> '_student_questions') = 'array'
    or jsonb_typeof(s.payload -> '_student_attempts')  = 'array'
on conflict (user_id, library_id, item_id) do nothing;

-- 2. Questions → one row each.
insert into public.student_quiz_questions (user_id, library_id, item_id, id, position, data)
select s.user_id::uuid, s.library_id::text, s.id::text,
       coalesce(nullif(q.value ->> 'id', ''), 'legacy-' || q.ord),
       coalesce(floor((q.value ->> 'question_position')::numeric)::int, (q.ord - 1)::int),
       q.value || jsonb_build_object('id', coalesce(nullif(q.value ->> 'id', ''), 'legacy-' || q.ord))
  from public.student_library_items s
 cross join lateral jsonb_array_elements(s.payload -> '_student_questions') with ordinality as q(value, ord)
 where jsonb_typeof(s.payload -> '_student_questions') = 'array'
on conflict (user_id, library_id, item_id, id) do nothing;

-- 3. Results → one row each.
insert into public.student_quiz_attempts (user_id, library_id, item_id, id, submitted_at, data)
select s.user_id::uuid, s.library_id::text, s.id::text,
       coalesce(nullif(a.value ->> 'id', ''), md5(s.id::text || ':' || a.ord)),
       coalesce(public.student_quiz_safe_ts(a.value ->> 'submitted_at'), now()),
       a.value
  from public.student_library_items s
 cross join lateral jsonb_array_elements(s.payload -> '_student_attempts') with ordinality as a(value, ord)
 where jsonb_typeof(s.payload -> '_student_attempts') = 'array'
on conflict (user_id, library_id, id) do nothing;

-- 4. Slim the My Library rows down.
update public.student_library_items s
   set payload = (s.payload - '_student_questions' - '_student_attempts')
                 || case when jsonb_typeof(s.payload -> '_student_questions') = 'array'
                         then jsonb_build_object('_student_q_split', true)
                         else '{}'::jsonb end
 where jsonb_typeof(s.payload -> '_student_questions') = 'array'
    or jsonb_typeof(s.payload -> '_student_attempts')  = 'array';

commit;

-- Make the new tables and functions visible to the API right away.
notify pgrst, 'reload schema';
