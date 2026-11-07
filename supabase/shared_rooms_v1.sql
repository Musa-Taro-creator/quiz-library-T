-- Shared Rooms. Run after the existing Dashboard quiz setup.
-- Separate storage, permissions and history; existing library RPCs are unchanged.
begin;
create table if not exists public.ql_rooms_v1(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null,description text not null default '',invite_code text not null unique,
 status text not null default 'active',locked boolean not null default false,permissions jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create table if not exists public.ql_room_members_v1(
 room_id uuid references public.ql_rooms_v1 on delete cascade,user_id uuid references auth.users on delete cascade,
 can_edit boolean not null default true,status text not null default 'active',joined_at timestamptz not null default now(),primary key(room_id,user_id)
);
create table if not exists public.ql_room_items_v1(
 room_id uuid not null references public.ql_rooms_v1 on delete cascade,id uuid primary key,
 parent_id uuid references public.ql_room_items_v1(id) on delete cascade,creator_id uuid references auth.users on delete set null,
 payload jsonb not null,revision bigint not null default 1,updated_at timestamptz not null default now()
);
create index if not exists ql_room_items_parent_v1 on public.ql_room_items_v1(room_id,parent_id);
create table if not exists public.ql_room_events_v1(
 id bigint generated always as identity primary key,room_id uuid references public.ql_rooms_v1 on delete cascade,
 actor_id uuid references auth.users on delete set null,actor_name text,action text not null,title text,created_at timestamptz not null default now()
);
create table if not exists public.ql_room_preferences_v1(
 room_id uuid references public.ql_rooms_v1 on delete cascade,item_id uuid references public.ql_room_items_v1 on delete cascade,
 user_id uuid references auth.users on delete cascade,settings jsonb not null default '{}',primary key(room_id,item_id,user_id)
);
create table if not exists public.ql_room_attempts_v1(
 room_id uuid references public.ql_rooms_v1 on delete cascade,item_id uuid references public.ql_room_items_v1 on delete cascade,
 user_id uuid references auth.users on delete cascade,id uuid not null,result jsonb not null,created_at timestamptz not null default now(),primary key(user_id,id)
);
create index if not exists ql_room_attempt_history_v1 on public.ql_room_attempts_v1(room_id,item_id,user_id,created_at desc);
create table if not exists public.ql_room_saves_v1(
 id uuid primary key,room_id uuid references public.ql_rooms_v1 on delete cascade,item_id uuid references public.ql_room_items_v1 on delete cascade,
 user_id uuid references auth.users on delete cascade,base_revision bigint not null,fingerprint text not null,
 question_count integer not null,part_count integer not null,parts jsonb not null default '{}',settings jsonb not null,result jsonb,created_at timestamptz not null default now()
);
do $$declare t text;begin
 foreach t in array array['ql_rooms_v1','ql_room_members_v1','ql_room_items_v1','ql_room_events_v1','ql_room_preferences_v1','ql_room_attempts_v1','ql_room_saves_v1'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
end $$;

create or replace function public.ql_room_name_v1(u uuid) returns text language sql stable security definer set search_path=public,pg_temp as $$
 select left(coalesce(nullif(raw_user_meta_data->>'full_name',''),nullif(raw_user_meta_data->>'name',''),split_part(email,'@',1),'Student'),120) from auth.users where id=u
$$;
create or replace function public.ql_room_config_v1() returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select '{"enabled":true,"max_rooms":10,"max_members":100,"max_items":1000,"max_questions":10000,"max_pdf_mb":50,"permissions":{}}'::jsonb||coalesce((select value from public.ql_site_settings where key='rooms'),'{}')
$$;
create or replace function public.ql_room_auth_v1() returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'Sign in to use Rooms.' using errcode='28000';end if;
 if exists(select 1 from public.ql_subscriptions where user_id=auth.uid() and status='suspended') then raise exception 'This account is suspended.';end if;
 return auth.uid();
end $$;
create or replace function public.ql_room_access_v1(rid uuid,w boolean default false,k text default null)
returns public.ql_rooms_v1 language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.ql_rooms_v1;m public.ql_room_members_v1;u uuid:=public.ql_room_auth_v1();a boolean:=public.ql__is_admin(u);c jsonb:=public.ql_room_config_v1();
begin
 select * into r from public.ql_rooms_v1 where id=rid;
 if r.id is null then raise exception 'Room not found.' using errcode='P0002';end if;
 select * into m from public.ql_room_members_v1 where room_id=rid and user_id=u and status='active';
 if not a and r.owner_id<>u and m.user_id is null then raise exception 'You are not a member of this room.' using errcode='42501';end if;
 if not a and (not (c->>'enabled')::boolean or r.status='suspended' or (r.status='closed' and r.owner_id<>u)) then raise exception 'This room is unavailable. Contact its owner or the website admin.';end if;
 if w and not a then
  if r.status<>'active' then raise exception 'This room is closed.';end if;
  if r.owner_id<>u and (r.locked or not m.can_edit) then raise exception 'The room owner has restricted your editing access.' using errcode='42501';end if;
  if k is not null and (coalesce((c->'permissions'->>k)::boolean,true)=false or coalesce((r.permissions->>k)::boolean,true)=false) then raise exception 'This action is disabled for this room.' using errcode='42501';end if;
 end if;
 return r;
end $$;
create or replace function public.ql_room_row_v1(i public.ql_room_items_v1,full_data boolean default false)
returns jsonb language sql stable as $$select (case when full_data then i.payload else i.payload-'_student_questions' end)||jsonb_build_object('id',i.id,'parent_id',i.parent_id,'_room_id',i.room_id,'_qlRevision',i.revision,'updated_at',i.updated_at)$$;
create or replace function public.ql_room_event_v1(rid uuid,act text,t text) returns void language sql security definer set search_path=public,pg_temp as $$
 insert into public.ql_room_events_v1(room_id,actor_id,actor_name,action,title) values(rid,auth.uid(),public.ql_room_name_v1(auth.uid()),act,left(t,200))
$$;

create or replace function public.ql_room_v1(p_action text,p_room uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=public.ql_room_auth_v1();a boolean:=public.ql__is_admin(u);c jsonb:=public.ql_room_config_v1();r public.ql_rooms_v1;
 i public.ql_room_items_v1;sv public.ql_room_saves_v1;v jsonb;qs jsonb;q jsonb;g jsonb;ans jsonb;detail jsonb:='[]';result jsonb;
 iid uuid;pid uuid;sid uuid;target uuid;manager boolean;kind text;cnt integer;idx integer;batch_count integer;pts numeric:=0;mx numeric:=0;pct numeric;pass numeric;session_name text;room_version text;
begin
 if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid request.';end if;
 if p_action='list' or p_action='admin_list' then
  if p_action='admin_list' and not a then raise exception 'Admin access required.' using errcode='42501';end if;
  return jsonb_build_object('config',c,'rooms',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from
   (select rr.*,public.ql_room_name_v1(rr.owner_id) owner_name,(select count(*) from public.ql_room_members_v1 mm where mm.room_id=rr.id and mm.status='active') members
    from public.ql_rooms_v1 rr where (p_action='admin_list' or rr.owner_id=u or exists(select 1 from public.ql_room_members_v1 m where m.room_id=rr.id and m.user_id=u and m.status='active')) )x),'[]'));
 end if;
 if p_action='admin_config' then
  if not a then raise exception 'Admin access required.' using errcode='42501';end if;
  v=c||p_data;
  if (v->>'max_rooms')::int not between 1 and 1000 or (v->>'max_members')::int not between 1 and 10000 or (v->>'max_items')::int not between 1 and 100000 or (v->>'max_questions')::int not between 1 and 10000 or (v->>'max_pdf_mb')::int not between 1 and 500 then raise exception 'Invalid room limits.';end if;
  insert into public.ql_site_settings(key,value) values('rooms',v) on conflict(key) do update set value=excluded.value;return v;
 end if;
 if p_action='create' then
  perform pg_advisory_xact_lock(hashtextextended('room-create:'||u::text,0));
  if not a and (not (c->>'enabled')::boolean or (select count(*) from public.ql_rooms_v1 where owner_id=u)>=(c->>'max_rooms')::int) then raise exception 'Room creation is not available or your room limit is reached.';end if;
  if length(btrim(coalesce(p_data->>'name',''))) not between 1 and 100 then raise exception 'Enter a room name (up to 100 characters).';end if;
  insert into public.ql_rooms_v1(owner_id,name,description,invite_code) values(u,btrim(p_data->>'name'),left(coalesce(p_data->>'description',''),1000),upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))) returning * into r;
  insert into public.ql_room_members_v1(room_id,user_id) values(r.id,u);perform public.ql_room_event_v1(r.id,'room_created',r.name);return to_jsonb(r);
 end if;
 if p_action='join' then
  select * into r from public.ql_rooms_v1 where invite_code=upper(btrim(p_data->>'code')) and status='active';
  if r.id is null or not (c->>'enabled')::boolean or not coalesce((r.permissions->>'join')::boolean,true) or not coalesce((c->'permissions'->>'join')::boolean,true) then raise exception 'Room code is invalid or this room is unavailable.';end if;
  perform pg_advisory_xact_lock(hashtextextended('room:'||r.id::text,0));
  select * into r from public.ql_rooms_v1 where id=r.id;
  if r.status<>'active' or not coalesce((r.permissions->>'join')::boolean,true) then raise exception 'This room is unavailable.';end if;
  if exists(select 1 from public.ql_room_members_v1 where room_id=r.id and user_id=u and status='blocked') then raise exception 'The owner has removed your access to this room.';end if;
  if not exists(select 1 from public.ql_room_members_v1 where room_id=r.id and user_id=u) and (select count(*) from public.ql_room_members_v1 where room_id=r.id and status='active')>=(c->>'max_members')::int then raise exception 'This room has reached its member limit.';end if;
  insert into public.ql_room_members_v1(room_id,user_id) values(r.id,u) on conflict do nothing;perform public.ql_room_event_v1(r.id,'member_joined',public.ql_room_name_v1(u));return to_jsonb(r);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('room:'||p_room::text,0));
 r:=public.ql_room_access_v1(p_room);manager:=a or r.owner_id=u;
 if p_action='open' then
  room_version:=md5(c::text)||':'||coalesce((select max(e.id)::text from public.ql_room_events_v1 e where e.room_id=p_room),'0');
  if p_data->>'since'=room_version then return jsonb_build_object('unchanged',true,'version',room_version);end if;
  return jsonb_build_object('version',room_version,'room',to_jsonb(r),'config',c,'manager',manager,
   'can_edit',a or ((r.status='active') and (r.owner_id=u or (not r.locked and (select can_edit from public.ql_room_members_v1 where room_id=p_room and user_id=u)))),
   'items',coalesce((select jsonb_agg(public.ql_room_row_v1(x) order by x.updated_at) from public.ql_room_items_v1 x where x.room_id=p_room),'[]'),
   'members',case when manager then coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('name',public.ql_room_name_v1(m.user_id))) from public.ql_room_members_v1 m where m.room_id=p_room),'[]') else '[]'::jsonb end);
 end if;
 if p_action in ('settings','member','activity') then
  if not manager then raise exception 'Only the room owner or website admin can do this.' using errcode='42501';end if;
  if p_action='activity' then return coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select * from public.ql_room_events_v1 where room_id=p_room order by id desc limit 200)e),'[]');end if;
  if p_action='member' then
   target:=(p_data->>'user_id')::uuid;if target=r.owner_id then raise exception 'The room owner cannot be restricted or removed.';end if;
   update public.ql_room_members_v1 set can_edit=coalesce((p_data->>'can_edit')::boolean,can_edit),status=case when p_data->>'status' in ('active','blocked') then p_data->>'status' else status end where room_id=p_room and user_id=target;
   perform public.ql_room_event_v1(p_room,'member_permissions_changed',public.ql_room_name_v1(target));return '{}';
  end if;
  if p_data ? 'status' and (p_data->>'status' not in ('active','closed','suspended') or (not a and (p_data->>'status'='suspended' or r.status='suspended'))) then raise exception 'Only the website admin can suspend or restore a suspended room.';end if;
  update public.ql_rooms_v1 set name=left(coalesce(nullif(btrim(p_data->>'name'),''),name),100),description=left(coalesce(p_data->>'description',description),1000),locked=coalesce((p_data->>'locked')::boolean,locked),
   permissions=coalesce(p_data->'permissions',permissions),status=coalesce(p_data->>'status',status),invite_code=case when p_data->>'reset_code'='true' then upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)) else invite_code end where id=p_room returning * into r;
  perform public.ql_room_event_v1(p_room,'room_settings_changed',r.name);return to_jsonb(r);
 end if;
 if p_action='leave' then
  if r.owner_id=u then raise exception 'The owner must close the room instead of leaving.';end if;
  delete from public.ql_room_members_v1 where room_id=p_room and user_id=u;perform public.ql_room_event_v1(p_room,'member_left',public.ql_room_name_v1(u));return '{}';
 end if;
 iid:=nullif(p_data->>'id','')::uuid;
 if p_action='insert' then
  kind:=p_data->'payload'->>'kind';perform public.ql_room_access_v1(p_room,true,kind);
  if coalesce(kind,'') not in ('folder','pdf','link','quiz') or iid is null then raise exception 'Invalid room item.';end if;
  if (select count(*) from public.ql_room_items_v1 where room_id=p_room)>=(c->>'max_items')::int then raise exception 'This room has reached its item limit.';end if;
  v=p_data->'payload';pid:=nullif(v->>'parent_id','')::uuid;
  if pid is not null and not exists(select 1 from public.ql_room_items_v1 where id=pid and room_id=p_room and payload->>'kind'='folder') then raise exception 'Destination folder not found in this room.';end if;
  if kind='pdf' and (coalesce((v->>'file_size')::bigint,0)>(c->>'max_pdf_mb')::bigint*1048576 or not (coalesce(v->>'storage_path','') like 'students/'||u::text||'/%' or exists(select 1 from public.ql_room_items_v1 x where x.room_id=p_room and x.payload->>'kind'='pdf' and x.payload->>'storage_path'=v->>'storage_path'))) then raise exception 'PDF size or storage path is not allowed.';end if;
  v:=v-'_room_id'-'_qlRevision'-'_student_questions'-'id';if kind='quiz' then v:=v||'{"_student_questions":[]}'::jsonb;end if;
  insert into public.ql_room_items_v1(room_id,id,parent_id,creator_id,payload) values(p_room,iid,pid,u,v) returning * into i;
  perform public.ql_room_event_v1(p_room,'item_created',v->>'title');return public.ql_room_row_v1(i,true);
 end if;
 select * into i from public.ql_room_items_v1 where room_id=p_room and id=iid;
 if i.id is null then raise exception 'Room item not found.' using errcode='P0002';end if;
 if p_action in ('quiz_take','quiz_tools','quiz_history','quiz_submit','save_begin','save_part','save_finish') and i.payload->>'kind'<>'quiz' then raise exception 'This item is not a quiz.';end if;
 if p_action in ('item_get','quiz_take','copy_get') then
  if p_action='copy_get' and not a and (not coalesce((c->'permissions'->>'save_copy')::boolean,true) or not coalesce((r.permissions->>'save_copy')::boolean,true)) then raise exception 'Saving a room copy is disabled by its owner or the website admin.';end if;
  result:=public.ql_room_row_v1(i,true);
  if p_action='quiz_take' then result:=result||jsonb_build_object('quiz_settings',coalesce(i.payload->'quiz_settings','{}')||coalesce((select settings from public.ql_room_preferences_v1 where room_id=p_room and item_id=iid and user_id=u),'{}'));end if;return result;
 end if;
 if p_action='quiz_history' then return coalesce((select jsonb_agg(aa.result order by aa.created_at desc) from public.ql_room_attempts_v1 aa where aa.room_id=p_room and aa.item_id=iid and aa.user_id=u),'[]');end if;
 if p_action='quiz_tools' then
  select coalesce(jsonb_object_agg(key,value),'{}') into v from jsonb_each(p_data->'settings') where key in ('exam_ui','layout','show_answer_immediately','shuffle','shuffle_mode','session_overrides','auto_advance');
  insert into public.ql_room_preferences_v1 as t(room_id,item_id,user_id,settings) values(p_room,iid,u,v) on conflict(room_id,item_id,user_id) do update set settings=t.settings||excluded.settings;
  return public.ql_room_row_v1(i)||jsonb_build_object('quiz_settings',coalesce(i.payload->'quiz_settings','{}')||(select settings from public.ql_room_preferences_v1 where room_id=p_room and item_id=iid and user_id=u));
 end if;
 if p_action='quiz_submit' then
  sid:=(p_data->>'attempt_id')::uuid;select aa.result into result from public.ql_room_attempts_v1 aa where aa.user_id=u and aa.id=sid and aa.room_id=p_room and aa.item_id=iid;if result is not null then return result;end if;
  if (p_data->>'revision')::bigint is distinct from i.revision then raise exception 'QL_CONFLICT: This room quiz changed. Reopen it before submitting.';end if;
  session_name:=nullif(p_data->>'session_name','');ans:=p_data->'answers';
  select coalesce(jsonb_agg(value),'[]') into qs from jsonb_array_elements(i.payload->'_student_questions') where session_name is null or case when jsonb_typeof(value->'session_labels')='array' then (value->'session_labels') ? session_name else value->>'session_label'=session_name end;
  if jsonb_typeof(ans) is distinct from 'array' or jsonb_array_length(qs)=0 or jsonb_array_length(ans)<>jsonb_array_length(qs) or (select count(distinct value->>'question_id') from jsonb_array_elements(ans))<>jsonb_array_length(qs) or exists(select 1 from jsonb_array_elements(ans) x where not exists(select 1 from jsonb_array_elements(qs) y where y.value->>'id'=x.value->>'question_id')) then raise exception 'Submit every question in this section, including unanswered questions.';end if;
  select jsonb_object_agg(value->>'question_id',value->'given_answer') into ans from jsonb_array_elements(ans);
  for q in select value from jsonb_array_elements(qs) loop
   g:=public.ql__dash_quiz_grade_v1(q,coalesce(ans->(q->>'id'),'null'));mx:=mx+(g->>'points')::numeric;if (g->>'correct')::boolean then pts:=pts+(g->>'points')::numeric;end if;
   detail:=detail||jsonb_build_array((g-'points')||jsonb_build_object('question_id',q->>'id','given',ans->(q->>'id')));
  end loop;
  pct:=case when mx>0 then round(pts/mx*100,1) else 0 end;pass:=(i.payload->'quiz_settings'->>'pass_percent')::numeric;
  result:=jsonb_build_object('id',sid,'attempt_id',sid,'user_id',u,'taker_name',public.ql_room_name_v1(u),'taker_identifier','auth:'||u::text,'identity_mode','account','is_owner',r.owner_id=u,'score',pts,'max_score',mx,'percent',pct,'passed',case when pass is null then null else pct>=pass end,'detail',detail,'started_at',p_data->>'started_at','submitted_at',now(),'session_name',session_name);
  insert into public.ql_room_attempts_v1(room_id,item_id,user_id,id,result) values(p_room,iid,u,sid,result);return result;
 end if;
 perform public.ql_room_access_v1(p_room,true,case when p_action='delete' or (p_action='patch' and p_data->'patch' ? 'is_trashed') then 'trash' else 'edit' end);
 if p_action='patch' then
  if p_data ? 'revision' and (p_data->>'revision')::bigint is distinct from i.revision then raise exception 'QL_CONFLICT: Another room member changed this item. Reopen it.';end if;
  select coalesce(jsonb_object_agg(key,value),'{}') into v from jsonb_each(p_data->'patch') where key in ('title','description','url','color','icon','parent_id','is_trashed','original_parent_id','position');
  pid:=case when v ? 'parent_id' then nullif(v->>'parent_id','')::uuid else i.parent_id end;
  if pid is not null and (pid=iid or not exists(select 1 from public.ql_room_items_v1 where id=pid and room_id=p_room and payload->>'kind'='folder') or exists(with recursive children as(select id from public.ql_room_items_v1 where parent_id=iid union all select x.id from public.ql_room_items_v1 x join children cc on x.parent_id=cc.id)select 1 from children where id=pid)) then raise exception 'Invalid destination folder.';end if;
  update public.ql_room_items_v1 set payload=payload||v,parent_id=pid,revision=revision+1,updated_at=now() where id=iid returning * into i;
  perform public.ql_room_event_v1(p_room,'item_updated',i.payload->>'title');return public.ql_room_row_v1(i);
 end if;
 if p_action='delete' then
  if not manager and i.creator_id<>u and coalesce((i.payload->>'is_trashed')::boolean,false)=false then raise exception 'Move the item to Trash first.';end if;
  perform public.ql_room_event_v1(p_room,'item_deleted',i.payload->>'title');delete from public.ql_room_items_v1 where id=iid;return '{}';
 end if;
 if p_action='save_begin' then
  delete from public.ql_room_saves_v1 where id in (select id from public.ql_room_saves_v1 where user_id=u and created_at<now()-interval '1 day' limit 200);
  sid:=(p_data->>'save_id')::uuid;select * into sv from public.ql_room_saves_v1 where id=sid;
  if sv.id is not null then
   if sv.user_id<>u or sv.room_id<>p_room or sv.item_id<>iid or sv.fingerprint is distinct from p_data->>'fingerprint' or sv.question_count is distinct from (p_data->>'count')::int or sv.settings is distinct from p_data->'settings' or (p_data ? 'parts' and sv.part_count is distinct from (p_data->>'parts')::int) then raise exception 'Save identifier belongs to different content.';end if;return coalesce(sv.result,'{}');
  end if;
  if (p_data->>'revision')::bigint is distinct from i.revision then raise exception 'QL_CONFLICT: Another room member edited this quiz. Your draft is preserved.';end if;
  if (select count(*) from public.ql_room_saves_v1 ss where ss.user_id=u and ss.result is null)>=8 then raise exception 'Too many unfinished saves. Finish an existing save or try again later.';end if;
  if jsonb_typeof(p_data->'settings') is distinct from 'object' or octet_length((p_data->'settings')::text)>65536 or length(coalesce(p_data->>'fingerprint','')) not between 1 and 128 then raise exception 'Invalid quiz settings or fingerprint.';end if;
  cnt:=(p_data->>'count')::int;if cnt is null or cnt not between 0 and (c->>'max_questions')::int then raise exception 'Room question limit exceeded.';end if;
  batch_count:=coalesce((p_data->>'parts')::int,greatest(1,ceil(cnt/200.0)::int));if batch_count not between greatest(1,ceil(cnt/200.0)::int) and greatest(1,cnt) then raise exception 'Invalid question batch count.';end if;
  insert into public.ql_room_saves_v1(id,room_id,item_id,user_id,base_revision,fingerprint,question_count,part_count,settings) values(sid,p_room,iid,u,i.revision,p_data->>'fingerprint',cnt,batch_count,p_data->'settings');return '{}';
 end if;
 select * into sv from public.ql_room_saves_v1 where id=(p_data->>'save_id')::uuid and user_id=u and room_id=p_room and item_id=iid;
 if sv.id is null then raise exception 'Save session not found.';end if;
 if sv.result is not null then return sv.result;end if;
 if p_action='save_part' then
  idx:=(p_data->>'part')::int;v:=p_data->'questions';
  if idx is null or idx<0 or idx>=sv.part_count or jsonb_typeof(v) is distinct from 'array' or octet_length(v::text)>8388608 or jsonb_array_length(v)>200 then raise exception 'Invalid question batch.';end if;
  if sv.parts ? idx::text then if sv.parts->(idx::text)<>v then raise exception 'Question batch changed during retry.';end if;return '{}';end if;
  if coalesce((select sum(octet_length(parts::text)) from public.ql_room_saves_v1 where user_id=u),0)+octet_length(v::text)>67108864 then raise exception 'Unfinished save storage limit reached.';end if;
  update public.ql_room_saves_v1 set parts=jsonb_set(parts,array[idx::text],v) where id=sv.id;return '{}';
 end if;
 if p_action='save_finish' then
  if i.revision<>sv.base_revision then raise exception 'QL_CONFLICT: Another room member edited this quiz. Your draft is preserved.';end if;
  if (select count(*) from jsonb_object_keys(sv.parts))<>sv.part_count then raise exception 'Missing question batches.';end if;
  select coalesce(jsonb_agg(q.value order by p.key::int,q.ord),'[]') into qs from jsonb_each(sv.parts) p cross join lateral jsonb_array_elements(p.value) with ordinality q(value,ord);
  if jsonb_array_length(qs)<>sv.question_count or (select count(distinct value->>'id') from jsonb_array_elements(qs) where coalesce(value->>'id','')<>'')<>sv.question_count then raise exception 'Missing or duplicate question identifiers.';end if;
  update public.ql_room_items_v1 set payload=payload||jsonb_build_object('_student_questions',qs,'quiz_settings',sv.settings||jsonb_build_object('question_count',sv.question_count)),revision=revision+1,updated_at=now() where id=iid returning * into i;
  result:=public.ql_room_row_v1(i);update public.ql_room_saves_v1 set result=public.ql_room_row_v1(i),parts='{}' where id=sv.id;
  perform public.ql_room_event_v1(p_room,'quiz_saved',i.payload->>'title');return result;
 end if;
 raise exception 'Unknown room action.';
