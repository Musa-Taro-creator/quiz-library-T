// Share history and saved Quiz IDs (supabase/share_history.sql) in a local PGlite database.
import assert from 'node:assert/strict';import fs from 'node:fs';import {test,before,after} from 'node:test';
import {createObservedTables} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite(),root=new URL('../',import.meta.url);
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
async function identity(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function rpc(name,args=[]){return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value}
async function rows(name,args=[]){return (await db.query(`select * from public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)).rows}
const send=(to,kind='folder',title='Notes')=>rpc('ql_send_item_share',[to,kind,title,1,JSON.stringify({version:1,kind,root_ref:'r',nodes:[{ref:'r',kind,title}]})]);
before(async()=>{await db.exec(`create role authenticated;create role anon;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');insert into auth.users(id,email) values('${A}','a@example.test'),('${B}','b@example.test'),('${C}','c@example.test');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;`);
 await createObservedTables(db,['ql_site_settings','ql_plans','ql_subscriptions','quiz_external_shares']);
 await db.exec(`insert into ql_site_settings(key,value) values('features','{}');
 insert into ql_plans(id,name,features,is_default) values('free','Free','{}',true);
 create function ql__default_plan() returns text language sql as $$select 'free'::text$$;
 create function ql__effective_plan(p_uid uuid) returns text language sql stable security definer set search_path=public as $$
  select coalesce((select s.plan_id from ql_subscriptions s where s.user_id=p_uid and s.status='active' and (s.ends_at is null or s.ends_at>now()) and exists(select 1 from ql_plans p where p.id=s.plan_id)),ql__default_plan());$$;
 create table student_share_profiles(user_id uuid,share_id text,display_name text);
 insert into student_share_profiles values('${A}','QL-AAAAAAAA','Alice'),('${B}','QL-BBBBBBBB','Bona'),('${C}','QL-CCCCCCCC','Chea');`);
 await db.exec(file('tests/fixtures/deployed-quiz-share.sql'));
 await db.exec(file('supabase/item_sharing.sql'));
 await identity();await send('QL-BBBBBBBB','pdf','Shared before the update');
 await db.exec('reset role');
 await db.exec(file('supabase/dashboard.sql'));await db.exec(file('supabase/dashboard_reliable_posting_v2.sql'));
 await db.exec(file('supabase/share_history.sql'));await db.exec(file('supabase/share_history.sql'));
 await identity();
});after(()=>db.close());

test('Earlier shares get the receiver filled in and their ID remembered (file run twice)',async()=>{
 const h=await rows('ql_share_history');assert.equal(h.length,1);
 assert.deepEqual([h[0].direction,h[0].title,h[0].person_name,h[0].person_share_id,h[0].status],['sent','Shared before the update','Bona','QL-BBBBBBBB','pending']);
 const c=await rows('ql_share_contacts');assert.deepEqual(c.map(x=>[x.share_id,x.display_name,x.share_count]),[['QL-BBBBBBBB','Bona',1]]);
});
test('New shares (also quizzes) show as sent for the sender and received for the receiver',async()=>{
 await send('QL-BBBBBBBB','quiz','Anatomy quiz');await send('QL-CCCCCCCC','link','Slides');
 const mine=await rows('ql_share_history');assert.deepEqual(mine.map(x=>[x.direction,x.title,x.person_share_id]),[['sent','Slides','QL-CCCCCCCC'],['sent','Anatomy quiz','QL-BBBBBBBB'],['sent','Shared before the update','QL-BBBBBBBB']]);
 const c=await rows('ql_share_contacts');assert.deepEqual(c.map(x=>[x.share_id,x.share_count]).sort(),[['QL-BBBBBBBB',2],['QL-CCCCCCCC',1]]);
 await identity(B);const theirs=await rows('ql_share_history');
 assert.ok(theirs.every(x=>x.direction==='received'&&x.person_name==='Alice'&&x.person_share_id==='QL-AAAAAAAA'));assert.equal(theirs.length,2);
 const quiz=theirs.find(x=>x.title==='Anatomy quiz');await rpc('ql_finish_item_share',[quiz.share_record_id,true]);
 assert.equal((await rows('ql_share_history')).find(x=>x.title==='Anatomy quiz').status,'saved');
 assert.deepEqual(await rows('ql_share_contacts'),[],'receiving does not add saved IDs');
 await identity(C);assert.deepEqual((await rows('ql_share_history')).map(x=>x.title),['Slides']);
 await identity();assert.equal((await rows('ql_share_history')).find(x=>x.title==='Anatomy quiz').status,'saved','the sender sees it was saved');
});
test('Save an ID by hand, forget it, and the checks on bad IDs',async()=>{
 await identity(B);
 assert.deepEqual(await rpc('ql_save_share_contact',[' ql-cccccccc ']),{share_id:'QL-CCCCCCCC',display_name:'Chea'});
 await rpc('ql_save_share_contact',['QL-CCCCCCCC']);
 assert.deepEqual((await rows('ql_share_contacts')).map(x=>[x.share_id,x.share_count]),[['QL-CCCCCCCC',0]]);
 await assert.rejects(rpc('ql_save_share_contact',['QL-ZZZZZZZZ']),/No student was found/);
 await assert.rejects(rpc('ql_save_share_contact',['hello']),/valid Quiz ID/);
 await assert.rejects(rpc('ql_save_share_contact',['QL-BBBBBBBB']),/your own/);
 await rpc('ql_forget_share_contact',['ql-cccccccc']);assert.deepEqual(await rows('ql_share_contacts'),[]);
 await identity();assert.equal((await rows('ql_share_contacts')).length,2,'forgetting only touches your own list');
});
test('Nobody else can read the tables directly, and anon cannot call the functions',async()=>{
 await assert.rejects(db.query('select * from ql_share_contacts'),/permission denied/);
 await assert.rejects(db.query('select * from ql_item_shares'),/permission denied/);
 await identity(null,'anon');
 await assert.rejects(rows('ql_share_history'),/permission denied/);
 await assert.rejects(rows('ql_share_contacts'),/permission denied/);
 await assert.rejects(rpc('ql_save_share_contact',['QL-BBBBBBBB']),/permission denied/);
 await identity();
});
test('Rows added another way are filled in too, and deleting a user removes their saved IDs',async()=>{
 await admin(()=>db.exec(`insert into ql_item_shares(sender_id,recipient_id,kind,title,payload) values('${A}','${C}','pdf','Direct insert','{}')`));
 assert.equal((await rows('ql_share_history')).find(x=>x.title==='Direct insert').person_share_id,'QL-CCCCCCCC');
 await admin(()=>db.exec(`delete from auth.users where id='${A}'`));
 assert.equal(await admin(async()=>(await db.query(`select count(*)::int n from ql_share_contacts where owner_id='${A}'`)).rows[0].n),0);
});
