// Rooms controls (supabase/rooms_controls_v1.sql) on a disposable PGlite database:
// Website Control → Rooms switches are checked on the server for the person doing the action
// (their own plan), the old Admin → Rooms ticks move to Website Control once, and each item has
// "Who can change this?" (everyone / only the creator / creator + chosen people) + copies.
import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
const OWNER='11111111-1111-4111-8111-111111111111',SOKHA='22222222-2222-4222-8222-222222222222',ADMIN='33333333-3333-4333-8333-333333333333',DARA='44444444-4444-4444-8444-444444444444',MONY='55555555-5555-4555-8555-555555555555';
let seq=0,rid,code;
const uuid=()=>`bbbbbbbb-bbbb-4bbb-8bbb-${String(++seq).padStart(12,'0')}`;
const file=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
async function as(id){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
async function root(fn){await db.exec('reset role');return fn()}
async function api(user,action,room=rid,data={}){await as(user);try{return (await db.query('select ql_room_v1($1,$2,$3) value',[action,room,JSON.stringify(data)])).rows[0].value}finally{await db.exec('reset role')}}
const features=v=>root(()=>db.query("insert into ql_site_settings(key,value) values('features',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(v)]));
const planOf=(user,plan)=>root(()=>db.query('insert into user_plans(user_id,plan_id) values($1,$2) on conflict(user_id) do update set plan_id=excluded.plan_id',[user,plan]));
const add=(user,kind,title,extra={})=>api(user,'insert',rid,{id:uuid(),payload:{kind,title,parent_id:null,...extra}});
// The real Website Control check from dashboard.sql, with a tiny plan table around it.
const featureOk=file('supabase/dashboard.sql').match(/create or replace function public\.ql__feature_ok[\s\S]*?\$\$;/)[0];

before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 insert into auth.users(id,email,raw_user_meta_data) values('${OWNER}','kuza@example.test','{"full_name":"Kuza"}'),('${SOKHA}','sokha@example.test','{"full_name":"Sokha"}'),('${ADMIN}','admin@example.test','{"full_name":"Admin"}'),('${DARA}','dara@example.test','{"full_name":"Dara"}'),('${MONY}','mony@example.test','{"full_name":"Mony"}');
 create table ql_site_settings(key text primary key,value jsonb);create table ql_subscriptions(user_id uuid,status text);
 create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable as $$select p_uid='${ADMIN}'::uuid$$;
 create table ql_plans(id text primary key,features jsonb not null default '{}');insert into ql_plans values('free','{"room_join":true}'),('max','{"room_create":true,"room_join":true,"room_pdf":true,"room_quiz":true,"room_save_copy":true}');
 create table user_plans(user_id uuid primary key,plan_id text);
 create function ql__effective_plan(p_uid uuid) returns text language sql stable as $$select coalesce((select plan_id from user_plans where user_id=p_uid),'free')$$;
 create table ql_dash_posts(id uuid primary key,owner_id uuid,status text,payload jsonb);
 create schema storage;grant usage on schema storage to authenticated;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant select on storage.objects to authenticated;`);
 await db.exec(featureOk);
 await db.exec(file('supabase/dashboard_quiz_access_v1.sql'));await db.exec(file('supabase/shared_rooms_v1.sql'));
 // Before this update the admin had turned off PDFs and copies in Admin → Rooms, and already chose "Lock" for quizzes.
 await db.exec(`insert into ql_site_settings values('rooms','{"max_rooms":10,"permissions":{"pdf":false,"save_copy":false,"quiz":false,"edit":true}}'),('features','{"room_quiz":"lock","nav_dashboard":"plan"}')`);
 // An item made before the update.
 await as(OWNER);const r=(await db.query("select ql_room_v1('create',null,'{\"name\":\"MD-Y3-S2\"}') v")).rows[0].v;rid=r.id;code=r.invite_code;
 await db.query("select ql_room_v1('insert',$1,$2)",[rid,JSON.stringify({id:'cccccccc-cccc-4ccc-8ccc-000000000001',payload:{kind:'folder',title:'Old folder'}})]);await db.exec('reset role');
 await db.exec(file('supabase/rooms_controls_v1.sql'));
});
after(()=>db.close());

test('old Admin → Rooms ticks move to Website Control once and the file is safe to run again',async()=>{
 const f=(await db.query("select value from ql_site_settings where key='features'")).rows[0].value;
 assert.equal(f.room_pdf,'off');assert.equal(f.room_save_copy,'off');
 assert.equal(f.room_quiz,'lock','an existing Website Control choice is kept');assert.equal(f.nav_dashboard,'plan','other switches are untouched');
 assert.equal(f.room_edit,undefined,'a tick that was on adds nothing');
 const rooms=(await db.query("select value from ql_site_settings where key='rooms'")).rows[0].value;assert.equal(rooms.permissions,undefined);assert.equal(rooms.max_rooms,10);
 await features({...f,room_pdf:'on'});await db.exec(file('supabase/rooms_controls_v1.sql'));
 assert.equal((await db.query("select value->>'room_pdf' v from ql_site_settings where key='features'")).rows[0].v,'on','running again does not undo a later admin choice');
 const old=(await db.query("select edit_mode,editors,allow_copy from ql_room_items_v1 where id='cccccccc-cccc-4ccc-8ccc-000000000001'")).rows[0];
 assert.deepEqual([old.edit_mode,old.editors,old.allow_copy],['everyone',[],true],'items made before the update keep "everyone can edit"');
 await features({});
});

test('Website Control switches are enforced on the server for the person doing the action',async()=>{
 await api(SOKHA,'join',null,{code});await api(DARA,'join',null,{code});await api(MONY,'join',null,{code});
 for(const [k,mode,run,msg] of [
  ['room_create','off',()=>api(SOKHA,'create',null,{name:'Mine'}),/Creating rooms/],
  ['room_join','lock',()=>api(SOKHA,'join',null,{code}),/Joining rooms/],
  ['room_pdf','off',()=>add(SOKHA,'pdf','Notes',{storage_path:`students/${SOKHA}/a.pdf`,file_size:10}),/Uploading PDFs/],
  ['room_link','off',()=>add(SOKHA,'link','Link',{url:'https://example.test'}),/quiz links/],
  ['room_folder','lock',()=>add(SOKHA,'folder','F'),/folders/],
  ['room_quiz','off',()=>add(SOKHA,'quiz','Q'),/quizzes/],
 ]){
  await features({[k]:mode});await assert.rejects(run(),msg,k);
  if(k!=='room_create'&&k!=='room_join')await add(ADMIN,k.replace('room_',''),'Admin '+k,k==='room_pdf'?{storage_path:`students/${ADMIN}/a.pdf`,file_size:1}:{}); // admin is never blocked
 }
 await features({});const link=await add(SOKHA,'link','Shared link',{url:'https://example.test'});
 await features({room_edit:'off'});await assert.rejects(api(SOKHA,'patch',rid,{id:link.id,patch:{title:'x'}}),/Editing room content/);
 await features({room_trash:'lock'});await assert.rejects(api(SOKHA,'patch',rid,{id:link.id,patch:{is_trashed:true}}),/Trash/);await assert.rejects(api(SOKHA,'delete',rid,{id:link.id}),/Trash/);
 await features({room_save_copy:'off'});await assert.rejects(api(SOKHA,'copy_get',rid,{id:link.id}),/Saving room copies/);
 await features({nav_rooms:'off'});await assert.rejects(api(SOKHA,'list',null),/Rooms is not available/);assert.ok((await api(ADMIN,'admin_list',null)).rooms.length,'admin still has Rooms');
 await features({});
});

test('By plan uses each person’s own plan, not the room owner’s',async()=>{
 await features({room_pdf:'plan',room_create:'plan'});await planOf(OWNER,'max');
 assert.ok((await add(OWNER,'pdf','Owner PDF',{storage_path:`students/${OWNER}/p.pdf`,file_size:5})).id,'Max plan can upload');
 await assert.rejects(add(SOKHA,'pdf','Free PDF',{storage_path:`students/${SOKHA}/p.pdf`,file_size:5}),/not available on your plan/,'Free member in a Max room cannot');
 await assert.rejects(api(SOKHA,'create',null,{name:'Free room'}),/Creating rooms/);await planOf(SOKHA,'max');assert.ok((await api(SOKHA,'create',null,{name:'Paid room'})).id);
 await planOf(SOKHA,'free');await features({});
});

test('"Who can change this?": only me, me + chosen people, everyone — the owner can always change it',async()=>{
 const quiz=await add(SOKHA,'quiz','Heart sounds practice');assert.equal(quiz._can_access,true);assert.equal(quiz._edit_mode,'everyone');
 const view=await api(SOKHA,'item_access_get',rid,{id:quiz.id});assert.deepEqual(view.members.map(m=>m.name).sort(),['Dara','Mony'],'picker lists other members, not the creator or owner');
 await assert.rejects(api(DARA,'item_access',rid,{id:quiz.id,mode:'creator'}),/Only the creator or the room owner/);
 const only=await api(SOKHA,'item_access',rid,{id:quiz.id,mode:'creator',allow_copy:false});assert.equal(only._edit_mode,'creator');
 await assert.rejects(api(DARA,'patch',rid,{id:quiz.id,patch:{title:'Hacked'}}),/Only Sokha \(and the room owner\)/);
 await assert.rejects(api(DARA,'patch',rid,{id:quiz.id,patch:{is_trashed:true}}),/Only Sokha/);
 await assert.rejects(api(DARA,'save_begin',rid,{id:quiz.id,save_id:uuid(),revision:1,fingerprint:'x',count:0,settings:{}}),/Only Sokha/);
 await assert.rejects(api(DARA,'copy_get',rid,{id:quiz.id}),/turned off copies/);
 assert.ok(await api(SOKHA,'copy_get',rid,{id:quiz.id}),'the creator can still copy');assert.ok(await api(OWNER,'copy_get',rid,{id:quiz.id}),'the owner can still copy');
 assert.equal((await api(OWNER,'patch',rid,{id:quiz.id,patch:{title:'Owner fix'}})).title,'Owner fix','owner always can');
 assert.equal((await api(ADMIN,'patch',rid,{id:quiz.id,patch:{title:'Admin fix'}})).title,'Admin fix','website admin always can');
 const seen=(await api(DARA,'open')).items.find(x=>x.id===quiz.id);assert.equal(seen._can_edit,false);assert.equal(seen._can_access,false);assert.equal(seen._creator_name,'Sokha');assert.equal(seen._can_copy,false);
 // Me + chosen people; someone who is not a member is ignored.
 const chosen=await api(SOKHA,'item_access',rid,{id:quiz.id,mode:'chosen',editors:[DARA,ADMIN],allow_copy:true});assert.equal(chosen._editor_count,1);
 assert.equal((await api(DARA,'patch',rid,{id:quiz.id,patch:{title:'Dara helps'}})).title,'Dara helps');
 await assert.rejects(api(MONY,'patch',rid,{id:quiz.id,patch:{title:'Mony'}}),/Only Sokha/);
 // The owner can change the creator's choice; back to everyone.
 await api(OWNER,'item_access',rid,{id:quiz.id,mode:'everyone'});assert.equal((await api(MONY,'patch',rid,{id:quiz.id,patch:{title:'Team'}})).title,'Team');
 await assert.rejects(api(SOKHA,'item_access',rid,{id:quiz.id,mode:'nobody'}),/Invalid choice/);
});

test('Room owner rules: new items start as "only the creator" and creators may be stopped from choosing',async()=>{
 const room=(await api(OWNER,'open')).room;
 await api(OWNER,'settings',rid,{permissions:{...room.permissions,item_default:'creator',creator_choice:false}});
 await assert.rejects(api(OWNER,'settings',rid,{permissions:{item_default:'nobody'}}),/Invalid room settings/);
 const link=await add(DARA,'link','Dara link',{url:'https://example.test/d'});assert.equal(link._edit_mode,'creator');assert.equal(link._can_access,false,'creator cannot choose when the owner turned it off');
 await assert.rejects(api(DARA,'item_access',rid,{id:link.id,mode:'everyone'}),/Only the creator or the room owner/);
 await assert.rejects(api(MONY,'patch',rid,{id:link.id,patch:{title:'x'}}),/Only Dara/);
 assert.equal((await api(DARA,'patch',rid,{id:link.id,patch:{title:'Mine'}})).title,'Mine','the creator can still edit it');
 assert.equal((await api(OWNER,'item_access',rid,{id:link.id,mode:'everyone'}))._edit_mode,'everyone');
 // A creator-only item that is in Trash still cannot be deleted forever by others.
 const own=await add(DARA,'folder','Dara folder');await api(DARA,'patch',rid,{id:own.id,patch:{is_trashed:true}});
 await assert.rejects(api(MONY,'delete',rid,{id:own.id}),/Only Dara/);await api(OWNER,'delete',rid,{id:own.id});
 await api(OWNER,'settings',rid,{permissions:{...room.permissions,item_default:'everyone',creator_choice:true}});
});

test('Changing access or Website Control makes other members refresh (open version changes)',async()=>{
 const v1=(await api(MONY,'open')).version;await features({room_link:'plan'});const v2=(await api(MONY,'open',rid,{since:v1}));assert.notEqual(v2.unchanged,true);
 await features({});
});
