-- Quiz Library — Help & Support messages between a student and the admin.
-- Each student has one conversation. Students write from "Help & Support";
-- the admin answers from admin → Messages. Both sides see new messages at once.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.

create table if not exists public.ql_support_msgs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,                 -- the student this conversation belongs to
  from_admin  boolean not null default false,
  body        text not null default '',
  image       text,                          -- optional screenshot (small data URL)
  created_at  timestamptz not null default now(),
  read_at     timestamptz                    -- when the other side opened it
);
create index if not exists ql_support_msgs_user on public.ql_support_msgs (user_id, created_at);
alter table public.ql_support_msgs enable row level security;
revoke all on public.ql_support_msgs from anon, authenticated;
-- students may read their own conversation (needed for instant updates)
drop policy if exists "own support read" on public.ql_support_msgs;
create policy "own support read" on public.ql_support_msgs for select to authenticated using (user_id = auth.uid());
grant select on public.ql_support_msgs to authenticated;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'ql_support_msgs') then
    execute 'alter publication supabase_realtime add table public.ql_support_msgs';
  end if;
end $$;

create or replace function public.ql__support_check(p_body text, p_image text)
returns void language plpgsql immutable as $$
begin
  if coalesce(trim(p_body), '') = '' and coalesce(p_image, '') = '' then raise exception 'Write a message first.'; end if;
  if length(coalesce(p_body, '')) > 2000 then raise exception 'The message is too long (2000 characters max).'; end if;
  if p_image is not null and (left(p_image, 11) <> 'data:image/' or length(p_image) > 900000) then
    raise exception 'The picture is too large or not an image.';
  end if;
end;
$$;

-- student: send a message
create or replace function public.ql_support_send(p_body text, p_image text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform ql__support_check(p_body, p_image);
  if (select count(*) from ql_support_msgs where user_id = v_uid and not from_admin and created_at > now() - interval '1 day') >= 40 then
    raise exception 'You sent a lot of messages today. Please wait for an answer.';
  end if;
  insert into ql_support_msgs (user_id, from_admin, body, image)
  values (v_uid, false, left(coalesce(trim(p_body), ''), 2000), nullif(p_image, ''))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_support_send(text, text) from public, anon;
grant execute on function public.ql_support_send(text, text) to authenticated;

-- student: my conversation (marks the admin's answers as read)
create or replace function public.ql_support_mine()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  update ql_support_msgs set read_at = now() where user_id = v_uid and from_admin and read_at is null;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'from_admin', from_admin, 'body', body, 'image', image, 'created_at', created_at, 'read_at', read_at) order by created_at)
                     from (select * from ql_support_msgs where user_id = v_uid order by created_at desc limit 200) m), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_support_mine() from public, anon;
grant execute on function public.ql_support_mine() to authenticated;

-- student: how many answers I haven't read
create or replace function public.ql_support_unread()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from ql_support_msgs where user_id = auth.uid() and from_admin and read_at is null;
$$;
revoke all on function public.ql_support_unread() from public, anon;
grant execute on function public.ql_support_unread() to authenticated;

-- admin: one row per student, newest first
create or replace function public.ql_admin_support_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(t order by t->>'last_at' desc) from (
    select jsonb_build_object(
      'user_id', m.user_id,
      'email', u.email,
      'name', coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
      'last_at', max(m.created_at),
      'last', (select case when x.body <> '' then x.body else '📷 Photo' end from ql_support_msgs x where x.user_id = m.user_id order by x.created_at desc limit 1),
      'last_from_admin', (select x.from_admin from ql_support_msgs x where x.user_id = m.user_id order by x.created_at desc limit 1),
      'unread', count(*) filter (where not m.from_admin and m.read_at is null)) as t
    from ql_support_msgs m left join auth.users u on u.id = m.user_id
    group by m.user_id, u.email, u.raw_user_meta_data) s), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_support_list() from public, anon;
grant execute on function public.ql_admin_support_list() to authenticated;

-- admin: one conversation (marks the student's messages as read)
create or replace function public.ql_admin_support_thread(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  update ql_support_msgs set read_at = now() where user_id = p_user and not from_admin and read_at is null;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'from_admin', from_admin, 'body', body, 'image', image, 'created_at', created_at, 'read_at', read_at) order by created_at)
                     from (select * from ql_support_msgs where user_id = p_user order by created_at desc limit 300) m), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_support_thread(uuid) from public, anon;
grant execute on function public.ql_admin_support_thread(uuid) to authenticated;

-- admin: answer
create or replace function public.ql_admin_support_reply(p_user uuid, p_body text, p_image text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform ql__need_admin();
  perform ql__support_check(p_body, p_image);
  insert into ql_support_msgs (user_id, from_admin, body, image)
  values (p_user, true, left(coalesce(trim(p_body), ''), 2000), nullif(p_image, ''))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_admin_support_reply(uuid, text, text) from public, anon;
grant execute on function public.ql_admin_support_reply(uuid, text, text) to authenticated;

-- admin: delete a whole conversation
create or replace function public.ql_admin_support_delete(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  delete from ql_support_msgs where user_id = p_user;
end;
$$;
revoke all on function public.ql_admin_support_delete(uuid) from public, anon;
grant execute on function public.ql_admin_support_delete(uuid) to authenticated;

-- admin: how many unread student messages (for the red number)
create or replace function public.ql_admin_support_unread()
returns integer language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return (select count(*)::int from ql_support_msgs where not from_admin and read_at is null);
end;
$$;
revoke all on function public.ql_admin_support_unread() from public, anon;
grant execute on function public.ql_admin_support_unread() to authenticated;

notify pgrst, 'reload schema';
