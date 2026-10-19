// Execute real SQL in a disposable local PostgreSQL engine, never Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test,before,after} from 'node:test';
import {createObservedTables,installObservedItemLimits} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite(),root=new URL('../',import.meta.url);
const uuidItems=process.env.QL_TEST_ITEM_IDS!=='text';
const library=uuidItems?'33333333-3333-4333-8333-333333333333':'lib';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
let counter=0;const uuid=()=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(++counter).padStart(12,'0')}`;
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
async function identity(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function call(name,args=[],types=[]){return (await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}${types[i]?'::'+types[i]:''}`).join(',')}) as value`,args)).rows[0].value}
const read=(id,offset=0,rev=null)=>call('student_read_quiz_page_v2',[library,id,offset,rev]);
const q=(id,i=0)=>({id,prompt:'Question '+id,type:'true_false',correct_answer:false,question_position:i});
const qs=n=>Array.from({length:n},(_,i)=>q('q'+i,i));
async function fixture(){
 const id=uuidItems?uuid():'quiz-'+uuid();
 await db.query("insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,$4)",[A,library,id,JSON.stringify({kind:'quiz',title:'Keep this title',quiz_settings:{shuffle:false},_student_q_split:true})]);
 await admin(async()=>{for(let i=0;i<3;i++)await db.query("insert into student_quiz_questions(user_id,library_id,item_id,id,position,data) values($1,$2,$3,$4,$5,$6)",[A,library,id,'old'+i,i,JSON.stringify(q('old'+i,i))])});return id;
}
async function start(id,questions,save=uuid(),expected){const head=await read(id);await call('student_begin_quiz_save_v2',[save,library,id,questions.length,JSON.stringify({shuffle:true}),expected??head.revision]);return save}
const stage=(save,index,questions)=>call('student_stage_quiz_batch_v2',[save,index,JSON.stringify(questions)]);
async function stageAll(save,questions){for(let i=0;i<questions.length||i===0;i+=2000){await stage(save,i/2000,questions.slice(i,i+2000));if(!questions.length)break}}
const finish=save=>call('student_finalize_quiz_save_v2',[save]);
before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${A}'),('${B}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
 create table libraries(id ${uuidItems?'uuid':'text'} primary key);insert into libraries values('${library}');
 create table student_library_items(user_id uuid references auth.users(id) on delete cascade,library_id ${uuidItems?'uuid':'text'} references libraries(id) on delete cascade,id ${uuidItems?'uuid':'text'},payload jsonb not null default '{}'::jsonb,personalized boolean not null default true,source_updated_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),primary key(user_id,library_id,id));
 alter table student_library_items enable row level security;create policy own on student_library_items for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());grant all on student_library_items to authenticated;`);
 await createObservedTables(db,['ql_site_settings','ql_plans','ql_subscriptions']);
 await db.exec("insert into ql_plans(id,name,is_default) values('free','Free',true)");
 await installObservedItemLimits(db);
 await db.exec(file('supabase/student_quiz_split_storage.sql'));
 await db.exec('grant truncate on student_library_items,student_quiz_questions to anon,authenticated');
 const limitBefore=(await db.query("select pg_get_functiondef('ql__check_item_limits()'::regprocedure) as body")).rows[0].body;
 await db.exec(file('supabase/student_quiz_atomic_save_v2.sql'));
 assert.equal((await db.query("select pg_get_functiondef('ql__check_item_limits()'::regprocedure) as body")).rows[0].body,limitBefore);
 await db.exec(file('supabase/student_quiz_atomic_save_v2.sql'));
 await identity();
});
after(()=>db.close());
test('An unsupported base schema aborts before creating staging tables',async()=>{
 const isolated=new PGlite();
 try{
  await assert.rejects(isolated.exec(file('supabase/student_quiz_atomic_save_v2.sql')),/QL_PROTOCOL: Schema review required/);
  await isolated.exec('rollback');
  assert.equal((await isolated.query("select to_regclass('public.student_quiz_saves_v2') as name")).rows[0].name,null);
 }finally{await isolated.close()}
});
for(const size of [0,1,1999,2000,2001,4500,10000])test('Atomic replacement of '+size+' questions',async()=>{const id=await fixture(),questions=qs(size),save=await start(id,questions);await stageAll(save,questions);const result=await finish(save);assert.equal(result.committed_revision,result.current_revision);const first=await read(id);assert.equal(first.count,size);assert.equal(first.item.payload.quiz_settings.shuffle,true);assert.equal(first.item.payload.title,'Keep this title');for(let i=0;i<size;i+=1000){const page=await read(id,i,first.revision);assert.deepEqual(page.questions,questions.slice(i,i+1000))}assert.equal((await finish(save)).committed_revision,result.committed_revision);await stage(save,0,questions.slice(0,2000));});
test('Missing middle/last batch preserves questions and settings',async()=>{const id=await fixture(),before=await read(id),save=await start(id,qs(4500));await stage(save,0,qs(4500).slice(0,2000));await assert.rejects(finish(save),/Incomplete/);assert.deepEqual(await read(id),before);await stage(save,2,qs(4500).slice(4000));await assert.rejects(finish(save),/Incomplete/);assert.deepEqual(await read(id),before)});
test('Changed batch retry rejected; identical retry accepted',async()=>{const id=await fixture(),save=await start(id,qs(1));await stage(save,0,qs(1));await stage(save,0,qs(1));await assert.rejects(stage(save,0,[{...q('q0'),prompt:'Changed'}]),/retry changed/)});
test('Duplicate question IDs reject finalization without data loss',async()=>{const id=await fixture(),before=await read(id),questions=[q('same',0),q('same',1)],save=await start(id,questions);await stageAll(save,questions);await assert.rejects(finish(save),/duplicate/);assert.deepEqual(await read(id),before)});
test('Overlapping saves and stale baseline cannot overwrite a winner',async()=>{const id=await fixture(),head=await read(id),one=await start(id,qs(1)),two=await start(id,qs(2));await stageAll(one,qs(1));await stageAll(two,qs(2));await finish(one);await assert.rejects(finish(two),/QL_CONFLICT/);await assert.rejects(start(id,qs(1),uuid(),head.revision),/QL_CONFLICT/);assert.equal((await read(id)).count,1)});
test('Transactional insert failure rolls back deletion and settings',async()=>{const id=await fixture(),before=await read(id),save=await start(id,qs(2));await stageAll(save,qs(2));await admin(()=>db.exec(`create function fail_insert_test() returns trigger language plpgsql as $$begin raise exception 'Injected insert failure';end$$;create trigger injected before insert on student_quiz_questions for each statement execute function fail_insert_test()`));await assert.rejects(finish(save),/Injected/);await admin(()=>db.exec('drop trigger injected on student_quiz_questions;drop function fail_insert_test()'));assert.deepEqual(await read(id),before);await finish(save);assert.equal((await read(id)).count,2)});
test('Transactional settings failure rolls back all question changes',async()=>{const id=await fixture(),before=await read(id),save=await start(id,qs(1));await stageAll(save,qs(1));await admin(()=>db.exec(`create function fail_settings_test() returns trigger language plpgsql as $$begin raise exception 'Injected settings failure';end$$;create trigger injected before update on student_library_items for each statement execute function fail_settings_test()`));await assert.rejects(finish(save),/Injected/);await admin(()=>db.exec('drop trigger injected on student_library_items;drop function fail_settings_test()'));assert.deepEqual(await read(id),before)});
test('Settings-only partial save persists; exact retry returns one receipt',async()=>{const id=await fixture(),head=await read(id),op=uuid(),args=[op,library,id,'[]',JSON.stringify({layout:'vertical'}),head.revision];const result=await call('student_patch_quiz_v2',args);assert.equal(result.item.payload.quiz_settings.layout,'vertical');assert.equal((await read(id)).count,3);assert.equal((await call('student_patch_quiz_v2',args)).committed_revision,result.committed_revision)});
test('Partial edits cannot recreate a deleted question or use a stale revision',async()=>{const id=await fixture(),head=await read(id),save=await start(id,qs(1));await stageAll(save,qs(1));await finish(save);await assert.rejects(call('student_patch_quiz_v2',[uuid(),library,id,JSON.stringify([{...q('old0'),position:0}]),'{}',head.revision]),/QL_CONFLICT/);const latest=await read(id);await assert.rejects(call('student_patch_quiz_v2',[uuid(),library,id,JSON.stringify([{...q('old0'),position:0}]),'{}',latest.revision]),/removed/);assert.equal((await read(id)).count,1)});
test('Pagination rejects a mixed generation',async()=>{const id=await fixture(),head=await read(id),save=await start(id,qs(2));await stageAll(save,qs(2));await finish(save);await assert.rejects(read(id,1000,head.revision),/QL_CONFLICT/)});
test('Recovered receipt includes current metadata without replaying old fields',async()=>{const id=await fixture(),save=await start(id,qs(1));await stageAll(save,qs(1));await finish(save);await call('student_patch_item_v2',[library,id,JSON.stringify({title:'New name',student_favorite:true}),false]);const receipt=await finish(save);assert.equal(receipt.item.payload.title,'New name');assert.equal(receipt.item.payload.student_favorite,true)});
test('Old receipt identifies a later content revision',async()=>{const id=await fixture(),one=await start(id,qs(1));await stageAll(one,qs(1));await finish(one);const two=await start(id,qs(2));await stageAll(two,qs(2));await finish(two);const old=await finish(one);assert.notEqual(old.committed_revision,old.current_revision);assert.equal((await read(id)).count,2)});
test('Direct old writers are blocked and metadata cannot carry quiz fields',async()=>{const id=await fixture();await assert.rejects(call('student_replace_quiz_questions',[library,id,'[]',true]),/permission denied/);await assert.rejects(db.query("delete from student_quiz_questions where item_id=$1",[id]),/permission denied/);await assert.rejects(call('student_patch_item_v2',[library,id,JSON.stringify({quiz_settings:{shuffle:true}}),true]),/Protected/);await assert.rejects(db.query("update student_library_items set payload=payload||'{\"quiz_settings\":{\"layout\":\"stale\"}}' where id=$1",[id]),/QL_PROTOCOL/)});
test('Client roles cannot bypass revisions/RLS with inherited TRUNCATE grants',async()=>{
 for(const role of ['anon','authenticated'])for(const table of ['student_library_items','student_quiz_questions']){
  assert.equal((await db.query("select has_table_privilege($1,$2,'TRUNCATE') as allowed",[role,table])).rows[0].allowed,false);
 }
});
test('Another account and anonymous users cannot access staging or quizzes',async()=>{const id=await fixture(),save=await start(id,qs(1));await identity(B);await assert.rejects(read(id),/not found/);await assert.rejects(stage(save,0,qs(1)),/not found/);await assert.rejects(finish(save),/not found/);await assert.rejects(db.query('select * from student_quiz_saves_v2'),/permission denied/);await identity(null,'anon');await assert.rejects(read(id),/permission denied/);await identity()});
test('Completed staging bodies are released; deleting quiz removes its sessions',async()=>{const id=await fixture(),save=await start(id,qs(1));await stageAll(save,qs(1));await finish(save);await admin(async()=>assert.equal((await db.query('select questions from student_quiz_save_batches_v2 where save_id=$1',[save])).rows[0].questions,null));await db.query('delete from student_library_items where id=$1',[id]);await admin(async()=>assert.equal((await db.query('select * from student_quiz_saves_v2 where save_id=$1',[save])).rows.length,0))});
test('Actual frontend retries the same staged save after a middle-batch failure',async()=>{
 const vm=await import('node:vm'),id=await fixture(),head=await read(id),options={expectedRevision:head.revision,saveId:uuid()};
 const source=file('index.html');const a=source.indexOf('  async function saveSplitFull('),b=source.indexOf('\n  service.saveQuizQuestions=async',a);let failed=false,cached=null;
 const signatures={student_begin_quiz_save_v2:['p_save_id','p_library_id','p_item_id','p_question_count','p_settings','p_expected_revision'],student_stage_quiz_batch_v2:['p_save_id','p_batch_index','p_questions'],student_finalize_quiz_save_v2:['p_save_id']};
 const context={uid:uuid,LIBRARY_ID:library,QCHUNK:2000,markOwnQuizWrite:()=>{},saveOptions:async(_,o)=>o,
  quizRpc:async(name,args)=>{if(name==='student_stage_quiz_batch_v2'&&args.p_batch_index===1&&!failed){failed=true;throw Error('Injected network failure')}return await call(name,signatures[name].map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]))},
  acceptQuizReceipt:(_,r)=>{assert.equal(r.committed_revision,r.current_revision);return {...r.item.payload,_qlRevision:r.current_revision}},cacheQuestions:(_,rows)=>cached=rows};
 const save=vm.runInNewContext(source.slice(a,b)+'\nsaveSplitFull',context),questions=qs(4500);
 await assert.rejects(save(id,questions,{shuffle:true},options),/Injected network/);assert.equal((await read(id)).count,3);assert.equal(cached,null);
 await save(id,questions,{shuffle:true},options);assert.equal((await read(id)).count,4500);assert.equal(cached.length,4500);
});
test('Actual frontend fails closed when the new RPC is unavailable',async()=>{
 const vm=await import('node:vm'),source=file('index.html'),a=source.indexOf('  async function saveSplitFull('),b=source.indexOf('\n  service.saveQuizQuestions=async',a);let calls=[];
 const save=vm.runInNewContext(source.slice(a,b)+'\nsaveSplitFull',{uid:uuid,LIBRARY_ID:library,QCHUNK:2000,markOwnQuizWrite:()=>{},saveOptions:async()=>({expectedRevision:0,saveId:uuid()}),quizRpc:async(name)=>{calls.push(name);throw Object.assign(Error('Missing RPC'),{code:'PGRST202'})}});
 await assert.rejects(save('quiz',qs(1),{}),/Missing/);assert.deepEqual(calls,['student_begin_quiz_save_v2']);
});
test('Metadata patches preserve unknown fields and source reconciliation compares typed timestamps',async()=>{
 const id=await fixture();await admin(()=>db.query("update student_library_items set personalized=false,source_updated_at='2026-10-19T01:00:00Z',payload=payload||'{\"student_favorite\":true,\"custom_field\":\"keep\"}' where id=$1",[id]));
 const row=await call('student_patch_item_v2',[library,id,JSON.stringify({title:'Rename'}),false]);assert.equal(row.payload.custom_field,'keep');assert.equal(row.payload.student_favorite,true);
 const updated=await call('student_reconcile_item_v2',[library,id,JSON.stringify({...row.payload,title:'Updated source'}),'2026-10-19T02:00:00Z','2026-10-19T01:00:00+00:00']);assert.equal(updated.payload.title,'Updated source');assert.equal(updated.payload.student_favorite,true);
 const older=await call('student_reconcile_item_v2',[library,id,JSON.stringify({...row.payload,title:'Older source'}),'2026-10-19T00:00:00Z','2026-10-19T02:00:00Z']);assert.equal(older.payload.title,'Updated source');
 await call('student_patch_item_v2',[library,id,JSON.stringify({title:'Private edit'}),true]);
 const refused=await call('student_reconcile_item_v2',[library,id,JSON.stringify({...row.payload,title:'Stale source'}),'2026-10-19T03:00:00Z','2026-10-19T02:00:00+00:00']);assert.equal(refused.payload.title,'Private edit');
});
test('Existing plan limits still control creation; editing a saved quiz at the limit works',async()=>{
 const id=await fixture(),head=await read(id);
 await admin(()=>db.exec(`update ql_plans set limits='{"quizzes":0,"folders":0,"pdfs":0,"links":0}' where id='free'`));
 for(const [kind,key] of [['quiz','quizzes'],['folder','folders'],['pdf','pdfs'],['link','links']]){
  await assert.rejects(db.query("insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,$4)",[A,library,uuid(),JSON.stringify({kind})]),new RegExp('plan_limit:'+key));
 }
 const row=await call('student_patch_quiz_v2',[uuid(),library,id,'[]','{"layout":"vertical"}',head.revision]);assert.equal(row.item.payload.quiz_settings.layout,'vertical');
 const save=await start(id,qs(2));await stageAll(save,qs(2));await finish(save);assert.equal((await read(id)).count,2);
 await admin(()=>db.exec("update ql_plans set limits='{}' where id='free'"));
});
test('Account deletion cascades staging without tombstone triggers blocking it',async()=>{
 const item=uuidItems?uuid():'delete-account-quiz';
 await admin(()=>db.query("insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,'{\"kind\":\"quiz\",\"_student_q_split\":true}')",[B,library,item]));
 await identity(B);const head=await read(item),save=uuid();await call('student_begin_quiz_save_v2',[save,library,item,1,'{}',head.revision]);await stage(save,0,qs(1));
 await admin(async()=>{await db.query('delete from auth.users where id=$1',[B]);assert.equal((await db.query('select count(*) n from student_quiz_saves_v2 where user_id=$1',[B])).rows[0].n,0);assert.equal((await db.query('select count(*) n from student_quiz_save_versions_v2 where user_id=$1',[B])).rows[0].n,0);assert.equal((await db.query('select count(*) n from auth.users where id=$1',[A])).rows[0].n,1)});
});

test('Deleting the parent library cascades quiz rows and unfinished saves',async()=>{
 const id=await fixture(),save=await start(id,qs(2));await stage(save,0,qs(2));
 await admin(async()=>{
  await db.query('delete from libraries where id=$1',[library]);
  for(const table of ['student_library_items','student_quiz_questions','student_quiz_saves_v2']){
   assert.equal((await db.query(`select count(*) n from ${table} where library_id::text=$1`,[library])).rows[0].n,0);
  }
 });
});
