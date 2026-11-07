-- Run after dashboard_quiz_access_v1.sql. Fast feedback on the device;
-- the existing submit RPC still grades and saves the final result server-side.
begin;
create or replace function public.ql_dash_quiz_get_fast_v1(
  p_post_id uuid,p_quiz_ref text
)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp as $$
declare n jsonb; prefs jsonb;
begin
  n:=public.ql__dash_quiz_node_v1(p_post_id,p_quiz_ref);
  select settings into prefs
    from public.ql_dash_quiz_preferences_v1
    where user_id=auth.uid()
      and post_id=p_post_id and quiz_ref=p_quiz_ref;
  return jsonb_build_object(
    'title',n->>'title',
    'revision',md5(n::text),
    'feedback_mode','local',
    'settings',coalesce(n->'quiz_settings','{}'::jsonb)
      ||coalesce(prefs,'{}'::jsonb),
    'questions',n->'questions'
  );
end $$;
revoke all on function public.ql_dash_quiz_get_fast_v1(uuid,text)
  from public,anon;
grant execute on function public.ql_dash_quiz_get_fast_v1(uuid,text)
  to authenticated;
notify pgrst,'reload schema';
commit;
select 'Dashboard instant feedback update complete' as result;
