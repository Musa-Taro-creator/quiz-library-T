import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444';let seq=0,rid,code,quiz;
const uuid=()=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12,'0')}`;
const file=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
async function identity(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function api(action,room=rid,data={}){return (await db.query('select ql_room_v1($1,$2,$3) value',[action,room,JSON.stringify(data)])).rows[0].value}
const qs=n=>Array.from({length:n},(_,i)=>({id:'q'+i,type:'true_false',prompt:'Question '+i,correct_answer:false,points:1,question_position:i}));
async function save(id,questions,revision,op=uuid()){
 const data={id,save_id:op};await api('save_begin',rid,{...data,revision,fingerprint:'content-'+questions.length,count:questions.length,settings:{question_count:questions.length,pass_percent:50}});
 for(let i=0;i<Math.max(1,Math.ceil(questions.length/200));i++)await api('save_part',rid,{...data,part:i,questions:questions.slice(i*200,(i+1)*200)});
 return api('save_finish',rid,data);
}
before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');insert into auth.users(id,email) values('${A}','owner@example.test'),('${B}','member@example.test'),('${C}','admin@example.test'),('${D}','outsider@example.test');
 create table ql_site_settings(key text primary key,value jsonb);create table ql_subscriptions(user_id uuid,status text);
 create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable as $$select p_uid='${C}'::uuid$$;
 create table ql_dash_posts(id uuid primary key,owner_id uuid,status text,payload jsonb);
 create schema storage;grant usage on schema storage to authenticated;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant select on storage.objects to authenticated;
 `);
 await db.exec(file('supabase/dashboard_quiz_access_v1.sql'));await db.exec(file('supabase/shared_rooms_v1.sql'));await identity();
});after(()=>db.close());
test('Setup is repeatable and does not change the existing Dashboard grader',async()=>{
 const def=await admin(async()=>(await db.query("select pg_get_functiondef('ql__dash_quiz_grade_v1(jsonb,jsonb)'::regprocedure) d")).rows[0].d);
 await admin(()=>db.exec(file('supabase/shared_rooms_v1.sql')));
 assert.equal(await admin(async()=>(await db.query("select pg_get_functiondef('ql__dash_quiz_grade_v1(jsonb,jsonb)'::regprocedure) d")).rows[0].d),def);
});
test('Create/join: all members can create content; outsiders cannot open or enumerate rooms',async()=>{
 const r=await api('create',null,{name:'MD-Y3-S2'});rid=r.id;code=r.invite_code;assert.equal(r.owner_id,A);assert.equal(code.length,10);
 await identity(D);assert.equal((await api('list',null)).rooms.length,0);await assert.rejects(api('open'),/not a member/);
 await identity(B);await api('join',null,{code:code.toLowerCase()});assert.equal((await api('open')).can_edit,true);
 quiz=await api('insert',rid,{id:uuid(),payload:{kind:'quiz',title:'Member quiz',quiz_settings:{question_count:0},parent_id:null}});assert.equal(quiz._room_id,rid);
 await identity();assert.equal((await api('open')).items[0].id,quiz.id);
});
test('Shared folders, parent validation, cycles, metadata changes and Trash work',async()=>{
 const folder=await api('insert',rid,{id:uuid(),payload:{kind:'folder',title:'Folder'}}),child=await api('insert',rid,{id:uuid(),payload:{kind:'folder',title:'Child',parent_id:folder.id}});
 await assert.rejects(api('patch',rid,{id:folder.id,patch:{parent_id:child.id}}),/Invalid destination/);
 await assert.rejects(api('insert',rid,{id:uuid(),payload:{kind:'link',title:'Bad',parent_id:uuid()}}),/Destination/);
 const renamed=await api('patch',rid,{id:folder.id,patch:{title:'Updated folder'}});assert.equal(renamed.title,'Updated folder');
 await api('patch',rid,{id:child.id,patch:{is_trashed:true}});await api('patch',rid,{id:child.id,patch:{is_trashed:false}});
});
test('Owner controls beat member permissions and removed members cannot rejoin',async()=>{
 await api('member',rid,{user_id:B,can_edit:false});await identity(B);assert.equal((await api('open')).can_edit,false);
 await assert.rejects(api('patch',rid,{id:quiz.id,patch:{title:'Not allowed'}}),/restricted/);
 await identity();await api('member',rid,{user_id:B,status:'blocked'});await identity(B);await assert.rejects(api('open'),/not a member/);await assert.rejects(api('join',null,{code}),/removed/);
 await identity();await api('member',rid,{user_id:B,status:'active',can_edit:true});await api('settings',rid,{locked:true});await identity(B);await assert.rejects(api('insert',rid,{id:uuid(),payload:{kind:'link',title:'Blocked'}}),/restricted/);
 await identity();await api('settings',rid,{locked:false});await assert.rejects(api('member',rid,{user_id:A,status:'blocked'}),/owner cannot/);
});
test('Website admin can suspend, restore, limit and disable room actions; owners cannot override suspension',async()=>{
 await assert.rejects(api('admin_list',null),/Admin/);await identity(C);assert((await api('admin_list',null)).rooms.length);
 await api('settings',rid,{status:'suspended'});await identity();await assert.rejects(api('open'),/unavailable/);await assert.rejects(api('settings',rid,{status:'active'}),/unavailable/);
 await identity(C);await api('settings',rid,{status:'active'});await api('admin_config',null,{permissions:{pdf:false}});await identity();
 await assert.rejects(api('insert',rid,{id:uuid(),payload:{kind:'pdf',title:'Disabled'}}),/disabled/);
 await identity(C);await api('admin_config',null,{permissions:{}});await identity();
});
test('Large quiz saves are staged, atomic, retryable and reject concurrent stale edits',async()=>{
 const first=await save(quiz.id,qs(1200),quiz._qlRevision);assert.equal(first.quiz_settings.question_count,1200);
 const current=await api('item_get',rid,{id:quiz.id});assert.equal(current._student_questions.length,1200);
 const op=uuid();await api('save_begin',rid,{id:quiz.id,save_id:op,revision:current._qlRevision,fingerprint:'new',count:2,settings:{question_count:2}});
 await api('save_part',rid,{id:quiz.id,save_id:op,part:0,questions:qs(2)});assert.equal((await api('item_get',rid,{id:quiz.id}))._student_questions.length,1200);
 await identity(B);const other=await save(quiz.id,qs(3),current._qlRevision);assert.equal(other.quiz_settings.question_count,3);
 await identity();await assert.rejects(api('save_finish',rid,{id:quiz.id,save_id:op}),/QL_CONFLICT/);assert.equal((await api('item_get',rid,{id:quiz.id}))._student_questions.length,3);
 const retry=uuid(),row=await save(quiz.id,qs(4),other._qlRevision,retry);const receipt=await api('save_finish',rid,{id:quiz.id,save_id:retry});assert.deepEqual(receipt,row);
});
test('Quiz preferences and attempts are personal; final grading is server authoritative',async()=>{
 const before=await api('quiz_take',rid,{id:quiz.id});await api('quiz_tools',rid,{id:quiz.id,settings:{layout:'horizontal',pass_percent:0}});
 assert.equal((await api('quiz_take',rid,{id:quiz.id})).quiz_settings.layout,'horizontal');await identity(B);assert.notEqual((await api('quiz_take',rid,{id:quiz.id})).quiz_settings.layout,'horizontal');await identity();
 const result=await api('quiz_submit',rid,{id:quiz.id,attempt_id:uuid(),revision:before._qlRevision,answers:qs(4).map(q=>({question_id:q.id,given_answer:false}))});assert.equal(result.percent,100);assert.equal((await api('quiz_history',rid,{id:quiz.id})).length,1);
 await identity(B);assert.equal((await api('quiz_history',rid,{id:quiz.id})).length,0);await identity();
});
test('Activity is visible to owner/admin, storage reads require membership and client tables are private',async()=>{
 assert((await api('activity')).some(e=>e.action==='quiz_saved'));await identity(B);await assert.rejects(api('activity'),/Only the room owner/);await identity();
 const path=`students/${A}/lib/test.pdf`;await api('insert',rid,{id:uuid(),payload:{kind:'pdf',title:'PDF',file_size:1000,storage_path:path}});
 await admin(()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['library-pdfs',path]));await identity(B);assert.equal((await db.query('select * from storage.objects')).rows.length,1);
 await identity(D);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
 for(const t of ['ql_rooms_v1','ql_room_items_v1','ql_room_attempts_v1','ql_room_saves_v1'])await assert.rejects(db.exec('select * from '+t),/permission denied/);
 await identity(null,'anon');await assert.rejects(api('list',null),/permission denied/);await identity();
});
test('Non-PDF metadata cannot grant Storage access; PDF paths and copying obey room controls',async()=>{
 const foreign=`students/${D}/private/not-shared.pdf`;
 await api('insert',rid,{id:uuid(),payload:{kind:'link',title:'Spoofed metadata',url:'https://example.test',storage_path:foreign}});
 await admin(()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['library-pdfs',foreign]));
 assert.equal((await db.query('select name from storage.objects where name=$1',[foreign])).rows.length,0);
 await assert.rejects(api('insert',rid,{id:uuid(),payload:{kind:'pdf',title:'Foreign PDF',file_size:1000,storage_path:foreign}}),/storage path/);
 await api('settings',rid,{permissions:{save_copy:false}});await identity(B);await assert.rejects(api('copy_get',rid,{id:quiz.id}),/copy is disabled/);await identity();await api('settings',rid,{permissions:{}});
});
test('Incomplete batches, changed retries, revoked editing and stale versions preserve the published quiz',async()=>{
 const item=await api('item_get',rid,{id:quiz.id}),op=uuid(),data={id:quiz.id,save_id:op,revision:item._qlRevision,fingerprint:'partial',count:201,settings:{}};
 await api('save_begin',rid,data);await assert.rejects(api('save_finish',rid,data),/Missing question batches/);
 await api('save_part',rid,{...data,part:0,questions:qs(200)});
 await assert.rejects(api('save_part',rid,{...data,part:0,questions:qs(199)}),/batch changed/);
 await assert.rejects(api('save_begin',rid,{...data,settings:{layout:'horizontal'}}),/different content/);
 await identity(B);const memberOp=uuid(),memberData={...data,save_id:memberOp,count:1,fingerprint:'member'};await api('save_begin',rid,memberData);await api('save_part',rid,{...memberData,part:0,questions:qs(1)});
 await identity();await api('member',rid,{user_id:B,can_edit:false});await identity(B);await assert.rejects(api('save_finish',rid,memberData),/restricted/);
 await identity();await api('member',rid,{user_id:B,can_edit:true});assert.deepEqual((await api('item_get',rid,{id:quiz.id}))._student_questions,item._student_questions);
 const room=await api('open');assert.equal((await api('open',rid,{since:room.version})).unchanged,true);await api('patch',rid,{id:quiz.id,patch:{title:'Version changed'}});assert.notEqual((await api('open',rid,{since:room.version})).version,room.version);
});
test('Website disabling Rooms denies content and PDF access; global Trash restrictions cannot be bypassed',async()=>{
 await identity(C);await api('admin_config',null,{permissions:{trash:false}});await identity();
 await assert.rejects(api('patch',rid,{id:quiz.id,patch:{is_trashed:true}}),/disabled/);await assert.rejects(api('delete',rid,{id:quiz.id}),/disabled/);
 await identity(C);await api('admin_config',null,{enabled:false,permissions:{}});await identity();await assert.rejects(api('open'),/unavailable/);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
 await identity(C);await api('admin_config',null,{enabled:true});await identity();
});
