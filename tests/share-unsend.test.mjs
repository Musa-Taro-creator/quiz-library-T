// Unsend and "Recently sent" (supabase/share_unsend.sql) in a local PGlite database.
import assert from 'node:assert/strict';import fs from 'node:fs';import {test,before,after} from 'node:test';
import {createObservedTables} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite(),root=new URL('../',import.meta.url);
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
async function identity(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await identity()}}
async function rpc(name,args=[]){return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value}
async function rows(name,args=[]){return (await db.query(`select * from public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args)).rows}
const send=(to,kind='folder',title='Notes',ref='r')=>rpc('ql_send_item_share',[to,kind,title,1,JSON.stringify({version:1,kind,root_ref:ref,nodes:[{ref,kind,title}]})]);
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
 await identity();await send('QL-BBBBBBBB','pdf','Shared before the update','item-old');
 await db.exec('reset role');
 await db.exec(file('supabase/dashboard.sql'));await db.exec(file('supabase/dashboard_reliable_posting_v2.sql'));
 await db.exec(file('supabase/share_history.sql'));await db.exec(file('supabase/share_unsend.sql'));await db.exec(file('supabase/share_history.sql'));await db.exec(file('supabase/share_unsend.sql'));await db.exec(file('supabase/share_history.sql'));
 await identity();
});after(()=>db.close());


const hist=async()=>rows('ql_share_history',[100]);
test('Each share remembers its item; earlier waiting shares are filled in (file run twice)',async()=>{
 const h=await hist();assert.equal(h[0].source_item_id,'item-old');
 await send('QL-BBBBBBBB','quiz','Cardio','item-quiz');
 assert.equal((await hist()).find(x=>x.title==='Cardio').source_item_id,'item-quiz');
});
test('Unsend a waiting share: it leaves the receiver Inbox, count and History; the sender sees Unsent',async()=>{
 const id=await send('QL-CCCCCCCC','pdf','Wrong person','item-pdf');
 await identity(C);assert.equal(await rpc('ql_received_item_share_count'),1);
 await identity();assert.equal(await rpc('ql_unsend_item_share',[id]),'unsent');
 assert.equal(await rpc('ql_unsend_item_share',[id]),'unsent','pressing twice is fine');
 const mine=(await hist()).find(x=>x.share_record_id===id);assert.equal(mine.status,'unsent');assert.equal(mine.source_item_id,'item-pdf');
 await identity(C);
 assert.equal(await rpc('ql_received_item_share_count'),0);
 assert.deepEqual(await rows('ql_received_item_shares'),[]);
 assert.equal(await rpc('ql_get_received_item_share',[id]),null,'the content can no longer be opened');
 assert.ok(!(await hist()).some(x=>x.share_record_id===id),'the receiver sees nothing at all');
 await rpc('ql_finish_item_share',[id,true]);
 await identity();assert.equal((await hist()).find(x=>x.share_record_id===id).status,'unsent','a late Save does not bring it back');
 assert.deepEqual(await admin(async()=>(await db.query('select payload from ql_item_shares where id=$1',[id])).rows[0].payload),{},'the copy is deleted');
});
test('Saved or dismissed shares cannot be unsent; only the sender can unsend',async()=>{
 const saved=await send('QL-BBBBBBBB','quiz','Kept','item-k'),dismissed=await send('QL-BBBBBBBB','link','Nope','item-n'),other=await send('QL-BBBBBBBB','pdf','Mine','item-m');
 await identity(B);await rpc('ql_finish_item_share',[saved,true]);await rpc('ql_finish_item_share',[dismissed,false]);
 await assert.rejects(rpc('ql_unsend_item_share',[other]),/not found/,'the receiver cannot unsend');
 await identity(C);await assert.rejects(rpc('ql_unsend_item_share',[other]),/not found/);
 await identity();
 await assert.rejects(rpc('ql_unsend_item_share',[saved]),/already saved/);
 await assert.rejects(rpc('ql_unsend_item_share',[dismissed]),/dismissed/);
 await assert.rejects(rpc('ql_unsend_item_share',['00000000-0000-4000-8000-000000000000']),/not found/);
 const h=await hist();assert.equal(h.find(x=>x.share_record_id===saved).status,'saved');assert.equal(h.find(x=>x.share_record_id===other).status,'pending');
 await identity(B);assert.equal(await rpc('ql_received_item_share_count'),3,'Shared before the update, Cardio and Mine are still waiting');
 await identity(null,'anon');await assert.rejects(rpc('ql_unsend_item_share',[other]),/permission denied/);await identity();
});
test('The receiver side never shows the sender item id',async()=>{
 await identity(B);assert.ok((await hist()).every(x=>x.direction==='received'&&x.source_item_id===null));await identity();
});
