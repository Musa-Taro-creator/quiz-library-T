// Rooms look (supabase/rooms_look_v1.sql) on a disposable PGlite database: room cover theme,
// pins, "since your last visit", studying now, NEW badges, opened markers and quiz stats.
import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
const OWNER='11111111-1111-4111-8111-111111111111',SOKHA='22222222-2222-4222-8222-222222222222',ADMIN='33333333-3333-4333-8333-333333333333',DARA='44444444-4444-4444-8444-444444444444',OUT='55555555-5555-4555-8555-555555555555';
let seq=0,rid,code,oldItem;
const uuid=()=>`dddddddd-dddd-4ddd-8ddd-${String(++seq).padStart(12,'0')}`;
const file=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
async function call(fn,user,action,room=rid,data={}){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);try{return (await db.query(`select ${fn}($1,$2,$3) value`,[action,room,JSON.stringify(data)])).rows[0].value}finally{await db.exec('reset role')}}
const api=(...a)=>call('ql_room_v1',...a),look=(...a)=>call('ql_room_look_v1',...a);
const sqlRoot=(q,p=[])=>db.query(q,p);
const add=(user,kind,title,extra={})=>api(user,'insert',rid,{id:uuid(),payload:{kind,title,parent_id:null,...extra}});

before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 insert into auth.users(id,email,raw_user_meta_data) values('${OWNER}','k@example.test','{"full_name":"Kuza"}'),('${SOKHA}','s@example.test','{"full_name":"Sokha"}'),('${ADMIN}','a@example.test','{"full_name":"Admin"}'),('${DARA}','d@example.test','{"full_name":"Dara"}'),('${OUT}','o@example.test','{"full_name":"Outsider"}');
 create table ql_site_settings(key text primary key,value jsonb);create table ql_subscriptions(user_id uuid,status text);
 create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable as $$select p_uid='${ADMIN}'::uuid$$;
 create table ql_plans(id text primary key,features jsonb not null default '{}');insert into ql_plans values('free','{}');
 create function ql__effective_plan(p_uid uuid) returns text language sql stable as $$select 'free'$$;
 create table ql_dash_posts(id uuid primary key,owner_id uuid,status text,payload jsonb);
 create schema storage;grant usage on schema storage to authenticated;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant select on storage.objects to authenticated;`);
 await db.exec(file('supabase/dashboard.sql').match(/create or replace function public\.ql__feature_ok[\s\S]*?\$\$;/)[0]);
 for(const f of ['dashboard_quiz_access_v1','shared_rooms_v1','rooms_controls_v1'])await db.exec(file(`supabase/${f}.sql`));
 const r=await api(OWNER,'create',null,{name:'MD-Y3-S2'});rid=r.id;code=r.invite_code;
 oldItem=await add(OWNER,'folder','Made before the update');
 await db.exec(file('supabase/rooms_look_v1.sql'));await db.exec(file('supabase/rooms_look_v1.sql'));
});
after(()=>db.close());

test('setup is safe to run again; old items get a date; the cover theme and emoji save (owner only)',async()=>{
 const row=(await sqlRoot('select created_at,updated_at from ql_room_items_v1 where id=$1',[oldItem.id])).rows[0];assert.equal(+row.created_at,+row.updated_at);
 assert.deepEqual(await look(OWNER,'theme',rid,{theme:'ocean',emoji:'🫀'}),{theme:'ocean',emoji:'🫀'});
 await assert.rejects(look(OWNER,'theme',rid,{theme:'neon'}),/Invalid room theme/);
 await api(SOKHA,'join',null,{code});await api(DARA,'join',null,{code});
 await assert.rejects(look(SOKHA,'theme',rid,{theme:'rose'}),/Only the room owner/);
 await assert.rejects(look(OUT,'summary'),/not a member/);
 const list=(await api(SOKHA,'list',null)).rooms.find(x=>x.id===rid);assert.equal(list.theme,'ocean');assert.equal(list.emoji,'🫀');
});

test('NEW badges, "since your last visit", opened markers and studying now',async()=>{
 await look(SOKHA,'summary');await look(DARA,'summary');
 const quiz=await add(DARA,'quiz','Heart sounds practice'),pdf=await add(DARA,'link','Lecture recording',{url:'https://example.test'}),mine=await add(SOKHA,'folder','My folder');
 let s=await look(SOKHA,'summary');
 assert.equal(s.items[quiz.id].is_new,true);assert.equal(s.items[mine.id].is_new,false,'your own items are never NEW');
 assert.equal(s.stats.online,2,'Sokha and Dara were active in the last 2 minutes');assert.equal(s.stats.members,3);
 assert.ok(s.people.find(p=>p.name==='Sokha'&&p.me&&p.online));
 // A visit that started 31 minutes ago: things added since then are listed.
 await sqlRoot("update ql_room_visits_v1 set last_seen_at=now()-interval '31 minutes',prev_seen_at=now()-interval '2 days' where room_id=$1 and user_id=$2",[rid,SOKHA]);
 await sqlRoot("update ql_room_items_v1 set created_at=now()-interval '40 minutes' where id=$1",[pdf.id]);
 s=await look(SOKHA,'summary');assert.deepEqual(s.new_items.map(x=>x.title),['Heart sounds practice'],'only things added after the last visit, by others, not opened');
 assert.equal(s.new_items[0].creator_name,'Dara');
 const again=await look(SOKHA,'summary');assert.deepEqual(again.since,s.since,'refreshing during the same visit keeps the same "since"');
 await look(SOKHA,'opened',rid,{id:quiz.id});s=await look(SOKHA,'summary');
 assert.equal(s.items[quiz.id].is_new,false);assert.ok(s.items[quiz.id].opened_at);assert.equal(s.new_items.length,0,'opening it removes it from the strip');
 await sqlRoot("update ql_room_visits_v1 set active_at=now()-interval '5 minutes' where room_id=$1 and user_id=$2",[rid,DARA]);
 assert.equal((await look(OWNER,'summary')).stats.online,2,'Dara is no longer studying now; Kuza and Sokha are');
 await assert.rejects(look(SOKHA,'opened',rid,{id:uuid()}),/not found/);
});

test('quiz stats: classmates who took it, your best score, quizzes taken this week, total questions',async()=>{
 const quiz=await add(OWNER,'quiz','Final exam revision');
 const qs=[{id:'q1',type:'true_false',prompt:'One',correct_answer:true,points:1},{id:'q2',type:'true_false',prompt:'Two',correct_answer:false,points:1}];
 const save=uuid();await api(OWNER,'save_begin',rid,{id:quiz.id,save_id:save,revision:1,fingerprint:'f',count:2,settings:{}});await api(OWNER,'save_part',rid,{id:quiz.id,save_id:save,part:0,questions:qs});const saved=await api(OWNER,'save_finish',rid,{id:quiz.id,save_id:save});
 const take=(user,a1,a2)=>api(user,'quiz_submit',rid,{id:quiz.id,attempt_id:uuid(),revision:saved._qlRevision,answers:[{question_id:'q1',given_answer:a1},{question_id:'q2',given_answer:a2}]});
 await take(SOKHA,true,true);await take(SOKHA,true,false);await take(DARA,false,true);
 const s=await look(SOKHA,'summary');
 assert.equal(s.items[quiz.id].takers,2);assert.equal(Number(s.items[quiz.id].best),100);assert.equal((await look(OWNER,'summary')).items[quiz.id].best,null,'no score until you take it');
 assert.equal(s.stats.taken_week,3);assert.equal(s.stats.questions,2);assert.ok(s.stats.quizzes>=2);
});

test('pins: owner only, at most 6, and pinning changes the room version so members refresh',async()=>{
 const v1=(await api(SOKHA,'open')).version;const item=await add(OWNER,'folder','Syllabus');
 const v2=(await api(SOKHA,'open')).version;await look(OWNER,'pin',rid,{id:item.id,pinned:true});
 assert.notEqual((await api(SOKHA,'open',rid,{since:v2})).unchanged,true);assert.notEqual(v1,v2);
 assert.ok((await look(SOKHA,'summary')).items[item.id].pinned_at);
 await assert.rejects(look(SOKHA,'pin',rid,{id:item.id,pinned:false}),/Only the room owner/);
 for(let n=0;n<5;n++)await look(OWNER,'pin',rid,{id:(await add(OWNER,'folder','P'+n)).id});
 await assert.rejects(look(OWNER,'pin',rid,{id:(await add(OWNER,'folder','Too many')).id}),/up to 6/);
 await look(ADMIN,'pin',rid,{id:item.id,pinned:false});assert.equal((await look(OWNER,'summary')).items[item.id].pinned_at,null);
 const ev=(await api(OWNER,'activity')).map(e=>e.action);assert.ok(ev.includes('item_pinned')&&ev.includes('item_unpinned'));
});

test('Website Control still applies: with Rooms hidden the look RPC is refused too',async()=>{
 await sqlRoot(`insert into ql_site_settings values('features','{"nav_rooms":"off"}') on conflict(key) do update set value=excluded.value`);
 await assert.rejects(look(SOKHA,'summary'),/Rooms is not available/);assert.ok(await look(ADMIN,'summary'));
 await sqlRoot(`update ql_site_settings set value='{}' where key='features'`);
});
