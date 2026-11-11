-- Rooms controls (run after shared_rooms_v1.sql and dashboard.sql; safe to run again).
-- 1. Website Control → Rooms: every room button follows Everyone / By plan / Lock / Hidden
--    for the person doing it (their own plan), checked here on the server:
--    nav_rooms (all of Rooms), room_create, room_join, room_pdf, room_link, room_folder,
--    room_quiz, room_edit, room_trash, room_save_copy. The website admin is never blocked.
-- 2. The old Admin → Rooms "Allowed room actions" ticks move to Website Control once:
--    a tick that was off becomes "Hidden" (only if that switch has no choice yet).
-- 3. "Who can change this?" per item: everyone in the room / only the creator /
--    the creator and chosen members, plus "others can save a copy". The room owner
--    (and the website admin) can always change or remove anything.
--    Room settings (permissions): item_default ('everyone' | 'creator') for new items and
--    creator_choice (false = only the owner sets item access).
-- Items made before this file keep today's behaviour: everyone in the room can edit them.
begin;

alter table public.ql_room_items_v1 add column if not exists edit_mode text not null default 'everyone';
alter table public.ql_room_items_v1 add column if not exists editors uuid[] not null default '{}';
alter table public.ql_room_items_v1 add column if not exists allow_copy boolean not null default true;
do $$begin
 if not exists(select 1 from pg_constraint where conname='ql_room_items_edit_mode_v1') then
  alter table public.ql_room_items_v1 add constraint ql_room_items_edit_mode_v1 check (edit_mode in ('everyone','creator','chosen'));
 end if;
end $$;

-- Old admin ticks → Website Control (one time; a later run finds nothing to move).
do $$
declare old jsonb;f jsonb;nf jsonb;k text;
 map constant jsonb:='{"pdf":"room_pdf","link":"room_link","folder":"room_folder","quiz":"room_quiz","edit":"room_edit","trash":"room_trash","join":"room_join","save_copy":"room_save_copy"}';
begin
 select value->'permissions' into old from public.ql_site_settings where key='rooms';
 if old is null or jsonb_typeof(old)<>'object' then return;end if;
 select value into f from public.ql_site_settings where key='features';
 f:=case when jsonb_typeof(f)='object' then f else '{}'::jsonb end;nf:=f;
 for k in select jsonb_object_keys(map) loop
  if old->>k='false' and not (nf ? (map->>k)) then nf:=nf||jsonb_build_object(map->>k,'off');end if;
 end loop;
 if nf is distinct from f then
  insert into public.ql_site_settings(key,value) values('features',nf) on conflict(key) do update set value=excluded.value;
 end if;
 update public.ql_site_settings set value=value-'permissions' where key='rooms';
end $$;

