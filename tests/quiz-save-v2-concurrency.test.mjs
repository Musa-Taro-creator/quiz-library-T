// Starts its OWN disposable PostgreSQL, bound only to 127.0.0.1. No PG* env or
// production connection string is used. See README.md for test-only binaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {test,before,after} from 'node:test';
const {default:EmbeddedPostgres}=await import(process.env.QL_EMBEDDED_POSTGRES_MODULE||'embedded-postgres');
const pg=await import(process.env.QL_PG_MODULE||'pg');
const Client=pg.Client||pg.default.Client;
const root=new URL('../',import.meta.url);
const work=fs.mkdtempSync(path.join(os.tmpdir(),'ql-v2-native-'));
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const server=new EmbeddedPostgres({databaseDir:path.join(work,'cluster'),user:'postgres',password:'local-test-only',port,persistent:false,
  postgresFlags:['-c','listen_addresses=127.0.0.1','-c',`unix_socket_directories=${work}`],onLog:()=>{},onError:()=>{}});
const clients=[];let admin,a,b;
const library='33333333-3333-4333-8333-333333333333';
const owner='11111111-1111-4111-8111-111111111111';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(role=false){
  const c=new Client({host:'127.0.0.1',port,user:'postgres',password:'local-test-only',database:'postgres',connectionTimeoutMillis:5000});
  await c.connect();clients.push(c);
  await c.query(`set statement_timeout='10s'; set deadlock_timeout='100ms';`);
  if(role)await c.query(`set role authenticated; set request.jwt.claim.sub='${owner}';`);
  return c;
}
async function fixture(){
  const item=randomUUID();
  await admin.query(`insert into student_library_items(user_id,library_id,id,payload) values($1,'${library}',$2,'{"kind":"quiz","_student_q_split":true,"quiz_settings":{"question_count":1,"pass_percent":70}}')`,[owner,item]);
  await admin.query(`insert into student_quiz_questions(user_id,library_id,item_id,id,position,data) values($1,'${library}',$2,'old',0,'{"prompt":"original"}')`,[owner,item]);
  return item;
}
async function stage(c,item,id=randomUUID()){
  const head=(await c.query(`select student_read_quiz_page_v2('${library}',$1) as h`,[item])).rows[0].h;
  await c.query(`select student_begin_quiz_save_v2($1,'${library}',$2,1,'{"question_count":1,"pass_percent":80}',$3)`,[id,item,head.revision]);
  await c.query(`select student_stage_quiz_batch_v2($1,0,$2::jsonb)`,[id,JSON.stringify([{id:'replacement',question_position:0,prompt:'new'}])]);
  return id;
}
const finalize=(c,id)=>c.query('select student_finalize_quiz_save_v2($1)',[id]);
async function snapshot(item){
  const rows=(await admin.query('select id,data from student_quiz_questions where item_id=$1 order by position',[item])).rows;
  const settings=(await admin.query('select payload->\'quiz_settings\' as settings from student_library_items where id=$1',[item])).rows[0].settings;
  return {rows,settings};
}
async function waitForLock(c){
  const pid=(await c.query('select pg_backend_pid() as pid')).rows[0].pid;
  return pid;
}
async function blocked(pid){
  for(let i=0;i<100;i++){
    const r=await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[pid]);
    if(r.rows[0]?.wait_event_type==='Lock')return;
    await pause(10);
  }
  throw Error('Expected local lock wait was not observed');
}
before(async()=>{
  await server.initialise();await server.start();admin=await connect();
  await admin.query(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);insert into auth.users values('11111111-1111-4111-8111-111111111111');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    create table libraries(id uuid primary key);insert into libraries values('${library}');
    create table student_library_items(user_id uuid not null references auth.users(id) on delete cascade,library_id uuid not null references libraries(id) on delete cascade,id uuid not null,payload jsonb not null,personalized boolean not null default true,source_updated_at timestamptz,updated_at timestamptz default now(),primary key(user_id,library_id,id));
    alter table student_library_items enable row level security;
    create policy own_items on student_library_items for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    grant select,insert,update,delete on student_library_items to authenticated;`);
  const previous=fs.readFileSync(new URL('supabase/student_quiz_split_storage.sql',root),'utf8');
  await admin.query(previous.slice(previous.indexOf('create table if not exists'),previous.indexOf('-- ------------------------------------------------------ move existing data')));
  await admin.query(fs.readFileSync(new URL('supabase/student_quiz_atomic_save_v2.sql',root),'utf8'));
  a=await connect(true);b=await connect(true);
  console.log('Local native database:',(await admin.query('select version() as version')).rows[0].version);
});
after(async()=>{
  await Promise.allSettled(clients.map(c=>c.end()));
  await server.stop();fs.rmSync(work,{recursive:true,force:true});
});
test('simultaneous finalizers: exactly one wins; loser gets a revision conflict',async()=>{
  const item=await fixture(),sa=await stage(a,item),sb=await stage(b,item);
  const results=await Promise.allSettled([finalize(a,sa),finalize(b,sb)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected');assert.match(rejected.reason.message,/QL_CONFLICT/);
  assert.deepEqual(await snapshot(item),{rows:[{id:'replacement',data:{id:'replacement',question_position:0,prompt:'new'}}],settings:{question_count:1,pass_percent:80}});
});
test('uncommitted partial edit: finalizer waits, then rejects the stale baseline',async()=>{
 const item=await fixture(),save=await stage(b,item),pid=await waitForLock(b),head=(await a.query(`select student_read_quiz_page_v2('${library}',$1) h`,[item])).rows[0].h;
 await a.query('begin');await a.query(`select student_patch_quiz_v2($1,'${library}',$2,$3,'{\"pass_percent\":75}',$4)`,[randomUUID(),item,JSON.stringify([{id:'old',position:0,prompt:'edited'}]),head.revision]);
 const pending=finalize(b,save).then(()=>({ok:true}),error=>({error}));await blocked(pid);await a.query('commit');
 const result=await pending;assert.match(result.error.message,/QL_CONFLICT/);const current=await snapshot(item);assert.equal(current.rows[0].id,'old');assert.equal(current.rows[0].data.prompt,'edited');assert.equal(current.settings.pass_percent,75);
});
test('a reader cannot see the uncommitted replacement or mix it with old settings',async()=>{
 const item=await fixture(),save=await stage(b,item),pid=await waitForLock(a),old=await snapshot(item);
 await b.query('begin');await finalize(b,save);
 const pending=a.query(`select student_read_quiz_page_v2('${library}',$1) h`,[item]);await blocked(pid);assert.deepEqual(await snapshot(item),old);await b.query('commit');
 const result=(await pending).rows[0].h;assert.equal(result.questions[0].id,'replacement');assert.equal(result.item.payload.quiz_settings.pass_percent,80);
});
test('metadata locking conflict aborts one whole transaction without partial quiz loss',async()=>{
 const item=await fixture(),save=await stage(b,item),pid=await waitForLock(b);
 await a.query('begin');await a.query('select * from student_library_items where id=$1 for update',[item]);
 const pending=finalize(b,save).then(()=>({ok:true}),error=>({error}));await blocked(pid);
 const meta=await a.query(`select student_patch_item_v2('${library}',$1,'{\"title\":\"Renamed\"}',false)`,[item]).then(()=>({ok:true}),error=>({error}));await a.query(meta.error?'rollback':'commit');const final=await pending;
 assert.equal([meta,final].filter(x=>x.error?.code==='40P01').length,1);const current=await snapshot(item);assert.equal(current.rows.length,1);assert.ok(['old','replacement'].includes(current.rows[0].id));
 if(final.ok)assert.equal(current.settings.pass_percent,80);else assert.equal(current.settings.pass_percent,70);
});
test('server-side cancellation after deletion rolls back active rows and metadata',async()=>{
  const item=await fixture(),old=await snapshot(item),save=await stage(a,item),pid=await waitForLock(a);
  await admin.query(`create function test_pause_quiz_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(5);return null;end $$;
    create trigger test_pause_quiz_insert before insert on student_quiz_questions for each statement execute function test_pause_quiz_insert();`);
  const pending=finalize(a,save).then(()=>({ok:true}),error=>({error}));
  for(let i=0;i<100;i++){
    const r=await admin.query('select wait_event from pg_stat_activity where pid=$1',[pid]);
    if(r.rows[0]?.wait_event==='PgSleep')break;
    if(i===99)throw Error('Finalizer did not reach the injected pause');
    await pause(10);
  }
  await admin.query('select pg_cancel_backend($1)',[pid]);
  const result=await pending;assert.equal(result.error.code,'57014');assert.deepEqual(await snapshot(item),old);
  await admin.query('drop trigger test_pause_quiz_insert on student_quiz_questions;drop function test_pause_quiz_insert();');
  await finalize(a,save);assert.equal((await snapshot(item)).rows[0].id,'replacement');
});
