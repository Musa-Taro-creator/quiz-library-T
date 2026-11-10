-- Quiz Library — Unsend, and "Recently sent" in the Share internally window.
--
-- Run once in Supabase → SQL Editor, after share_history.sql. Safe to run again.
-- Does not replace ql_send_item_share.
--
-- 1. Unsend: the sender can take back a share while it is still waiting
--    (the receiver has not saved or dismissed it). It leaves the receiver's
--    Inbox and their History, as if it was never sent. A share the receiver
--    already saved cannot be unsent: their copy is their own.
-- 2. Each new share remembers which item it came from (source_item_id), so the
--    Share window can show "Already sent: → Bona · Waiting" for that item.
-- 3. ql_share_history now also returns source_item_id, shows "unsent" to the
--    sender, and hides unsent shares from the receiver.

alter table public.ql_item_shares add column if not exists source_item_id text;
alter table public.ql_item_shares add column if not exists unsent_at timestamptz;
create index if not exists ql_item_shares_source on public.ql_item_shares (sender_id, source_item_id, created_at desc);

create or replace function public.ql__item_share_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.source_item_id is null and jsonb_typeof(new.payload) = 'object' then
    new.source_item_id := left(new.payload->>'root_ref', 200);
  end if;
  return new;
end;
$$;
revoke all on function public.ql__item_share_source() from public, anon, authenticated;

drop trigger if exists ql_item_shares_source on public.ql_item_shares;
create trigger ql_item_shares_source
  before insert on public.ql_item_shares
  for each row execute function public.ql__item_share_source();

-- Earlier shares that still hold their content (saved/dismissed ones were emptied).
update public.ql_item_shares
   set source_item_id = left(payload->>'root_ref', 200)
 where source_item_id is null and jsonb_typeof(payload) = 'object' and payload ? 'root_ref';

-- Returns 'unsent' (also when it was already unsent), or explains why not.
create or replace function public.ql_unsend_item_share(p_share_record_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.ql_item_shares
     set status = 'unsent', payload = '{}'::jsonb, unsent_at = now()
   where id = p_share_record_id and sender_id = v_uid and status = 'pending'
  returning status into v_status;
  if found then
    return 'unsent';
  end if;
  select status into v_status from public.ql_item_shares where id = p_share_record_id and sender_id = v_uid;
  if v_status is null then
    raise exception 'This share was not found.';
  elsif v_status = 'unsent' then
    return 'unsent';
  elsif v_status = 'saved' then
    raise exception 'They already saved it, so it can''t be unsent. Their copy is their own.';
  else
    raise exception 'They already dismissed it, so there is nothing to unsend.';
  end if;
end;
$$;
revoke all on function public.ql_unsend_item_share(uuid) from public, anon;
grant execute on function public.ql_unsend_item_share(uuid) to authenticated;

-- The return columns change (source_item_id added), so the old version is dropped first.
drop function if exists public.ql_share_history(integer);
create function public.ql_share_history(p_limit integer default 100)
returns table (share_record_id uuid, direction text, kind text, title text, item_count integer,
               person_name text, person_share_id text, status text, created_at timestamptz,
               source_item_id text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select * from (
    select s.id, 'sent'::text, s.kind, s.title, s.item_count, s.recipient_name, s.recipient_share_id, s.status, s.created_at, s.source_item_id
      from public.ql_item_shares s
     where s.sender_id = auth.uid()
    union all
    select s.id, 'received'::text, s.kind, s.title, s.item_count, s.sender_name, s.sender_share_id, s.status, s.created_at, null::text
      from public.ql_item_shares s
     where s.recipient_id = auth.uid() and s.status <> 'unsent'
  ) h
  order by 9 desc
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
$$;
revoke all on function public.ql_share_history(integer) from public, anon;
grant execute on function public.ql_share_history(integer) to authenticated;

notify pgrst, 'reload schema';
