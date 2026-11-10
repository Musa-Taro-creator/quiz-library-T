-- Quiz Library — share history and saved Quiz IDs ("Shared with me" → History / Saved IDs).
--
-- Run once in Supabase → SQL Editor, after item_sharing.sql. Safe to run again.
-- It does not replace ql_send_item_share, so it works with item_sharing.sql and with
-- the later version in reliability_release_v2.sql / dashboard_reliable_posting_v2.sql.
--
-- 1. History: every internal share already stays in ql_item_shares (status pending /
--    saved / dismissed). This adds the receiver's name and Quiz ID to each row, so
--    the sender can see who they shared with, and adds a read function for both sides.
-- 2. Saved IDs: Quiz IDs you shared with are remembered automatically. You can also
--    save an ID by hand, or forget one. Only you can see your saved IDs.
--
-- Quizzes shared before this change went through the older quiz-share table, which
-- is not part of this history.

alter table public.ql_item_shares add column if not exists recipient_name text;
alter table public.ql_item_shares add column if not exists recipient_share_id text;
create index if not exists ql_item_shares_sent on public.ql_item_shares (sender_id, created_at desc);
create index if not exists ql_item_shares_received on public.ql_item_shares (recipient_id, created_at desc);

create table if not exists public.ql_share_contacts (
  owner_id       uuid        not null references auth.users (id) on delete cascade,
  share_id       text        not null,
  display_name   text,
  share_count    integer     not null default 0,
  last_shared_at timestamptz,
  saved_at       timestamptz not null default now(),
  primary key (owner_id, share_id)
);
alter table public.ql_share_contacts enable row level security;
revoke all on public.ql_share_contacts from anon, authenticated;

-- Fills in the receiver and remembers their ID for the sender.
-- A problem here never stops the share itself.
create or replace function public.ql__item_share_remember()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v jsonb;
begin
  begin
    v := public.ql__share_profile(null, new.recipient_id);
    new.recipient_name := left(coalesce(v->>'display_name', ''), 120);
    new.recipient_share_id := upper(v->>'share_id');
    if new.recipient_share_id is not null and new.sender_id is not null and new.sender_id <> new.recipient_id then
      insert into public.ql_share_contacts as c (owner_id, share_id, display_name, share_count, last_shared_at)
      values (new.sender_id, new.recipient_share_id, new.recipient_name, 1, new.created_at)
      on conflict (owner_id, share_id) do update
        set display_name = excluded.display_name,
            share_count = c.share_count + 1,
            last_shared_at = greatest(coalesce(c.last_shared_at, excluded.last_shared_at), excluded.last_shared_at);
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;
revoke all on function public.ql__item_share_remember() from public, anon, authenticated;

drop trigger if exists ql_item_shares_remember on public.ql_item_shares;
create trigger ql_item_shares_remember
  before insert on public.ql_item_shares
  for each row execute function public.ql__item_share_remember();

-- Earlier shares: add the receiver and remember the IDs (only rows still missing them).
do $$
declare
  r record;
  v jsonb;
begin
  for r in select id, recipient_id from public.ql_item_shares where recipient_share_id is null loop
    begin
      v := public.ql__share_profile(null, r.recipient_id);
      if v is not null then
        update public.ql_item_shares
           set recipient_name = left(coalesce(v->>'display_name', ''), 120),
               recipient_share_id = upper(v->>'share_id')
         where id = r.id;
      end if;
    exception when others then
      null;
    end;
  end loop;
end;
$$;

insert into public.ql_share_contacts as c (owner_id, share_id, display_name, share_count, last_shared_at)
select s.sender_id, s.recipient_share_id,
       (array_agg(s.recipient_name order by s.created_at desc))[1], count(*)::integer, max(s.created_at)
  from public.ql_item_shares s
 where s.recipient_share_id is not null and s.sender_id <> s.recipient_id
   and exists (select 1 from auth.users u where u.id = s.sender_id)
 group by s.sender_id, s.recipient_share_id
on conflict (owner_id, share_id) do update
  set share_count = greatest(c.share_count, excluded.share_count),
      last_shared_at = greatest(coalesce(c.last_shared_at, excluded.last_shared_at), excluded.last_shared_at);

-- Sent and received shares of the signed-in account, newest first.
-- share_unsend.sql installs a newer version; running this file again keeps that one.
do $do$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'ql_item_shares' and column_name = 'unsent_at') then
    execute $f$
create or replace function public.ql_share_history(p_limit integer default 100)
returns table (share_record_id uuid, direction text, kind text, title text, item_count integer,
               person_name text, person_share_id text, status text, created_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select * from (
    select s.id, 'sent'::text, s.kind, s.title, s.item_count, s.recipient_name, s.recipient_share_id, s.status, s.created_at
      from public.ql_item_shares s
     where s.sender_id = auth.uid()
    union all
    select s.id, 'received'::text, s.kind, s.title, s.item_count, s.sender_name, s.sender_share_id, s.status, s.created_at
      from public.ql_item_shares s
     where s.recipient_id = auth.uid()
  ) h
  order by 9 desc
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
$fn$;
$f$;
    revoke all on function public.ql_share_history(integer) from public, anon;
    grant execute on function public.ql_share_history(integer) to authenticated;
  end if;
end;
$do$;

create or replace function public.ql_share_contacts()
returns table (share_id text, display_name text, share_count integer, last_shared_at timestamptz, saved_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select c.share_id, c.display_name, c.share_count, c.last_shared_at, c.saved_at
    from public.ql_share_contacts c
   where c.owner_id = auth.uid()
   order by coalesce(c.last_shared_at, c.saved_at) desc
   limit 100;
$$;
revoke all on function public.ql_share_contacts() from public, anon;
grant execute on function public.ql_share_contacts() to authenticated;

-- Save a Quiz ID for later without sharing anything yet.
create or replace function public.ql_save_share_contact(p_share_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v jsonb;
  v_id text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  v_id := upper(regexp_replace(coalesce(p_share_id, ''), '\s', '', 'g'));
  if v_id !~ '^QL-[A-Z0-9]{8}$' then
    raise exception 'Enter a valid Quiz ID, for example QL-7K4P9M2Q.';
  end if;
  v := public.ql__share_profile(v_id, null);
  if v is null or v->>'__uid' is null then
    raise exception 'No student was found with that Quiz ID.';
  end if;
  if (v->>'__uid')::uuid = v_uid then
    raise exception 'This is your own Quiz ID.';
  end if;
  if (select count(*) from public.ql_share_contacts where owner_id = v_uid) >= 100
     and not exists (select 1 from public.ql_share_contacts where owner_id = v_uid and share_id = v_id) then
    raise exception 'You can save up to 100 Quiz IDs. Forget one first.';
  end if;
  insert into public.ql_share_contacts as c (owner_id, share_id, display_name)
  values (v_uid, v_id, left(coalesce(v->>'display_name', ''), 120))
  on conflict (owner_id, share_id) do update set display_name = excluded.display_name;
  return jsonb_build_object('share_id', v_id, 'display_name', left(coalesce(v->>'display_name', ''), 120));
end;
$$;
revoke all on function public.ql_save_share_contact(text) from public, anon;
grant execute on function public.ql_save_share_contact(text) to authenticated;

create or replace function public.ql_forget_share_contact(p_share_id text)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  delete from public.ql_share_contacts
   where owner_id = auth.uid() and share_id = upper(trim(coalesce(p_share_id, '')));
$$;
revoke all on function public.ql_forget_share_contact(text) from public, anon;
grant execute on function public.ql_forget_share_contact(text) to authenticated;

notify pgrst, 'reload schema';