end $$;

create or replace function public.ql_room_storage_read_v1(object_name text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and ((public.ql_room_config_v1()->>'enabled')::boolean or public.ql__is_admin(auth.uid())) and not exists(select 1 from public.ql_subscriptions where user_id=auth.uid() and status='suspended') and exists(
 select 1 from public.ql_room_items_v1 i join public.ql_rooms_v1 r on r.id=i.room_id
 where i.payload->>'kind'='pdf' and i.payload->>'storage_path'=object_name and (public.ql__is_admin(auth.uid()) or ((r.status='active' or (r.status='closed' and r.owner_id=auth.uid())) and (r.owner_id=auth.uid() or exists(select 1 from public.ql_room_members_v1 m where m.room_id=r.id and m.user_id=auth.uid() and m.status='active')))))
$$;
do $$begin
 if to_regclass('storage.objects') is not null then
  execute 'drop policy if exists "Room members read shared PDFs v1" on storage.objects';
  execute 'create policy "Room members read shared PDFs v1" on storage.objects for select to authenticated using(bucket_id=''library-pdfs'' and public.ql_room_storage_read_v1(name))';
 end if;
end $$;
revoke all on function public.ql_room_name_v1(uuid),public.ql_room_config_v1(),public.ql_room_auth_v1(),public.ql_room_access_v1(uuid,boolean,text),public.ql_room_row_v1(public.ql_room_items_v1,boolean),public.ql_room_event_v1(uuid,text,text) from public,anon,authenticated;
revoke all on function public.ql_room_v1(text,uuid,jsonb),public.ql_room_storage_read_v1(text) from public,anon;
grant execute on function public.ql_room_v1(text,uuid,jsonb),public.ql_room_storage_read_v1(text) to authenticated;
notify pgrst,'reload schema';commit;
select 'Shared Rooms update complete' as result;
