-- Quiz Library — Dashboard: a board every student can see.
-- Students post a quiz, PDF, link or folder; the admin approves it first.
-- On the Dashboard others can TAKE quizzes and OPEN the rest (view only).
-- "Save to my library" (full access) is a separate switch the admin controls
-- in Website Control (key dash_save: Everyone / By plan / Lock / Hidden).
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.

create table if not exists public.ql_dash_posts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  kind        text not null,
  title       text not null default '',
  item_count  integer not null default 1,
  author_name text,
  payload     jsonb not null,
  status      text not null default 'pending',   -- pending | approved | rejected | removed
  admin_note  text not null default '',
  opens       integer not null default 0,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists ql_dash_posts_status on public.ql_dash_posts (status, created_at desc);
alter table public.ql_dash_posts enable row level security;
revoke all on public.ql_dash_posts from anon, authenticated;

-- Is this feature on for this account? (same rules as the website switches)
create or replace function public.ql__feature_ok(p_uid uuid, p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select case coalesce((select value->>p_key from ql_site_settings where key = 'features'), 'on')
           when 'off' then false
           when 'lock' then false
           when 'plan' then coalesce((select (features->>p_key)::boolean from ql_plans where id = ql__effective_plan(p_uid)), false)
           else true end;
$$;
revoke all on function public.ql__feature_ok(uuid, text) from public, anon, authenticated;

-- The payload without quiz questions (so nobody can copy answers from a view-only post)
create or replace function public.ql__dash_view(p jsonb)
returns jsonb language sql immutable as $$
  select p || jsonb_build_object('nodes', coalesce((select jsonb_agg(n - 'questions' - 'quiz_settings') from jsonb_array_elements(p->'nodes') n), '[]'::jsonb));
$$;

create or replace function public.ql_dash_post(p_kind text, p_title text, p_item_count integer, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_name text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_kind not in ('quiz', 'pdf', 'link', 'folder') then raise exception 'This item cannot be posted'; end if;
  if p_payload is null or jsonb_typeof(p_payload->'nodes') <> 'array' then raise exception 'missing content'; end if;
  if not ql__feature_ok(v_uid, 'item_share_dash') then raise exception 'Posting to the Dashboard is not available on your plan.'; end if;
  if exists (select 1 from ql_subscriptions where user_id = v_uid and status = 'suspended') then raise exception 'This account is suspended.'; end if;
  if (select count(*) from ql_dash_posts where owner_id = v_uid and status = 'pending') >= 10 then
    raise exception 'You already have 10 posts waiting for approval.';
  end if;
  select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)) into v_name
    from auth.users u where u.id = v_uid;
  insert into ql_dash_posts (owner_id, kind, title, item_count, author_name, payload)
  values (v_uid, p_kind, left(coalesce(p_title, ''), 200), greatest(coalesce(p_item_count, 1), 1), left(v_name, 80), p_payload)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_dash_post(text, text, integer, jsonb) from public, anon;
grant execute on function public.ql_dash_post(text, text, integer, jsonb) to authenticated;

-- The board (approved posts) + my own posts with their status
create or replace function public.ql_dash_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'posts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'item_count', item_count,
                 'author_name', author_name, 'created_at', created_at, 'opens', opens, 'mine', owner_id = auth.uid()) order by decided_at desc nulls last, created_at desc)
               from ql_dash_posts where status = 'approved'), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'status', status, 'admin_note', admin_note, 'created_at', created_at) order by created_at desc)
               from ql_dash_posts where owner_id = auth.uid() and status <> 'removed'), '[]'::jsonb),
    'can_save', ql__feature_ok(auth.uid(), 'dash_save'));
$$;
revoke all on function public.ql_dash_list() from public, anon;
grant execute on function public.ql_dash_list() to authenticated;

-- Open a post (view only: quizzes have no questions, only the take-quiz link)
create or replace function public.ql_dash_open(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r ql_dash_posts;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into r from ql_dash_posts where id = p_id and (status = 'approved' or owner_id = auth.uid());
  if r.id is null then raise exception 'This post is no longer on the Dashboard.'; end if;
  if r.owner_id <> auth.uid() then update ql_dash_posts set opens = opens + 1 where id = p_id; end if;
  return jsonb_build_object('title', r.title, 'kind', r.kind, 'author_name', r.author_name, 'payload', ql__dash_view(r.payload));
end;
$$;
revoke all on function public.ql_dash_open(uuid) from public, anon;
grant execute on function public.ql_dash_open(uuid) to authenticated;

-- Full copy for "Save to my library" — only when the admin allows it for this account
create or replace function public.ql_dash_full(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r ql_dash_posts;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not ql__feature_ok(auth.uid(), 'dash_save') then raise exception 'Saving from the Dashboard is not available on your plan.'; end if;
  select * into r from ql_dash_posts where id = p_id and status = 'approved';
  if r.id is null then raise exception 'This post is no longer on the Dashboard.'; end if;
  return r.payload;
end;
$$;
revoke all on function public.ql_dash_full(uuid) from public, anon;
grant execute on function public.ql_dash_full(uuid) to authenticated;

-- Take my own post down
create or replace function public.ql_dash_delete_mine(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update ql_dash_posts set status = 'removed', payload = '{"nodes":[]}'::jsonb where id = p_id and owner_id = auth.uid();
$$;
revoke all on function public.ql_dash_delete_mine(uuid) from public, anon;
grant execute on function public.ql_dash_delete_mine(uuid) to authenticated;

-- ---------------------------------------------------------------- admin
create or replace function public.ql_admin_dash(p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'item_count', d.item_count,
            'author_name', d.author_name, 'email', u.email, 'status', d.status, 'admin_note', d.admin_note, 'opens', d.opens,
            'created_at', d.created_at, 'decided_at', d.decided_at,
            'nodes', (select jsonb_agg(jsonb_build_object('kind', n->>'kind', 'title', n->>'title', 'ref', n->>'ref', 'parent_ref', n->>'parent_ref',
                        'url', n->>'url', 'pdf_url', n->>'pdf_url', 'quiz_link', n->>'quiz_link',
                        'questions', case when jsonb_typeof(n->'questions') = 'array' then jsonb_array_length(n->'questions') end))
                      from jsonb_array_elements(d.payload->'nodes') n)) order by d.created_at desc)
    from ql_dash_posts d left join auth.users u on u.id = d.owner_id
    where d.status = p_status), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_dash(text) from public, anon;
grant execute on function public.ql_admin_dash(text) to authenticated;

create or replace function public.ql_admin_dash_decide(p_id uuid, p_action text, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_action not in ('approve', 'reject', 'remove') then raise exception 'Unknown action'; end if;
  update ql_dash_posts set status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'removed' end,
         admin_note = coalesce(p_note, ''), decided_at = now()
   where id = p_id;
end;
$$;
revoke all on function public.ql_admin_dash_decide(uuid, text, text) from public, anon;
grant execute on function public.ql_admin_dash_decide(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
