-- Function definition supplied by the user's read-only schema export, 2026-10-19.
-- For disposable local tests only. The supporting table fixture is synthetic;
-- its full deployed constraints/triggers still require confirmation.
CREATE OR REPLACE FUNCTION public.ql_create_external_quiz_share(p_library_id text, p_source_item_id text, p_quiz_title text, p_identity_mode text, p_payload jsonb)
 RETURNS TABLE(share_token text, identity_mode text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  v_row public.quiz_external_shares;
begin
  if v_user is null then raise exception 'Sign in before sharing a quiz.'; end if;
  if p_identity_mode not in ('guest','name') then raise exception 'Invalid student identification mode.'; end if;
  if coalesce(jsonb_typeof(p_payload->'questions'),'') <> 'array' then raise exception 'Quiz share payload has no questions.'; end if;

  insert into public.quiz_external_shares(library_id,source_item_id,owner_user_id,quiz_title,identity_mode,payload)
  values (p_library_id,p_source_item_id,v_user,coalesce(nullif(btrim(p_quiz_title),''),'Quiz'),p_identity_mode,p_payload)
  returning * into v_row;

  return query select v_row.share_token::text, v_row.identity_mode, v_row.created_at;
end;
$function$;
