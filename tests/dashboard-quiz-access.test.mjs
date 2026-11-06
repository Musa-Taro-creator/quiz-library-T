import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test,before,after} from 'node:test';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const POST='33333333-3333-4333-8333-333333333333',OTHER='44444444-4444-4444-8444-444444444444';
const sql=fs.readFileSync(new URL('../supabase/dashboard_quiz_access_v1.sql',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const grade=vm.runInNewContext(html.slice(html.indexOf('  function qzGradeQuestion('),html.indexOf('  function qzGradeAll('))+'\nqzGradeQuestion');
let seq=0;const uuid=()=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(++seq).padStart(12,'0')}`;
const questions=[
 {id:'one',type:'mcq',prompt:'First',options:['A','B'],correct_answer:0,points:2,session_labels:['A'],explanation:'First option'},
 {id:'two',type:'true_false',prompt:'False',correct_answer:false,points:1,session_label:'A'},
 {id:'three',type:'short_answer',prompt:'Capital',correct_answer:['Paris'],points:1,session_labels:['B']},
 {id:'four',type:'mcq',prompt:'Both',options:['A','B','C'],correct_answer:[0,2],allow_multiple:true,points:1,session_labels:['B']}
];
const node={ref:'quiz',kind:'quiz',title:'Dashboard test',quiz_settings:{layout:'vertical',pass_percent:60,show_answers:true},questions};
const answers=()=>questions.map((q,i)=>({question_id:q.id,given_answer:[0,false,' paris ',[2,0]][i]}));
async function identity(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function rpc(name,args){return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args.map(a=>a&&typeof a==='object'?JSON.stringify(a):a))).rows[0].value}
const get=(post=POST,ref='quiz')=>rpc('ql_dash_quiz_get_v1',[post,ref]);
const history=()=>rpc('ql_dash_quiz_history_v1',[POST,'quiz']);
const submit=async(a=answers(),session=null,id=uuid(),revision=null)=>rpc('ql_dash_quiz_submit_v1',[POST,'quiz',a,new Date().toISOString(),session,revision||(await get()).revision,id]);
before(async()=>{
 await db.exec(`create role authenticated;create role anon;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 insert into auth.users(id,email,raw_user_meta_data) values('${A}','a@example.test','{"full_name":"Student A"}'),('${B}','b@example.test','{"full_name":"Student B"}');
 create table public.ql_subscriptions(user_id uuid,status text);
 create table public.ql_dash_posts(id uuid primary key,owner_id uuid,status text,payload jsonb);
 create function existing_login_probe() returns text language sql as $$select 'unchanged'$$;
 `);
 await db.query('insert into ql_dash_posts values($1,$2,$3,$4)',[POST,A,'approved',JSON.stringify({root_ref:'root',nodes:[{ref:'root',kind:'folder'},node]})]);
 await db.query('insert into ql_dash_posts values($1,$2,$3,$4)',[OTHER,B,'pending',JSON.stringify({root_ref:'quiz',nodes:[node]})]);
 await db.exec(sql);await identity();
});
after(()=>db.close());
test('Migration is repeatable and leaves existing functions and posted content unchanged',async()=>{
 const before=await admin(async()=>({payload:(await db.query('select payload from ql_dash_posts where id=$1',[POST])).rows[0].payload,fn:(await db.query("select pg_get_functiondef('existing_login_probe()'::regprocedure) definition")).rows[0].definition}));
 await admin(()=>db.exec(sql));
 const after=await admin(async()=>({payload:(await db.query('select payload from ql_dash_posts where id=$1',[POST])).rows[0].payload,fn:(await db.query("select pg_get_functiondef('existing_login_probe()'::regprocedure) definition")).rows[0].definition}));
 assert.deepEqual(after,before);
});
test('Taking a posted quiz returns all sections and types without leaking answer keys',async()=>{
 const packet=await get();assert.equal(packet.questions.length,4);assert.equal(packet.title,node.title);
 assert.equal(packet.settings.pass_percent,60);assert.equal(packet.questions[3].allow_multiple,true);
 assert.deepEqual(packet.questions[2].session_labels,['B']);
 assert(packet.questions.every(q=>!Object.hasOwn(q,'correct_answer')&&!Object.hasOwn(q,'explanation')));
});
test('Private Tools persist and merge without changing author settings or accepting protected fields',async()=>{
 await rpc('ql_dash_quiz_tools_v1',[POST,'quiz',{layout:'horizontal',exam_ui:{theme:'paper'},questions:[],pass_percent:0}]);
 await rpc('ql_dash_quiz_tools_v1',[POST,'quiz',{shuffle_mode:'answers'}]);
 const p=await get();assert.equal(p.settings.layout,'horizontal');assert.equal(p.settings.shuffle_mode,'answers');assert.equal(p.settings.exam_ui.theme,'paper');assert.equal(p.settings.pass_percent,60);assert(!Object.hasOwn(p.settings,'questions'));
 await identity(B);const b=await get();assert.equal(b.settings.layout,'vertical');assert(!b.settings.exam_ui);await identity();
 const original=await admin(async()=>(await db.query("select payload->'nodes'->1->'quiz_settings' settings from ql_dash_posts where id=$1",[POST])).rows[0].settings);
 assert.deepEqual(original,node.quiz_settings);
});
test('Dashboard server grading matches normal grading for 82 valid and invalid True/False, MCQ and short answers',async()=>{
 const cases=[];
 for(const ca of [true,false,'true','false'])for(const given of [true,false,'true','false',null,'','invalid',0,1,[],{},'False','TRUE'])cases.push([{type:'true_false',correct_answer:ca},given]);
 for(const ca of [0,1,'1'])for(const given of [0,1,'1',null,''])cases.push([{type:'mcq',correct_answer:ca},given]);
 for(const given of [[0,2],[2,0],[0,0,2],['0','2'],[0],[],null,''])cases.push([{type:'mcq',correct_answer:[0,2]},given]);
 for(const given of ['Paris',' paris ','PARIS','London','',null,0])cases.push([{type:'short_answer',correct_answer:['Paris']},given]);
 await admin(async()=>{for(const [q,a] of cases){const actual=await rpc('ql__dash_quiz_grade_v1',[q,JSON.stringify(a)]);assert.equal(actual.correct,grade(q,a),JSON.stringify([q,a]));}});
 assert.equal(cases.length,82);
});
test('Full attempt score, review, retry receipt and account history are isolated',async()=>{
 const id=uuid(),r=await submit(answers(),null,id);assert.equal(r.percent,100);assert.equal(r.score,5);assert.equal(r.passed,true);assert.equal(r.detail.length,4);assert.equal(r.taker_name,'Student A');assert.equal(r.user_id,A);
 const retry=await submit(answers().map(a=>({...a,given_answer:null})),null,id);assert.deepEqual(retry,r);
 assert.equal((await history()).filter(a=>a.id===id).length,1);
 await identity(B);assert.deepEqual(await history(),[]);assert.equal((await submit()).user_id,B);assert.equal((await history()).length,1);await identity();assert.equal((await history()).length,1);
});
test('Section attempts use only that section, preserve unanswered False, and reject omitted, duplicate or foreign question IDs',async()=>{
 const a=answers().slice(0,2);const r=await submit(a,'A');assert.equal(r.max_score,3);assert.equal(r.score,3);assert.equal(r.session_name,'A');
 const blank=await submit(a.map(x=>({...x,given_answer:null})),'A');assert.equal(blank.score,0);
 for(const bad of [a.slice(0,1),[a[0],a[0]],[a[0],{question_id:'outside',given_answer:0}]])await assert.rejects(submit(bad,'A'),/Submit all/);
 await assert.rejects(submit(answers(),'Missing'),/no questions/);
});
test('Anonymous calls, pending posts, missing quizzes, stale revisions and direct table reads are denied',async()=>{
 const p=await get();await assert.rejects(get(OTHER),/no longer/);await assert.rejects(get(POST,'outside'),/no longer/);
 await assert.rejects(rpc('ql_dash_quiz_grade_v1',[POST,'quiz','outside',0,p.revision]),/not found/);
 await assert.rejects(rpc('ql_dash_quiz_grade_v1',[POST,'quiz','one',0,'old']),/changed/);
 await assert.rejects(submit(answers(),null,uuid(),'old'),/changed/);
 for(const t of ['ql_dash_quiz_attempts_v1','ql_dash_quiz_preferences_v1'])await assert.rejects(db.query('select * from '+t),/permission denied/);
 await identity(null,'anon');await assert.rejects(get(),/permission denied/);await identity(null);await assert.rejects(get(),/Sign in/);await identity();
});
test('Removed posts and suspended accounts cannot take, grade, submit or read history',async()=>{
 await admin(()=>db.exec(`insert into ql_subscriptions values('${A}','suspended')`));await assert.rejects(get(),/suspended/);await admin(()=>db.exec('delete from ql_subscriptions'));
 await admin(()=>db.query("update ql_dash_posts set status='removed' where id=$1",[POST]));await assert.rejects(get(),/no longer/);await assert.rejects(history(),/no longer/);await assert.rejects(submit(),/no longer/);
 await admin(()=>db.query("update ql_dash_posts set status='approved' where id=$1",[POST]));
});
