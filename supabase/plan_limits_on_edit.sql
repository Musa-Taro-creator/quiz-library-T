-- Quiz Library — plan limits also apply to restored and changed items.
--
-- Before, the database checked plan limits only when an item was CREATED. Items in
-- Trash do not count, so a student could reach the limit, move items to Trash, create
-- more, then restore the old ones and go past the limit. An item's kind could also be
-- changed afterwards (for example an unlimited folder into a quiz), and a PDF's size
-- could grow after it was added.
--
-- Now the same limits are checked when an item:
--   • is restored from Trash,
--   • changes kind (folder / link / PDF / quiz),
--   • is a PDF whose file size grows (storage).
-- Normal edits are not affected: renaming, moving, favourites, quiz questions and
-- settings, moving to Trash, and editing a copy of an item the admin shared.
--
-- Run once in Supabase → SQL Editor, AFTER plan_limits_more.sql. Safe to run again.

create or replace function public.ql__check_item_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_lim jsonb;
  v_use jsonb;
  v_kind text := new.payload->>'kind';
  v_key text;
  v_extra integer;
  v_old_size bigint := 0;
  v_new_size bigint := 0;
  v_count_check boolean := true;
begin
  if not coalesce(new.personalized, false) or v_kind not in ('quiz', 'pdf', 'link', 'folder') then return new; end if;

  if tg_op = 'INSERT' then
    if exists (select 1 from student_library_items where user_id = new.user_id and library_id = new.library_id and id = new.id) then
      return new;   -- an edit of an existing item, not a new one (the UPDATE below checks it)
    end if;
  else
    -- In Trash: not counted, nothing to check.
    if coalesce(new.payload->>'is_trashed', 'false') = 'true' then return new; end if;
    -- A copy of an admin-shared item that the student edits: unchanged behaviour.
    if not coalesce(old.personalized, false) then return new; end if;
    if coalesce(old.payload->>'is_trashed', 'false') <> 'true' and old.payload->>'kind' is not distinct from v_kind then
      -- The same counted item keeps its kind: only a growing PDF can need a check.
      if v_kind <> 'pdf' then return new; end if;
      if (old.payload->>'file_size') ~ '^[0-9]+$' then v_old_size := (old.payload->>'file_size')::bigint; end if;
      if (new.payload->>'file_size') ~ '^[0-9]+$' then v_new_size := (new.payload->>'file_size')::bigint; end if;
      if v_new_size <= v_old_size then return new; end if;
      v_count_check := false;
    end if;
    -- Otherwise the item is restored from Trash or changes kind: it is added to the
    -- count for its (new) kind, exactly like a new item.
  end if;

  if exists (select 1 from ql_subscriptions where user_id = new.user_id and status = 'suspended') then
    raise exception 'plan_limit:suspended';
  end if;
  select limits into v_lim from ql_plans where id = ql__effective_plan(new.user_id);
  if v_lim is null then return new; end if;
  -- Usage is read before this change is saved: a restored item or a changed kind is
  -- not in its new count yet, and a growing PDF is counted at its old size.
  v_use := ql__usage(new.user_id);
  v_key := case v_kind when 'quiz' then 'quizzes' when 'pdf' then 'pdfs' when 'link' then 'links' else 'folders' end;
  if v_count_check and (v_lim->>v_key) ~ '^[0-9]+$' and coalesce((v_use->>v_key)::int, 0) >= (v_lim->>v_key)::int then
    raise exception 'plan_limit:%', v_key;
  end if;
  if v_kind = 'pdf' then
    select coalesce(extra_storage_mb, 0) into v_extra from ql_subscriptions where user_id = new.user_id;
    if (v_lim->>'storage_mb') is not null and (new.payload->>'file_size') ~ '^[0-9]+$' and
       (v_use->>'storage_bytes')::bigint - v_old_size + (new.payload->>'file_size')::bigint
         > ((v_lim->>'storage_mb')::bigint + coalesce(v_extra, 0)) * 1048576 then
      raise exception 'plan_limit:storage';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.ql__check_item_limits() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.student_library_items') is not null then
    execute 'drop trigger if exists ql_item_limits on public.student_library_items';
    execute 'create trigger ql_item_limits before insert or update on public.student_library_items for each row execute function public.ql__check_item_limits()';
  end if;
end $$;

notify pgrst, 'reload schema';
