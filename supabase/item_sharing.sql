-- Quiz Library — share PDFs, links and folders (with everything inside).
--
-- Run this once in Supabase → SQL Editor. It is safe to run again.
-- Needs the existing quiz-sharing setup (student_share_profiles, QL- IDs)
-- and external_share_short_links.sql. Nothing existing is changed.
--
-- 1. Share internally: send a copy of a PDF, link, folder or quiz to another
--    Quiz Library account (found by its QL- ID). The receiver saves it into
--    one of their folders from "Shared with me".
-- 2. Share externally: a link page anyone can open without an account,
--    showing the PDF, the link, or the whole folder.

-- ---------------------------------------------------------------- internal
create table if not exists public.ql_item_shares (
  id              uuid        primary key default gen_random_uuid(),
  sender_id       uuid        not null default auth.uid(),
  recipient_id    uuid        not null,
  kind            text        not null,
  title           text        not null default '',
  item_count      integer     not null default 1,
  sender_name     text,
  sender_share_id text,
  payload         jsonb       not null,
  status          text        not null default 'pending',
  created_at      timestamptz not null default now()
);
create index if not exists ql_item_shares_inbox on public.ql_item_shares (recipient_id, status, created_at desc);
alter table public.ql_item_shares enable row level security;
revoke all on public.ql_item_shares from anon, authenticated;

-- Finds the account behind a QL- ID in the existing student_share_profiles
-- table (whichever uuid column holds the account id).
create or replace function public.ql__share_profile(p_share_id text, p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_col text;
  v_row jsonb;
begin
  select column_name into v_col
    from information_schema.columns
   where table_schema = 'public' and table_name = 'student_share_profiles' and data_type = 'uuid'
   order by case column_name when 'user_id' then 0 when 'owner_id' then 1 when 'student_id' then 2
                             when 'auth_user_id' then 3 when 'id' then 4 else 9 end
   limit 1;
  if v_col is null then
    raise exception 'Quiz sharing is not set up yet (student_share_profiles missing)';
  end if;
  if p_share_id is not null then
    execute format('select to_jsonb(p) || jsonb_build_object(''__uid'', p.%I) from public.student_share_profiles p where upper(p.share_id) = upper($1) limit 1', v_col)
      into v_row using trim(p_share_id);
  else
    execute format('select to_jsonb(p) || jsonb_build_object(''__uid'', p.%I) from public.student_share_profiles p where p.%I = $1 limit 1', v_col, v_col)
      into v_row using p_user;
  end if;
  return v_row;
end;
$$;
revoke all on function public.ql__share_profile(text, uuid) from public, anon, authenticated;

create or replace function public.ql_send_item_share(
  p_recipient_share_id text, p_kind text, p_title text, p_item_count integer, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
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
  if p_kind not in ('pdf', 'link', 'folder', 'quiz') then
    raise exception 'This item cannot be shared';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'missing share content';
  end if;
  v_to := ql__share_profile(p_recipient_share_id, null);
  if v_to is null or v_to->>'__uid' is null then
    raise exception 'No student was found with that Quiz ID.';
  end if;
  v_me := ql__share_profile(null, v_uid);
  insert into ql_item_shares (sender_id, recipient_id, kind, title, item_count, sender_name, sender_share_id, payload)
  values (v_uid, (v_to->>'__uid')::uuid, p_kind, left(coalesce(p_title, ''), 200), greatest(coalesce(p_item_count, 1), 1),
          left(coalesce(v_me->>'display_name', ''), 120), v_me->>'share_id', p_payload)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_send_item_share(text, text, text, integer, jsonb) from public, anon;
grant execute on function public.ql_send_item_share(text, text, text, integer, jsonb) to authenticated;

create or replace function public.ql_received_item_shares()
returns table (share_record_id uuid, kind text, title text, item_count integer,
               sender_name text, sender_share_id text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select id, kind, title, item_count, sender_name, sender_share_id, created_at
    from ql_item_shares
   where recipient_id = auth.uid() and status = 'pending'
   order by created_at desc;
$$;
revoke all on function public.ql_received_item_shares() from public, anon;
grant execute on function public.ql_received_item_shares() to authenticated;

create or replace function public.ql_received_item_share_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from ql_item_shares where recipient_id = auth.uid() and status = 'pending';
$$;
revoke all on function public.ql_received_item_share_count() from public, anon;
grant execute on function public.ql_received_item_share_count() to authenticated;

create or replace function public.ql_get_received_item_share(p_share_record_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select payload from ql_item_shares
   where id = p_share_record_id and recipient_id = auth.uid() and status = 'pending';
$$;
revoke all on function public.ql_get_received_item_share(uuid) from public, anon;
grant execute on function public.ql_get_received_item_share(uuid) to authenticated;

create or replace function public.ql_finish_item_share(p_share_record_id uuid, p_saved boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update ql_item_shares
     set status = case when p_saved then 'saved' else 'dismissed' end,
         payload = '{}'::jsonb
   where id = p_share_record_id and recipient_id = auth.uid() and status = 'pending';
$$;
revoke all on function public.ql_finish_item_share(uuid, boolean) from public, anon;
grant execute on function public.ql_finish_item_share(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- external
create table if not exists public.ql_external_item_shares (
  token      text        primary key,
  owner_id   uuid        not null default auth.uid(),
  kind       text        not null,
  title      text        not null default '',
  payload    jsonb       not null,
  revoked    boolean     not null default false,
  created_at timestamptz not null default now()
);
alter table public.ql_external_item_shares enable row level security;
revoke all on public.ql_external_item_shares from anon, authenticated;

create or replace function public.ql_create_external_item_share(p_kind text, p_title text, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_kind not in ('pdf', 'link', 'folder') then
    raise exception 'This item cannot be shared externally';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'missing share content';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  insert into ql_external_item_shares (token, owner_id, kind, title, payload)
  values (v_token, v_uid, p_kind, left(coalesce(p_title, ''), 200), p_payload);
  return v_token;
end;
$$;
revoke all on function public.ql_create_external_item_share(text, text, jsonb) from public, anon;
grant execute on function public.ql_create_external_item_share(text, text, jsonb) to authenticated;

-- People opening the link have no account, so anon may read one share by
-- its exact token (never a list).
create or replace function public.ql_get_external_item_share(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('kind', kind, 'title', title, 'payload', payload, 'created_at', created_at)
    from ql_external_item_shares
   where token = trim(p_token) and not revoked
   limit 1;
$$;
revoke all on function public.ql_get_external_item_share(text) from public;
grant execute on function public.ql_get_external_item_share(text) to anon, authenticated;

notify pgrst, 'reload schema';