-- Website Control switch for this person (admin always allowed).
create or replace function public.ql_room_feat_v1(u uuid,k text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.ql__is_admin(u) or public.ql__feature_ok(u,k)
$$;
create or replace function public.ql_room_need_v1(u uuid,k text) returns void
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.ql_room_feat_v1(u,k) then
  raise exception '%',case k
   when 'nav_rooms' then 'Rooms is not available for your account right now.'
   when 'room_create' then 'Creating rooms is not available on your plan.'
   when 'room_join' then 'Joining rooms is not available on your plan.'
   when 'room_pdf' then 'Uploading PDFs in rooms is not available on your plan.'
   when 'room_link' then 'Adding quiz links in rooms is not available on your plan.'
   when 'room_folder' then 'Creating folders in rooms is not available on your plan.'
   when 'room_quiz' then 'Creating quizzes in rooms is not available on your plan.'
   when 'room_edit' then 'Editing room content is not available on your plan.'
   when 'room_trash' then 'Moving room content to Trash is not available on your plan.'
   when 'room_save_copy' then 'Saving room copies is not available on your plan.'
   else 'This Rooms action is not available on your plan.' end using errcode='42501';
 end if;
end $$;

-- Rooms as a whole follows Website Control → Rooms button (nav_rooms).
create or replace function public.ql_room_auth_v1() returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'Sign in to use Rooms.' using errcode='28000';end if;
 if exists(select 1 from public.ql_subscriptions where user_id=auth.uid() and status='suspended') then raise exception 'This account is suspended.';end if;
 perform public.ql_room_need_v1(auth.uid(),'nav_rooms');
 return auth.uid();
end $$;

-- Can this person change (edit, move, trash, delete, save questions of) this item?
create or replace function public.ql_room_item_ok_v1(i public.ql_room_items_v1,r public.ql_rooms_v1,u uuid,a boolean)
returns boolean language sql stable as $$
 select coalesce(a,false) or r.owner_id=u or coalesce(i.creator_id=u,false) or i.edit_mode='everyone' or (i.edit_mode='chosen' and coalesce(u=any(i.editors),false))
$$;
-- May this person choose "Who can change this?" for the item?
create or replace function public.ql_room_item_access_ok_v1(i public.ql_room_items_v1,r public.ql_rooms_v1,u uuid,a boolean)
returns boolean language sql stable as $$
 select coalesce(a,false) or r.owner_id=u or (coalesce(i.creator_id=u,false) and coalesce((r.permissions->>'creator_choice')::boolean,true))
$$;
-- The item as the app sees it, with this person's rights.
create or replace function public.ql_room_row_u_v1(i public.ql_room_items_v1,r public.ql_rooms_v1,u uuid,a boolean,full_data boolean default false)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select public.ql_room_row_v1(i,full_data)||jsonb_build_object(
  '_creator_id',i.creator_id,'_creator_name',public.ql_room_name_v1(i.creator_id),
  '_edit_mode',i.edit_mode,'_editor_count',coalesce(array_length(i.editors,1),0),'_allow_copy',i.allow_copy,
  '_can_edit',public.ql_room_item_ok_v1(i,r,u,a),'_can_access',public.ql_room_item_access_ok_v1(i,r,u,a),
  '_can_copy',coalesce(a,false) or r.owner_id=u or coalesce(i.creator_id=u,false) or i.allow_copy)
$$;

create or replace function public.ql_room_v1(p_action text,p_room uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=public.ql_room_auth_v1();a boolean:=public.ql__is_admin(u);c jsonb:=public.ql_room_config_v1();r public.ql_rooms_v1;
 i public.ql_room_items_v1;sv public.ql_room_saves_v1;v jsonb;qs jsonb;q jsonb;g jsonb;ans jsonb;detail jsonb:='[]';result jsonb;
 iid uuid;pid uuid;sid uuid;target uuid;manager boolean;kind text;cnt integer;idx integer;batch_count integer;pts numeric:=0;mx numeric:=0;pct numeric;pass numeric;session_name text;room_version text;
 mode text;eds uuid[];
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
  if coalesce((v->>'max_rooms')::int,0) not between 1 and 1000 or coalesce((v->>'max_members')::int,0) not between 1 and 10000 or coalesce((v->>'max_items')::int,0) not between 1 and 100000 or coalesce((v->>'max_questions')::int,0) not between 1 and 10000 or coalesce((v->>'max_pdf_mb')::int,0) not between 1 and 500 then raise exception 'Invalid room limits.';end if;
  insert into public.ql_site_settings(key,value) values('rooms',v) on conflict(key) do update set value=excluded.value;return v;
 end if;
 if p_action='create' then
  perform public.ql_room_need_v1(u,'room_create');
  perform pg_advisory_xact_lock(hashtextextended('room-create:'||u::text,0));
  if not a and (not (c->>'enabled')::boolean or (select count(*) from public.ql_rooms_v1 where owner_id=u)>=(c->>'max_rooms')::int) then raise exception 'Room creation is not available or your room limit is reached.';end if;
  if length(btrim(coalesce(p_data->>'name',''))) not between 1 and 100 then raise exception 'Enter a room name (up to 100 characters).';end if;
  insert into public.ql_rooms_v1(owner_id,name,description,invite_code) values(u,btrim(p_data->>'name'),left(coalesce(p_data->>'description',''),1000),upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))) returning * into r;
  insert into public.ql_room_members_v1(room_id,user_id) values(r.id,u);perform public.ql_room_event_v1(r.id,'room_created',r.name);return to_jsonb(r);
 end if;
 if p_action='join' then
  perform public.ql_room_need_v1(u,'room_join');
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
  room_version:=md5(c::text||coalesce((select value::text from public.ql_site_settings where key='features'),''))||':'||coalesce((select max(e.id)::text from public.ql_room_events_v1 e where e.room_id=p_room),'0');
  if p_data->>'since'=room_version then return jsonb_build_object('unchanged',true,'version',room_version);end if;
  return jsonb_build_object('version',room_version,'room',to_jsonb(r),'config',c,'manager',manager,'me',u,
   'can_edit',a or ((r.status='active') and (r.owner_id=u or (not r.locked and (select can_edit from public.ql_room_members_v1 where room_id=p_room and user_id=u)))),
   'items',coalesce((select jsonb_agg(public.ql_room_row_u_v1(x,r,u,a) order by x.updated_at) from public.ql_room_items_v1 x where x.room_id=p_room),'[]'),
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
  if p_data ? 'permissions' and (jsonb_typeof(p_data->'permissions') is distinct from 'object' or coalesce(p_data->'permissions'->>'item_default','everyone') not in ('everyone','creator')) then raise exception 'Invalid room settings.';end if;
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
  kind:=p_data->'payload'->>'kind';
  if coalesce(kind,'') not in ('folder','pdf','link','quiz') or iid is null then raise exception 'Invalid room item.';end if;
  perform public.ql_room_need_v1(u,'room_'||kind);
  perform public.ql_room_access_v1(p_room,true,kind);
  if (select count(*) from public.ql_room_items_v1 where room_id=p_room)>=(c->>'max_items')::int then raise exception 'This room has reached its item limit.';end if;
  v=p_data->'payload';pid:=nullif(v->>'parent_id','')::uuid;
  if pid is not null and not exists(select 1 from public.ql_room_items_v1 where id=pid and room_id=p_room and payload->>'kind'='folder') then raise exception 'Destination folder not found in this room.';end if;
  if kind='pdf' and (coalesce((v->>'file_size')::bigint,0)>(c->>'max_pdf_mb')::bigint*1048576 or not (coalesce(v->>'storage_path','') like 'students/'||u::text||'/%' or exists(select 1 from public.ql_room_items_v1 x where x.room_id=p_room and x.payload->>'kind'='pdf' and x.payload->>'storage_path'=v->>'storage_path'))) then raise exception 'PDF size or storage path is not allowed.';end if;
  v:=v-'_room_id'-'_qlRevision'-'_student_questions'-'id'-'_creator_id'-'_creator_name'-'_edit_mode'-'_editor_count'-'_allow_copy'-'_can_edit'-'_can_access'-'_can_copy';
  if kind='quiz' then v:=v||'{"_student_questions":[]}'::jsonb;end if;
  insert into public.ql_room_items_v1(room_id,id,parent_id,creator_id,payload,edit_mode) values(p_room,iid,pid,u,v,case when r.permissions->>'item_default'='creator' then 'creator' else 'everyone' end) returning * into i;
  perform public.ql_room_event_v1(p_room,'item_created',v->>'title');return public.ql_room_row_u_v1(i,r,u,a,true);
 end if;
 select * into i from public.ql_room_items_v1 where room_id=p_room and id=iid;
 if i.id is null then raise exception 'Room item not found.' using errcode='P0002';end if;
 if p_action in ('quiz_take','quiz_tools','quiz_history','quiz_submit','save_begin','save_part','save_finish') and i.payload->>'kind'<>'quiz' then raise exception 'This item is not a quiz.';end if;
 if p_action in ('item_get','quiz_take','copy_get') then
  if p_action='copy_get' then
   perform public.ql_room_need_v1(u,'room_save_copy');
   if not a and (not coalesce((c->'permissions'->>'save_copy')::boolean,true) or not coalesce((r.permissions->>'save_copy')::boolean,true)) then raise exception 'Saving a room copy is disabled by its owner or the website admin.';end if;
   if not (a or r.owner_id=u or coalesce(i.creator_id=u,false) or i.allow_copy) then raise exception 'The creator has turned off copies of this item.' using errcode='42501';end if;
  end if;
  result:=public.ql_room_row_u_v1(i,r,u,a,true);
  if p_action='quiz_take' then result:=result||jsonb_build_object('quiz_settings',coalesce(i.payload->'quiz_settings','{}')||coalesce((select settings from public.ql_room_preferences_v1 where room_id=p_room and item_id=iid and user_id=u),'{}'));end if;return result;
 end if;
 if p_action='quiz_history' then return coalesce((select jsonb_agg(aa.result order by aa.created_at desc) from public.ql_room_attempts_v1 aa where aa.room_id=p_room and aa.item_id=iid and aa.user_id=u),'[]');end if;
 if p_action='quiz_tools' then
  select coalesce(jsonb_object_agg(key,value),'{}') into v from jsonb_each(p_data->'settings') where key in ('exam_ui','layout','show_answer_immediately','shuffle','shuffle_mode','session_overrides','auto_advance');
  insert into public.ql_room_preferences_v1 as t(room_id,item_id,user_id,settings) values(p_room,iid,u,v) on conflict(room_id,item_id,user_id) do update set settings=t.settings||excluded.settings;
  return public.ql_room_row_u_v1(i,r,u,a)||jsonb_build_object('quiz_settings',coalesce(i.payload->'quiz_settings','{}')||(select settings from public.ql_room_preferences_v1 where room_id=p_room and item_id=iid and user_id=u));
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
 if p_action in ('item_access_get','item_access') then
  if not public.ql_room_item_access_ok_v1(i,r,u,a) then raise exception 'Only the creator or the room owner can choose who changes this item.' using errcode='42501';end if;
  if p_action='item_access_get' then
   return jsonb_build_object('mode',i.edit_mode,'editors',to_jsonb(i.editors),'allow_copy',i.allow_copy,'creator_id',i.creator_id,'creator_name',public.ql_room_name_v1(i.creator_id),'owner_id',r.owner_id,'owner_name',public.ql_room_name_v1(r.owner_id),
    'members',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',public.ql_room_name_v1(m.user_id)) order by public.ql_room_name_v1(m.user_id)) from public.ql_room_members_v1 m where m.room_id=p_room and m.status='active' and m.user_id is distinct from i.creator_id and m.user_id<>r.owner_id),'[]'));
  end if;
  if r.status<>'active' and not a then raise exception 'This room is closed.';end if;
  mode:=coalesce(p_data->>'mode',i.edit_mode);
  if mode not in ('everyone','creator','chosen') then raise exception 'Invalid choice.';end if;
  if jsonb_typeof(coalesce(p_data->'editors','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_data->'editors','[]'))>100 then raise exception 'Choose up to 100 people.';end if;
  select coalesce(array_agg(distinct m.user_id),'{}') into eds from public.ql_room_members_v1 m
   where m.room_id=p_room and m.status='active' and m.user_id::text in (select jsonb_array_elements_text(coalesce(p_data->'editors','[]')));
  if mode<>'chosen' then eds:='{}';end if;
  update public.ql_room_items_v1 set edit_mode=mode,editors=eds,allow_copy=coalesce((p_data->>'allow_copy')::boolean,allow_copy) where id=iid and room_id=p_room returning * into i;
  perform public.ql_room_event_v1(p_room,'item_access_changed',i.payload->>'title');return public.ql_room_row_u_v1(i,r,u,a);
 end if;
 perform public.ql_room_access_v1(p_room,true,case when p_action='delete' or (p_action='patch' and p_data->'patch' ? 'is_trashed') then 'trash' else 'edit' end);
 perform public.ql_room_need_v1(u,case when p_action='delete' or (p_action='patch' and p_data->'patch' ? 'is_trashed') then 'room_trash' else 'room_edit' end);
 if not public.ql_room_item_ok_v1(i,r,u,a) then raise exception 'Only % (and the room owner) can change this item.',coalesce(public.ql_room_name_v1(i.creator_id),'its creator') using errcode='42501';end if;
 if p_action='patch' then
  if p_data ? 'revision' and (p_data->>'revision')::bigint is distinct from i.revision then raise exception 'QL_CONFLICT: Another room member changed this item. Reopen it.';end if;
  select coalesce(jsonb_object_agg(key,value),'{}') into v from jsonb_each(p_data->'patch') where key in ('title','description','url','color','icon','parent_id','is_trashed','original_parent_id','position');
  pid:=case when v ? 'parent_id' then nullif(v->>'parent_id','')::uuid else i.parent_id end;
  if pid is not null and (pid=iid or not exists(select 1 from public.ql_room_items_v1 where id=pid and room_id=p_room and payload->>'kind'='folder') or exists(with recursive children as(select id from public.ql_room_items_v1 where parent_id=iid union all select x.id from public.ql_room_items_v1 x join children cc on x.parent_id=cc.id)select 1 from children where id=pid)) then raise exception 'Invalid destination folder.';end if;
  update public.ql_room_items_v1 set payload=payload||v,parent_id=pid,revision=revision+1,updated_at=now() where id=iid returning * into i;
  perform public.ql_room_event_v1(p_room,case when v ? 'is_trashed' then case when (v->>'is_trashed')::boolean then 'item_trashed' else 'item_restored' end when v ? 'parent_id' then 'item_moved' else 'item_updated' end,i.payload->>'title');return public.ql_room_row_u_v1(i,r,u,a);
 end if;
 if p_action='delete' then
  if not manager and i.creator_id is distinct from u and coalesce((i.payload->>'is_trashed')::boolean,false)=false then raise exception 'Move the item to Trash first.';end if;
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
  result:=public.ql_room_row_u_v1(i,r,u,a);update public.ql_room_saves_v1 set result=public.ql_room_row_u_v1(i,r,u,a),parts='{}' where id=sv.id;
  perform public.ql_room_event_v1(p_room,'quiz_saved',i.payload->>'title');return result;
 end if;
 raise exception 'Unknown room action.';
end $$;

revoke all on function public.ql_room_feat_v1(uuid,text),public.ql_room_need_v1(uuid,text),public.ql_room_auth_v1(),
 public.ql_room_item_ok_v1(public.ql_room_items_v1,public.ql_rooms_v1,uuid,boolean),public.ql_room_item_access_ok_v1(public.ql_room_items_v1,public.ql_rooms_v1,uuid,boolean),
 public.ql_room_row_u_v1(public.ql_room_items_v1,public.ql_rooms_v1,uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function public.ql_room_v1(text,uuid,jsonb) from public,anon;
grant execute on function public.ql_room_v1(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';commit;
select 'Rooms controls update complete' as result;
