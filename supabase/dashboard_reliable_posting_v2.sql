-- Server sharing restrictions and resumable Dashboard posts. Local migration.
-- Requires plans_admin.sql, item_sharing.sql, dashboard.sql and external quiz sharing.
begin;
-- The existing daily post limit filters by owner/date. The supplied schema
-- has only a status/date index; avoid scanning every student's posts here.
create index if not exists ql_dash_posts_owner_created_v2 on public.ql_dash_posts(owner_id,created_at);
create or replace function public.ql_send_item_share(
  p_recipient_share_id text, p_kind text, p_title text, p_item_count integer, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
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
  if not public.ql__feature_ok(v_uid, 'item_share_in') then raise exception 'Sharing is disabled for this account.' using errcode='42501';end if;
  if exists(select 1 from public.ql_subscriptions where user_id=v_uid and status='suspended') then raise exception 'Account suspended' using errcode='42501';end if;
  if p_kind not in ('pdf', 'link', 'folder', 'quiz') then
    raise exception 'This item cannot be shared';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'missing share content';
  end if;
  v_to := public.ql__share_profile(p_recipient_share_id, null);
  if v_to is null or v_to->>'__uid' is null then
    raise exception 'No student was found with that Quiz ID.';
  end if;
  v_me := public.ql__share_profile(null, v_uid);
  insert into public.ql_item_shares (sender_id, recipient_id, kind, title, item_count, sender_name, sender_share_id, payload)
  values (v_uid, (v_to->>'__uid')::uuid, p_kind, left(coalesce(p_title, ''), 200), greatest(coalesce(p_item_count, 1), 1),
          left(coalesce(v_me->>'display_name', ''), 120), v_me->>'share_id', p_payload)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_send_item_share(text, text, text, integer, jsonb) from public, anon;
grant execute on function public.ql_send_item_share(text, text, text, integer, jsonb) to authenticated;

create or replace function public.ql_create_external_item_share(p_kind text, p_title text, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.ql__feature_ok(v_uid, 'item_share_ex') then raise exception 'Sharing is disabled for this account.' using errcode='42501';end if;
  if exists(select 1 from public.ql_subscriptions where user_id=v_uid and status='suspended') then raise exception 'Account suspended' using errcode='42501';end if;
  if p_kind not in ('pdf', 'link', 'folder') then
    raise exception 'This item cannot be shared externally';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'missing share content';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  insert into public.ql_external_item_shares (token, owner_id, kind, title, payload)
  values (v_token, v_uid, p_kind, left(coalesce(p_title, ''), 200), p_payload);
  return v_token;
end;
$$;
revoke all on function public.ql_create_external_item_share(text, text, jsonb) from public, anon;
grant execute on function public.ql_create_external_item_share(text, text, jsonb) to authenticated;

create table if not exists public.ql_dash_uploads_v2(
 owner_id uuid not null references auth.users(id) on delete cascade,
 operation_id uuid not null,kind text not null,title text not null,item_count integer not null,
 parts integer not null,content_hash text not null,post_id uuid,
 expires_at timestamptz not null default now()+interval '24 hours',primary key(owner_id,operation_id)
);
create table if not exists public.ql_dash_upload_parts_v2(
 owner_id uuid not null,operation_id uuid not null,part integer not null,body bytea not null,
 primary key(owner_id,operation_id,part),foreign key(owner_id,operation_id) references public.ql_dash_uploads_v2 on delete cascade
);
create table if not exists public.ql_dash_quiz_preparations_v2(
 owner_id uuid not null references auth.users(id) on delete cascade,operation_id uuid not null,item_id text not null,
 fingerprint text not null,result jsonb not null,expires_at timestamptz not null default now()+interval '24 hours',
 primary key(owner_id,operation_id,item_id)
);
alter table public.ql_dash_uploads_v2 enable row level security;
alter table public.ql_dash_upload_parts_v2 enable row level security;
alter table public.ql_dash_quiz_preparations_v2 enable row level security;
revoke all on public.ql_dash_uploads_v2,public.ql_dash_upload_parts_v2,public.ql_dash_quiz_preparations_v2 from public,anon,authenticated;
create index if not exists ql_dash_upload_expiry_v2 on public.ql_dash_uploads_v2(expires_at);
create index if not exists ql_dash_preparation_expiry_v2 on public.ql_dash_quiz_preparations_v2(expires_at);
create or replace function public.ql_dash_check_v2()
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if auth.uid() is null then raise exception 'not authenticated' using errcode='28000';end if;
 if not public.ql__feature_ok(auth.uid(),'item_share_dash') or exists(select 1 from public.ql_subscriptions where user_id=auth.uid() and status='suspended') then raise exception 'Posting is disabled for this account' using errcode='42501';end if;
end $$;
revoke all on function public.ql_dash_check_v2() from public,anon,authenticated;

-- One quiz share per operation+quiz, INCLUDING retries after a lost response.
create or replace function public.ql_prepare_dash_quiz_v2(p_operation_id uuid,p_library_id text,p_item_id text,p_title text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;old public.ql_dash_quiz_preparations_v2;r jsonb;
begin
 perform public.ql_dash_check_v2();
 if p_operation_id is null or p_item_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>33554432 then raise exception 'QL_LIMIT: Invalid or oversized quiz preparation';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':dash:'||p_operation_id||':'||p_item_id,0));
 h:=encode(sha256(convert_to(jsonb_build_array(p_library_id,p_title,p_payload)::text,'UTF8')),'hex');
 select * into old from public.ql_dash_quiz_preparations_v2 where owner_id=auth.uid() and operation_id=p_operation_id and item_id=p_item_id;
 if found then if old.fingerprint<>h then raise exception 'QL_CONFLICT: Prepared quiz changed. Start a new posting operation.';end if;return old.result;end if;
 -- Exact deployed text/text/text/text/jsonb signature and TABLE return,
 -- verified against the user's read-only schema export on 2026-10-19.
 select to_jsonb(result) into strict r from public.ql_create_external_quiz_share(
  p_library_id,p_item_id,p_title,'guest'::text,p_payload) result;
 if coalesce(r->>'share_token',r->>'token') is null then raise exception 'QL_PROTOCOL: Unsupported external sharing result';end if;
 insert into public.ql_dash_quiz_preparations_v2(owner_id,operation_id,item_id,fingerprint,result) values(auth.uid(),p_operation_id,p_item_id,h,r);
 return r;
end $$;
revoke all on function public.ql_prepare_dash_quiz_v2(uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.ql_prepare_dash_quiz_v2(uuid,text,text,text,jsonb) to authenticated;

create or replace function public.ql_begin_dash_upload_v2(p_operation_id uuid,p_kind text,p_title text,p_item_count integer,p_parts integer,p_content_hash text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare s public.ql_dash_uploads_v2;
begin
 perform public.ql_dash_check_v2();
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':dash-quota',0));
 with expired as(select owner_id,operation_id from public.ql_dash_uploads_v2 where expires_at<now() for update skip locked limit 100) delete from public.ql_dash_uploads_v2 target using expired e where target.owner_id=e.owner_id and target.operation_id=e.operation_id;
 with expired_preparations as(select owner_id,operation_id,item_id from public.ql_dash_quiz_preparations_v2 where expires_at<now() for update skip locked limit 200) delete from public.ql_dash_quiz_preparations_v2 target using expired_preparations e where target.owner_id=e.owner_id and target.operation_id=e.operation_id and target.item_id=e.item_id;
 if p_operation_id is null or p_kind not in ('folder','quiz','pdf','link') or p_item_count<1 or p_item_count>100000 or p_parts<1 or p_parts>1024 or p_content_hash !~ '^[a-f0-9]{64}$' then raise exception 'QL_INVALID: Invalid Dashboard upload';end if;
 select * into s from public.ql_dash_uploads_v2 where owner_id=auth.uid() and operation_id=p_operation_id for update;
 if found then
  if s.kind<>p_kind or s.title<>p_title or s.item_count<>p_item_count or s.parts<>p_parts or s.content_hash<>p_content_hash then raise exception 'QL_CONFLICT: Posting operation changed';end if;
  return s.post_id;
 end if;
 if (select count(*) from public.ql_dash_uploads_v2 where owner_id=auth.uid() and post_id is null)>=8 then raise exception 'QL_LIMIT: Too many unfinished Dashboard posts';end if;
 insert into public.ql_dash_uploads_v2(owner_id,operation_id,kind,title,item_count,parts,content_hash) values(auth.uid(),p_operation_id,p_kind,p_title,p_item_count,p_parts,p_content_hash);
 return null;
end $$;
revoke all on function public.ql_begin_dash_upload_v2(uuid,text,text,integer,integer,text) from public,anon;
grant execute on function public.ql_begin_dash_upload_v2(uuid,text,text,integer,integer,text) to authenticated;
create or replace function public.ql_stage_dash_upload_v2(p_operation_id uuid,p_part integer,p_base64 text)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s public.ql_dash_uploads_v2;b bytea;old bytea;
begin
 perform public.ql_dash_check_v2();
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':dash-quota',0));
 select * into s from public.ql_dash_uploads_v2 where owner_id=auth.uid() and operation_id=p_operation_id for update;
 if not found then raise exception 'Upload not found' using errcode='42501';end if;
 if s.expires_at<now() then raise exception 'QL_EXPIRED: Posting upload expired';end if;
 if s.post_id is not null then return;end if;
 if p_part<0 or p_part>=s.parts or p_base64 is null or octet_length(p_base64)>90000 then raise exception 'QL_INVALID: Invalid upload part';end if;
 b:=decode(p_base64,'base64');if octet_length(b)>65536 then raise exception 'QL_LIMIT: Upload part too large';end if;
 select body into old from public.ql_dash_upload_parts_v2 where owner_id=auth.uid() and operation_id=p_operation_id and part=p_part;
 if found then if old<>b then raise exception 'QL_INVALID: Upload retry changed';end if;return;end if;
 if coalesce((select sum(octet_length(body)) from public.ql_dash_upload_parts_v2 where owner_id=auth.uid()),0)+octet_length(b)>67108864 then raise exception 'QL_LIMIT: Pending posts exceed 64 MB';end if;
 insert into public.ql_dash_upload_parts_v2 values(auth.uid(),p_operation_id,p_part,b);
