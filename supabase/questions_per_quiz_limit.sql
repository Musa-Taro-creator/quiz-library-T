-- Quiz Library — the plan's "questions per quiz" limit, checked by the database.
--
-- Before, only the website checked it, so it could be skipped by calling Supabase
-- directly. Every quiz save (full save and partial edit) ends by writing the new
-- question count into the quiz (payload.quiz_settings.question_count) in the same
-- transaction, so checking that one value covers every save path: a refused save
-- changes nothing, and the student's draft stays on the device.
--
-- Same rule as the website: a save is refused only when it ADDS questions beyond the
-- plan's limit. Editing a quiz that is already bigger (made before the limit, or on a
-- bigger plan) still works as long as it does not get bigger. Empty limit = unlimited.
--
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.

create or replace function public.ql__quiz_question_count(p jsonb)
returns integer language sql immutable set search_path = public as $$
  select case
    when (p->'quiz_settings'->>'question_count') ~ '^[0-9]+$' then (p->'quiz_settings'->>'question_count')::int
    when jsonb_typeof(p->'_student_questions') = 'array' then jsonb_array_length(p->'_student_questions')
    else 0 end;
$$;
revoke all on function public.ql__quiz_question_count(jsonb) from public, anon, authenticated;

create or replace function public.ql__check_question_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_lim text; v_new integer; v_old integer := 0;
begin
  if new.payload->>'kind' is distinct from 'quiz' then return new; end if;
  -- copies of the admin's shared library (personalized = false) are never limited
  if not coalesce(new.personalized, false) then return new; end if;
  v_new := ql__quiz_question_count(new.payload);
  if tg_op = 'UPDATE' then
    -- an edit keeps what the quiz already had (also when a shared copy becomes the student's own)
    if old.payload->>'kind' = 'quiz' then v_old := ql__quiz_question_count(old.payload); end if;
  elsif exists (select 1 from student_library_items where user_id = new.user_id and library_id = new.library_id and id = new.id) then
    return new;   -- an upsert of an existing quiz: its UPDATE is checked
  end if;
  if v_new <= v_old then return new; end if;   -- not adding questions
  select limits->>'questions_per_quiz' into v_lim from ql_plans where id = ql__effective_plan(new.user_id);
  if v_lim ~ '^[0-9]+$' and v_new > v_lim::int then
    raise exception 'plan_limit:questions_per_quiz';
  end if;
  return new;
end;
$$;
revoke all on function public.ql__check_question_limit() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.student_library_items') is not null then
    execute 'drop trigger if exists ql_question_limit on public.student_library_items';
    execute 'create trigger ql_question_limit before insert or update on public.student_library_items for each row execute function public.ql__check_question_limit()';
  end if;
end $$;

notify pgrst, 'reload schema';
