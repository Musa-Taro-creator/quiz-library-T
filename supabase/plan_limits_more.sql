-- Quiz Library — plan limits for quiz links and folders too.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.
-- Each plan can now limit: quizzes, PDFs, quiz links, folders (and storage).
-- Empty = unlimited.

create or replace function public.ql__check_item_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_lim jsonb;
  v_use jsonb;
  v_kind text := new.payload->>'kind';
  v_key text;
  v_extra integer;
begin
  if not coalesce(new.personalized, false) or v_kind not in ('quiz', 'pdf', 'link', 'folder') then return new; end if;
  if exists (select 1 from student_library_items where user_id = new.user_id and library_id = new.library_id and id = new.id) then
    return new;   -- an edit of an existing item, not a new one
  end if;
  if exists (select 1 from ql_subscriptions where user_id = new.user_id and status = 'suspended') then
    raise exception 'plan_limit:suspended';
  end if;
  select limits into v_lim from ql_plans where id = ql__effective_plan(new.user_id);
  if v_lim is null then return new; end if;
  v_use := ql__usage(new.user_id);
  v_key := case v_kind when 'quiz' then 'quizzes' when 'pdf' then 'pdfs' when 'link' then 'links' else 'folders' end;
  if (v_lim->>v_key) ~ '^[0-9]+$' and coalesce((v_use->>v_key)::int, 0) >= (v_lim->>v_key)::int then
    raise exception 'plan_limit:%', v_key;
  end if;
  if v_kind = 'pdf' then
    select coalesce(extra_storage_mb, 0) into v_extra from ql_subscriptions where user_id = new.user_id;
    if (v_lim->>'storage_mb') is not null and (new.payload->>'file_size') ~ '^[0-9]+$' and
       (v_use->>'storage_bytes')::bigint + (new.payload->>'file_size')::bigint
         > ((v_lim->>'storage_mb')::bigint + coalesce(v_extra, 0)) * 1048576 then
      raise exception 'plan_limit:storage';
    end if;
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.student_library_items') is not null then
    execute 'drop trigger if exists ql_item_limits on public.student_library_items';
    execute 'create trigger ql_item_limits before insert on public.student_library_items for each row execute function public.ql__check_item_limits()';
  end if;
end $$;

notify pgrst, 'reload schema';