end $$;
revoke all on function public.ql_stage_dash_upload_v2(uuid,integer,text) from public,anon;
grant execute on function public.ql_stage_dash_upload_v2(uuid,integer,text) to authenticated;
create or replace function public.ql_finalize_dash_upload_v2(p_operation_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare s public.ql_dash_uploads_v2;b bytea;p jsonb;n integer;post uuid;
begin
 perform public.ql_dash_check_v2();
 select * into s from public.ql_dash_uploads_v2 where owner_id=auth.uid() and operation_id=p_operation_id for update;
 if not found then raise exception 'Upload not found' using errcode='42501';end if;
 if s.expires_at<now() then raise exception 'QL_EXPIRED: Posting upload expired';end if;
 if s.post_id is not null then return s.post_id;end if;
 select string_agg(body,''::bytea order by part),count(*) into b,n from public.ql_dash_upload_parts_v2 where owner_id=auth.uid() and operation_id=p_operation_id;
 if n<>s.parts or encode(sha256(b),'hex')<>s.content_hash then raise exception 'QL_INVALID: Incomplete Dashboard upload';end if;
 p:=convert_from(b,'UTF8')::jsonb;
 if jsonb_typeof(p->'nodes') is distinct from 'array' or jsonb_array_length(p->'nodes')<>s.item_count or p->>'kind' is distinct from s.kind then raise exception 'QL_INVALID: Invalid Dashboard content';end if;
 post:=public.ql_dash_post(s.kind,s.title,s.item_count,p);
 update public.ql_dash_uploads_v2 set post_id=post where owner_id=auth.uid() and operation_id=p_operation_id;
 delete from public.ql_dash_upload_parts_v2 where owner_id=auth.uid() and operation_id=p_operation_id;
 return post;
end $$;
revoke all on function public.ql_finalize_dash_upload_v2(uuid) from public,anon;
grant execute on function public.ql_finalize_dash_upload_v2(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
