-- Rooms look (run after rooms_controls_v1.sql; safe to run again).
-- Room cover (theme colour + emoji), item dates, pins, "since your last visit",
-- "studying now", NEW badges, opened markers and quiz stats (classmates who took it,
-- your best score). Everything goes through the new RPC ql_room_look_v1; ql_room_v1 is unchanged.
begin;

alter table public.ql_rooms_v1 add column if not exists theme text not null default 'violet';
alter table public.ql_rooms_v1 add column if not exists emoji text not null default '';
alter table public.ql_room_items_v1 add column if not exists created_at timestamptz;
alter table public.ql_room_items_v1 add column if not exists pinned_at timestamptz;
-- Items made before this file: their last change is the best date we have.
update public.ql_room_items_v1 set created_at=updated_at where created_at is null;
alter table public.ql_room_items_v1 alter column created_at set default now();
alter table public.ql_room_items_v1 alter column created_at set not null;
do $$begin
 if not exists(select 1 from pg_constraint where conname='ql_rooms_theme_v1') then
  alter table public.ql_rooms_v1 add constraint ql_rooms_theme_v1 check (theme in ('violet','ocean','sunset','forest','rose','midnight'));
 end if;
 if not exists(select 1 from pg_constraint where conname='ql_rooms_emoji_v1') then
  alter table public.ql_rooms_v1 add constraint ql_rooms_emoji_v1 check (char_length(emoji)<=16);
 end if;
end $$;
create index if not exists ql_room_items_created_v1 on public.ql_room_items_v1(room_id,created_at desc);

