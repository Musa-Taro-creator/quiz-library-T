// Plan limits on restore / kind change / PDF growth. Disposable local PGlite only, never Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test,before,after} from 'node:test';
import {createObservedTables,installObservedItemLimits} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite(),root=new URL('../',import.meta.url);
const library='33333333-3333-4333-8333-333333333333';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
let counter=0;const uuid=()=>`cccccccc-cccc-4ccc-8ccc-${String(++counter).padStart(12,'0')}`;
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
const MB=1048576;
async function identity(id=A){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function add(payload,{user=A,personalized=true,id=uuid()}={}){
 await identity(user);
 await db.query('insert into student_library_items(user_id,library_id,id,payload,personalized) values($1,$2,$3,$4,$5)',[user,library,id,JSON.stringify(payload),personalized]);
 return id;
}
async function patch(id,changes,user=A){
 await identity(user);
 await db.query('update student_library_items set payload=payload||$1::jsonb where user_id=$2 and id=$3',[JSON.stringify(changes),user,id]);
}
const trash=id=>patch(id,{is_trashed:true}),restore=id=>patch(id,{is_trashed:false});
async function reset(limits){
 await admin(async()=>{await db.exec('delete from student_library_items;delete from ql_subscriptions');await db.query("update ql_plans set limits=$1 where id='free'",[JSON.stringify(limits)])});
}
async function payloadOf(id){return admin(async()=>(await db.query('select payload from student_library_items where id=$1',[id])).rows[0].payload)}

before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${A}'),('${B}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
 create table libraries(id uuid primary key);insert into libraries values('${library}');
 create table student_library_items(user_id uuid references auth.users(id) on delete cascade,library_id uuid references libraries(id) on delete cascade,id uuid,payload jsonb not null default '{}'::jsonb,personalized boolean not null default true,source_updated_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),primary key(user_id,library_id,id));
 alter table student_library_items enable row level security;create policy own on student_library_items for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());grant all on student_library_items to authenticated;`);
 await createObservedTables(db,['ql_site_settings','ql_plans','ql_subscriptions']);
 await db.exec("insert into ql_plans(id,name,is_default) values('free','Free',true),('pro','Pro',false)");
 await installObservedItemLimits(db);   // the deployed insert-only check
 await db.exec(file('supabase/plan_limits_on_edit.sql'));
 await db.exec(file('supabase/plan_limits_on_edit.sql'));   // safe to run again
 await identity();
});
after(()=>db.close());

test('New items past the limit are still refused (unchanged)',async()=>{
 await reset({quizzes:2});
 await add({kind:'quiz',title:'Q1'});await add({kind:'quiz',title:'Q2'});
 await assert.rejects(add({kind:'quiz',title:'Q3'}),/plan_limit:quizzes/);
});

test('Restoring from Trash cannot go past the limit; restoring within it still works',async()=>{
 await reset({quizzes:2});
 const old1=await add({kind:'quiz',title:'Old 1'}),old2=await add({kind:'quiz',title:'Old 2'});
 await trash(old1);await trash(old2);
 const new1=await add({kind:'quiz',title:'New 1'});
 await restore(old1);   // 2 of 2: allowed
 await assert.rejects(restore(old2),/plan_limit:quizzes/);
 assert.equal((await payloadOf(old2)).is_trashed,true,'refused restore leaves the item in Trash');
 await trash(new1);await restore(old2);   // room again: allowed
 assert.equal((await payloadOf(old2)).is_trashed,false);
});

test('Changing an item kind counts it against the new kind',async()=>{
 await reset({quizzes:1});
 await add({kind:'quiz',title:'Only quiz'});
 const folder=await add({kind:'folder',title:'Folder'});
 await assert.rejects(patch(folder,{kind:'quiz'}),/plan_limit:quizzes/);
 assert.equal((await payloadOf(folder)).kind,'folder');
 await patch(folder,{kind:'link'});   // links have no limit on this plan
 assert.equal((await payloadOf(folder)).kind,'link');
});

test('An upsert that changes the kind is checked too',async()=>{
 await reset({quizzes:1});
 await add({kind:'quiz',title:'Only quiz'});
 const folder=await add({kind:'folder',title:'Folder'});
 await identity();
 await assert.rejects(db.query(`insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,$4)
   on conflict (user_id,library_id,id) do update set payload=excluded.payload`,[A,library,folder,JSON.stringify({kind:'quiz',title:'Folder'})]),/plan_limit:quizzes/);
});

test('Normal edits at the limit keep working',async()=>{
 await reset({quizzes:1,pdfs:1,storage_mb:1});
 const quiz=await add({kind:'quiz',title:'Quiz',quiz_settings:{shuffle:false}});
 const pdf=await add({kind:'pdf',title:'PDF',file_size:MB/2});
 await patch(quiz,{title:'Renamed',parent_id:null,student_favorite:true,quiz_settings:{shuffle:true}});
 await patch(pdf,{title:'Renamed PDF',student_favorite:true});
 await trash(quiz);await restore(quiz);   // its own slot is free while it is in Trash
 await trash(pdf);await patch(pdf,{title:'Renamed in Trash'});await restore(pdf);
 assert.equal((await payloadOf(quiz)).title,'Renamed');
});

test('A PDF cannot grow past the storage limit; shrinking is fine',async()=>{
 await reset({storage_mb:1});
 const pdf=await add({kind:'pdf',title:'PDF',file_size:MB/2});
 await patch(pdf,{file_size:MB});   // exactly the limit
 await assert.rejects(patch(pdf,{file_size:MB+1}),/plan_limit:storage/);
 await patch(pdf,{file_size:1000});
 await admin(()=>db.query("insert into ql_subscriptions(user_id,plan_id,status,extra_storage_mb) values($1,'free','active',1)",[A]));
 await patch(pdf,{file_size:2*MB});   // extra storage bought by the student counts
 assert.equal((await payloadOf(pdf)).file_size,2*MB);
});

test('Copies of admin-shared items are not counted, even when the student edits them',async()=>{
 await reset({quizzes:0});
 const copy=await add({kind:'quiz',title:'Shared'},{personalized:false});
 await patch(copy,{title:'Student edit'});
 await admin(()=>db.query('update student_library_items set personalized=true where id=$1',[copy]));
 assert.equal((await payloadOf(copy)).title,'Student edit');
});

test('Unlimited plans and other accounts are not affected',async()=>{
 await reset({quizzes:1});
 await admin(()=>db.query("update ql_plans set limits='{}' where id='pro'"));
 await admin(()=>db.query("insert into ql_subscriptions(user_id,plan_id,status) values($1,'pro','active')",[B]));
 const ids=[];for(let i=0;i<3;i++)ids.push(await add({kind:'quiz',title:'B'+i},{user:B}));
 for(const id of ids)await patch(id,{is_trashed:true},B);
 for(const id of ids)await patch(id,{is_trashed:false},B);
 await add({kind:'quiz',title:'A only'});   // A's own limit is separate from B's items
});

test('Suspended accounts cannot restore items',async()=>{
 await reset({});
 const quiz=await add({kind:'quiz',title:'Quiz'});await trash(quiz);
 await admin(()=>db.query("insert into ql_subscriptions(user_id,plan_id,status) values($1,'free','suspended')",[A]));
 await assert.rejects(restore(quiz),/plan_limit:suspended/);
});
