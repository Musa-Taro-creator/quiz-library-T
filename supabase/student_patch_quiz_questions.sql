-- Quiz Library — send only the changed questions when a student edits a quiz.
--
-- Run this once in Supabase → SQL Editor (safe to run again).
--
-- Why: a student's quiz lives inside one row of student_library_items
-- (payload._student_questions). Without this function, fixing one typo in a
-- 10,000-question quiz re-uploads all 10,000 questions. With it, the app sends
-- only the questions that changed and this function swaps them into the stored
-- copy in place.
--
-- Security: SECURITY INVOKER, so the table's existing row-level security still
-- applies, and it only ever touches the calling user's own row (auth.uid()).

create or replace function public.student_patch_quiz_questions(
  p_library_id text,
  p_item_id    text,
  p_changed    jsonb,   -- [{ id, position, ...question fields }, ...]
  p_settings   jsonb
) returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update public.student_library_items s
  set payload = jsonb_set(
        jsonb_set(
          s.payload,
          '{_student_questions}',
          (
            select coalesce(
              jsonb_agg(
                case when c.value is null then q.value
                     else q.value || (c.value - 'position')
                          || jsonb_build_object('question_position', c.value -> 'position')
                end
                order by coalesce((c.value ->> 'position')::int,
                                  (q.value ->> 'question_position')::int,
                                  q.ord::int)
              ),
              '[]'::jsonb)
            from jsonb_array_elements(s.payload -> '_student_questions') with ordinality as q(value, ord)
            left join jsonb_array_elements(coalesce(p_changed, '[]'::jsonb)) as c(value)
              on c.value ->> 'id' = q.value ->> 'id'
          )
        ),
        '{quiz_settings}',
        coalesce(p_settings, s.payload -> 'quiz_settings', '{}'::jsonb)
      ) || jsonb_build_object('updated_at', to_jsonb(v_now)),
      personalized = true,
      updated_at   = v_now
  where s.user_id::text    = auth.uid()::text
    and s.library_id::text = p_library_id
    and s.id::text         = p_item_id
    and jsonb_typeof(s.payload -> '_student_questions') = 'array';

  get diagnostics v_count = row_count;
  if v_count = 0 then
    -- The app falls back to a full save when it sees this.
    raise exception 'quiz copy not found for this account' using errcode = 'P0002';
  end if;

  return v_now;
end;
$$;

revoke all on function public.student_patch_quiz_questions(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.student_patch_quiz_questions(text, text, jsonb, jsonb) to authenticated;

-- Make the new function visible to the API right away.
notify pgrst, 'reload schema';