-- When each person last looked at the room (prev_seen_at = the visit before this one).
create table if not exists public.ql_room_visits_v1(
 room_id uuid references public.ql_rooms_v1 on delete cascade,user_id uuid references auth.users on delete cascade,
 last_seen_at timestamptz not null default now(),prev_seen_at timestamptz,active_at timestamptz not null default now(),
 primary key(room_id,user_id)
);
-- When each person opened an item (NEW badge goes away; "Opened 2 days ago").
create table if not exists public.ql_room_opens_v1(
 room_id uuid references public.ql_rooms_v1 on delete cascade,item_id uuid references public.ql_room_items_v1 on delete cascade,
 user_id uuid references auth.users on delete cascade,opened_at timestamptz not null default now(),primary key(item_id,user_id)
);
create index if not exists ql_room_opens_user_v1 on public.ql_room_opens_v1(room_id,user_id);
create index if not exists ql_room_attempts_week_v1 on public.ql_room_attempts_v1(room_id,created_at);
do $$declare t text;begin
 foreach t in array array['ql_room_visits_v1','ql_room_opens_v1'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
end $$;

create or replace function public.ql_room_look_v1(p_action text,p_room uuid,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=public.ql_room_auth_v1();a boolean:=public.ql__is_admin(u);r public.ql_rooms_v1;manager boolean;
 iid uuid;prev timestamptz;vis public.ql_room_visits_v1;t text;
begin
 if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Invalid request.';end if;
 r:=public.ql_room_access_v1(p_room);manager:=a or r.owner_id=u;
 iid:=nullif(p_data->>'id','')::uuid;
 if p_action='summary' then
  -- Heartbeat (every refresh): a gap of 30+ minutes starts a new visit.
  select * into vis from public.ql_room_visits_v1 where room_id=p_room and user_id=u;
  if vis.user_id is null then
   insert into public.ql_room_visits_v1(room_id,user_id,last_seen_at,prev_seen_at,active_at)
    values(p_room,u,now(),(select joined_at from public.ql_room_members_v1 where room_id=p_room and user_id=u),now()) on conflict do nothing;
   prev:=(select joined_at from public.ql_room_members_v1 where room_id=p_room and user_id=u);
  else
   prev:=case when vis.last_seen_at<now()-interval '30 minutes' then vis.last_seen_at else vis.prev_seen_at end;
   update public.ql_room_visits_v1 set prev_seen_at=prev,last_seen_at=now(),active_at=now() where room_id=p_room and user_id=u;
  end if;
  return jsonb_build_object(
   'theme',r.theme,'emoji',r.emoji,'since',prev,
   'stats',jsonb_build_object(
    'members',(select count(*) from public.ql_room_members_v1 m where m.room_id=p_room and m.status='active'),
    'online',(select count(*) from public.ql_room_visits_v1 v join public.ql_room_members_v1 m on m.room_id=v.room_id and m.user_id=v.user_id and m.status='active' where v.room_id=p_room and v.active_at>now()-interval '2 minutes'),
    'quizzes',(select count(*) from public.ql_room_items_v1 i where i.room_id=p_room and i.payload->>'kind'='quiz' and coalesce((i.payload->>'is_trashed')::boolean,false)=false),
    'questions',(select coalesce(sum(coalesce((i.payload->'quiz_settings'->>'question_count')::int,0)),0) from public.ql_room_items_v1 i where i.room_id=p_room and i.payload->>'kind'='quiz' and coalesce((i.payload->>'is_trashed')::boolean,false)=false),
    'taken_week',(select count(*) from public.ql_room_attempts_v1 x where x.room_id=p_room and x.created_at>now()-interval '7 days')),
   'people',coalesce((select jsonb_agg(p order by (p->>'online')::boolean desc,p->>'name') from (
     select jsonb_build_object('name',public.ql_room_name_v1(m.user_id),'online',coalesce(v.active_at>now()-interval '2 minutes',false),'me',m.user_id=u) p
     from public.ql_room_members_v1 m left join public.ql_room_visits_v1 v on v.room_id=m.room_id and v.user_id=m.user_id
     where m.room_id=p_room and m.status='active' order by coalesce(v.active_at>now()-interval '2 minutes',false) desc,m.joined_at limit 6)x),'[]'),
   'new_items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',i.payload->>'title','kind',i.payload->>'kind','creator_name',public.ql_room_name_v1(i.creator_id)) order by i.created_at desc) from (
     select * from public.ql_room_items_v1 i where i.room_id=p_room and prev is not null and i.created_at>prev and i.created_at>coalesce((select joined_at from public.ql_room_members_v1 where room_id=p_room and user_id=u),'-infinity') and i.creator_id is distinct from u and coalesce((i.payload->>'is_trashed')::boolean,false)=false
      and not exists(select 1 from public.ql_room_opens_v1 o where o.item_id=i.id and o.user_id=u) order by i.created_at desc limit 20)i),'[]'),
   'items',coalesce((select jsonb_object_agg(i.id,jsonb_build_object(
     'created_at',i.created_at,'pinned_at',i.pinned_at,
     'opened_at',(select o.opened_at from public.ql_room_opens_v1 o where o.item_id=i.id and o.user_id=u),
     'is_new',i.creator_id is distinct from u and i.created_at>now()-interval '14 days' and i.created_at>coalesce((select joined_at from public.ql_room_members_v1 where room_id=p_room and user_id=u),'-infinity')
       and not exists(select 1 from public.ql_room_opens_v1 o where o.item_id=i.id and o.user_id=u),
     'takers',case when i.payload->>'kind'='quiz' then (select count(distinct x.user_id) from public.ql_room_attempts_v1 x where x.item_id=i.id) end,
     'best',case when i.payload->>'kind'='quiz' then (select max((x.result->>'percent')::numeric) from public.ql_room_attempts_v1 x where x.item_id=i.id and x.user_id=u) end))
    from public.ql_room_items_v1 i where i.room_id=p_room),'{}'));
 end if;
 if p_action='opened' then
  if not exists(select 1 from public.ql_room_items_v1 where id=iid and room_id=p_room) then raise exception 'Room item not found.' using errcode='P0002';end if;
  insert into public.ql_room_opens_v1 as o(room_id,item_id,user_id,opened_at) values(p_room,iid,u,now()) on conflict(item_id,user_id) do update set opened_at=excluded.opened_at;
  return jsonb_build_object('opened_at',now());
 end if;
 if p_action in ('pin','theme') then
  if not manager then raise exception 'Only the room owner or website admin can do this.' using errcode='42501';end if;
  if r.status<>'active' and not a then raise exception 'This room is closed.';end if;
  if p_action='pin' then
   if not exists(select 1 from public.ql_room_items_v1 where id=iid and room_id=p_room) then raise exception 'Room item not found.' using errcode='P0002';end if;
   if coalesce((p_data->>'pinned')::boolean,true) and (select count(*) from public.ql_room_items_v1 where room_id=p_room and pinned_at is not null and id<>iid)>=6 then raise exception 'You can pin up to 6 items. Unpin one first.';end if;
   update public.ql_room_items_v1 set pinned_at=case when coalesce((p_data->>'pinned')::boolean,true) then now() else null end where id=iid and room_id=p_room;
   perform public.ql_room_event_v1(p_room,case when coalesce((p_data->>'pinned')::boolean,true) then 'item_pinned' else 'item_unpinned' end,(select payload->>'title' from public.ql_room_items_v1 where id=iid));
   return '{}';
  end if;
  t:=coalesce(p_data->>'theme',r.theme);
  if t not in ('violet','ocean','sunset','forest','rose','midnight') or char_length(coalesce(p_data->>'emoji',r.emoji))>16 then raise exception 'Invalid room theme.';end if;
  update public.ql_rooms_v1 set theme=t,emoji=btrim(coalesce(p_data->>'emoji',emoji)) where id=p_room returning * into r;
  perform public.ql_room_event_v1(p_room,'room_theme_changed',r.name);
  return jsonb_build_object('theme',r.theme,'emoji',r.emoji);
 end if;
 raise exception 'Unknown room action.';
end $$;
revoke all on function public.ql_room_look_v1(text,uuid,jsonb) from public,anon;
grant execute on function public.ql_room_look_v1(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';commit;
select 'Rooms look update complete' as result;
