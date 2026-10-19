import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {createObservedTables,installObservedItemLimits} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const root=new URL('../',import.meta.url),file=name=>fs.readFileSync(new URL(name,root),'utf8');
const owner='11111111-1111-4111-8111-111111111111',library='33333333-3333-4333-8333-333333333333',item='44444444-4444-4444-8444-444444444444';
async function setup(db,dashboard=true){
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 insert into auth.users(id,email) values('${owner}','synthetic@example.test');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;
 create table libraries(id uuid primary key);insert into libraries values('${library}');
 create table student_library_items(user_id uuid not null references auth.users on delete cascade,library_id uuid not null references libraries on delete cascade,id uuid not null,payload jsonb not null default '{}',personalized boolean not null default true,source_updated_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),primary key(user_id,library_id,id));
 alter table student_library_items enable row level security;
 create policy own_items on student_library_items for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
 grant all on student_library_items to authenticated;`);
 await createObservedTables(db,['ql_site_settings','ql_plans','ql_subscriptions','quiz_external_shares']);
 await db.exec("insert into ql_plans(id,name,is_default) values('free','Free',true)");
 await installObservedItemLimits(db);
 await db.exec(file('supabase/student_quiz_split_storage.sql'));
 await db.exec(file('supabase/item_sharing.sql'));
 await db.exec(file('tests/fixtures/deployed-quiz-share.sql'));
 if(dashboard)await db.exec(file('supabase/dashboard.sql'));
 await db.exec(`insert into student_library_items(user_id,library_id,id,payload) values('${owner}','${library}','${item}','{"kind":"quiz","_student_q_split":true,"quiz_settings":{"shuffle":false},"title":"Existing saved quiz"}');
 insert into student_quiz_questions(user_id,library_id,item_id,id,data) values('${owner}','${library}','${item}','existing-question','{"prompt":"Keep this question","correct_answer":false}');
 grant truncate on student_library_items,student_quiz_questions to anon,authenticated;`);
}
test('Single-paste release script applies twice without rewriting existing quiz data',async()=>{
 const db=new PGlite();try{
  await setup(db);
  const before=(await db.query('select * from student_library_items')).rows;
  const questions=(await db.query('select * from student_quiz_questions')).rows;
  const sql=file('supabase/reliability_release_v2.sql');
  await db.exec(sql);await db.exec(sql);
  assert.deepEqual((await db.query('select * from student_library_items')).rows,before);
  assert.deepEqual((await db.query('select * from student_quiz_questions')).rows,questions);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
  const result=(await db.query(`select student_read_quiz_page_v2($1,$2) head`,[library,item])).rows[0].head;
  assert.equal(result.questions[0].id,'existing-question');
  const shared=(await db.query(`select ql_prepare_dash_quiz_v2(gen_random_uuid(),$1,$2,'Test','{"questions":[],"kind":"quiz"}') receipt`,[library,item])).rows[0].receipt;
  assert.match(shared.share_token,/^[a-f0-9-]{36}$/);
 }finally{await db.close()}
});
test('A failure in the Dashboard half rolls back the entire combined migration',async()=>{
 const db=new PGlite();try{
  await setup(db,false);
  await assert.rejects(db.exec(file('supabase/reliability_release_v2.sql')),/ql_dash_posts/);
  await db.exec('rollback');
  assert.equal((await db.query("select to_regclass('public.student_quiz_saves_v2') name")).rows[0].name,null);
  assert.equal((await db.query("select has_table_privilege('authenticated','student_quiz_questions','DELETE') allowed")).rows[0].allowed,true);
  assert.equal((await db.query('select count(*) n from student_quiz_questions')).rows[0].n,1);
 }finally{await db.close()}
});
