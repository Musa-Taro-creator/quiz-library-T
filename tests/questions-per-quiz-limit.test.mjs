// "Questions per quiz" is enforced by the database, through the real quiz-save functions.
// Disposable local PGlite only, never Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test,before,after} from 'node:test';
import {createObservedTables,installObservedItemLimits} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite(),root=new URL('../',import.meta.url);
const library='33333333-3333-4333-8333-333333333333';
const A='11111111-1111-4111-8111-111111111111';
let counter=0;const uuid=()=>`dddddddd-dddd-4ddd-8ddd-${String(++counter).padStart(12,'0')}`;
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
async function identity(){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[A])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function call(name,args=[]){return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value}
const q=(id,i)=>({id,prompt:'Question '+id,type:'true_false',correct_answer:false,question_position:i});
const qs=(n,prefix='q')=>Array.from({length:n},(_,i)=>q(prefix+i,i));
const read=id=>call('student_read_quiz_page_v2',[library,id,0,null]);
async function save(id,questions){
 const head=await read(id),s=uuid();
 await call('student_begin_quiz_save_v2',[s,library,id,questions.length,JSON.stringify({shuffle:false}),head.revision]);
 await call('student_stage_quiz_batch_v2',[s,0,JSON.stringify(questions)]);
 return call('student_finalize_quiz_save_v2',[s]);
}
async function quiz(existing=0){
 const id=uuid();
 await db.query('insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,$4)',[A,library,id,JSON.stringify({kind:'quiz',title:'Quiz',quiz_settings:{question_count:existing},_student_q_split:true})]);
 if(existing)await admin(async()=>{for(let i=0;i<existing;i++)await db.query('insert into student_quiz_questions(user_id,library_id,item_id,id,position,data) values($1,$2,$3,$4,$5,$6)',[A,library,id,'old'+i,i,JSON.stringify(q('old'+i,i))])});
 return id;
}
const setLimit=n=>admin(()=>db.query("update ql_plans set limits=$1 where id='free'",[JSON.stringify(n==null?{}:{questions_per_quiz:n})]));
before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${A}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
 create table libraries(id uuid primary key);insert into libraries values('${library}');
 create table student_library_items(user_id uuid references auth.users(id) on delete cascade,library_id uuid references libraries(id) on delete cascade,id uuid,payload jsonb not null default '{}'::jsonb,personalized boolean not null default true,source_updated_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),primary key(user_id,library_id,id));
 alter table student_library_items enable row level security;create policy own on student_library_items for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());grant all on student_library_items to authenticated;`);
 await createObservedTables(db,['ql_site_settings','ql_plans','ql_subscriptions']);
 await db.exec("insert into ql_plans(id,name,is_default) values('free','Free',true)");
 await installObservedItemLimits(db);
 await db.exec(file('supabase/student_quiz_split_storage.sql'));
 await db.exec(file('supabase/student_quiz_atomic_save_v2.sql'));
 await db.exec(file('supabase/questions_per_quiz_limit.sql'));
 await db.exec(file('supabase/questions_per_quiz_limit.sql'));   // safe to run again
 await identity();
});
after(()=>db.close());

test('A save that goes past the limit is refused and changes nothing',async()=>{
 await setLimit(3);const id=await quiz(0);
 await assert.rejects(save(id,qs(4)),/plan_limit:questions_per_quiz/);
 const after=await read(id);assert.equal(after.count,0);assert.equal(after.item.payload.quiz_settings.question_count,0);
});

test('Saves up to the limit work',async()=>{
 await setLimit(3);const id=await quiz(0);
 await save(id,qs(3));
 assert.equal((await read(id)).count,3);
});

test('A quiz already bigger than the limit can still be edited, but not made bigger',async()=>{
 await setLimit(null);const id=await quiz(5);await setLimit(3);   // made before the limit
 await save(id,qs(5,'edited'));                       // same size: allowed
 assert.equal((await read(id)).count,5);
 await assert.rejects(save(id,qs(6)),/plan_limit:questions_per_quiz/);
 await save(id,qs(4));                                // smaller: allowed
 assert.equal((await read(id)).count,4);
});

test('Unlimited plans are not affected',async()=>{
 await setLimit(null);const id=await quiz(0);
 await save(id,qs(50));
 assert.equal((await read(id)).count,50);
});

test('A quiz inserted directly with too many questions is refused',async()=>{
 await setLimit(3);
 await assert.rejects(db.query('insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,$4)',[A,library,uuid(),JSON.stringify({kind:'quiz',title:'Big',_student_questions:qs(4)})]),/plan_limit:questions_per_quiz/);
});

test('Other items and edits are not affected',async()=>{
 await setLimit(0);
 const id=uuid();
 await db.query('insert into student_library_items(user_id,library_id,id,payload) values($1,$2,$3,$4)',[A,library,id,JSON.stringify({kind:'folder',title:'Folder'})]);
 await db.query("update student_library_items set payload=payload||'{\"title\":\"Renamed\"}' where id=$1",[id]);
});

test("Copies of the admin's shared quizzes are not limited, also when the student edits one",async()=>{
 await setLimit(3);const id=uuid();
 await db.query('insert into student_library_items(user_id,library_id,id,payload,personalized) values($1,$2,$3,$4,false)',[A,library,id,JSON.stringify({kind:'quiz',title:'Admin quiz',quiz_settings:{question_count:5},_student_questions:qs(5)})]);
 await db.query("update student_library_items set payload=payload||'{\"title\":\"Synced again\"}' where id=$1",[id]);
 await db.query("update student_library_items set personalized=true,payload=payload||'{\"title\":\"Now my own\"}' where id=$1",[id]);
});
