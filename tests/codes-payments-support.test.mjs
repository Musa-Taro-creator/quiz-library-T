// Upgrade codes, payment receipts and Help & Support messages, through the real SQL.
// Disposable local PGlite only, never Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test,before,after} from 'node:test';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite(),root=new URL('../',import.meta.url);
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ADMIN='99999999-9999-4999-8999-999999999999';
const sql=n=>fs.readFileSync(new URL('supabase/'+n,root),'utf8').replace(/create extension if not exists pg_net[^;]*;/gi,'');
async function as(uid){await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid])}
async function owner(fn){await db.exec('reset role');return fn()}
const call=async(fn,...args)=>(await db.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as v`,args)).rows[0].v;
const photo='data:image/png;base64,'+'A'.repeat(200);
before(async()=>{
 await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());
 insert into auth.users(id,email) values('${A}','a@example.test'),('${B}','b@example.test'),('${ADMIN}','admin@example.test');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create schema extensions;create schema net;
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 1000) returns bigint language sql as $$select 1::bigint$$;`);
 for(const n of ['plans_admin.sql','plan_sale.sql','support_messages.sql','security_fixes.sql'])await db.exec(sql(n));
 await owner(()=>db.exec(`insert into ql_admins(user_id) values('${ADMIN}') on conflict do nothing`));
});
after(()=>db.close());

test('Upgrade code: a valid code switches the plan on, once per person',async()=>{
 await owner(()=>db.exec("insert into ql_activation_codes(code,plan_id,days,max_uses) values('QLP-TEST-0001','pro',30,2)"));
 await as(A);
 const r=await call('ql_redeem_code',' qlp-test-0001 ');          // spaces and lower case are accepted
 assert.equal(r.plan_id,'pro');assert.ok(new Date(r.ends_at)>new Date());
 assert.equal((await call('ql_my_plan')).plan.id??(await call('ql_my_plan')).plan_id,'pro');
 await assert.rejects(call('ql_redeem_code','QLP-TEST-0001'),/already used this code/);
});

test('Upgrade code: max uses, expiry, cancellation and wrong codes are refused',async()=>{
 await owner(()=>db.exec(`insert into ql_activation_codes(code,plan_id,days,max_uses,uses) values('QLP-FULL','pro',30,1,1);
  insert into ql_activation_codes(code,plan_id,days,expires_at) values('QLP-OLD','pro',30,now()-interval '1 day');
  insert into ql_activation_codes(code,plan_id,days,cancelled) values('QLP-OFF','pro',30,true)`));
 await as(B);
 await assert.rejects(call('ql_redeem_code','QLP-FULL'),/already been used/);
 await assert.rejects(call('ql_redeem_code','QLP-OLD'),/expired/);
 await assert.rejects(call('ql_redeem_code','QLP-OFF'),/cancelled/);
 await assert.rejects(call('ql_redeem_code','NOPE-NOPE'),/not valid/);
});

test('Upgrade code: a student cannot make codes (admin only)',async()=>{
 await as(A);
 await assert.rejects(call('ql_admin_create_codes','pro',30,1,7,'',1,null),/Admins only/);
 await as(ADMIN);
 const made=(await db.query("select * from public.ql_admin_create_codes('pro',30,1,7,'test',2,null)")).rows;
 assert.equal(made.length,2);for(const c of made)assert.match(c.code,/^QLP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('Payment receipt: the price comes from the server and only real pictures are accepted',async()=>{
 await as(B);
 await assert.rejects(call('ql_submit_payment','pro','month','javascript:alert(1)'+'x'.repeat(200)),/must be a photo/);
 await assert.rejects(call('ql_submit_payment','pro','month','tiny'),/photo of your receipt/);
 const id=await call('ql_submit_payment','pro','month',photo);
 const row=await owner(async()=>(await db.query('select amount,status,user_id from ql_payment_requests where id=$1',[id])).rows[0]);
 assert.equal(Number(row.amount),4);assert.equal(row.status,'waiting');assert.equal(row.user_id,B);
});

test('Payment receipt: approving switches the plan on; students cannot approve',async()=>{
 await as(B);
 const id=await call('ql_submit_payment','pro','month',photo);
 await assert.rejects(call('ql_admin_decide_payment',id,true,''),/Admins only/);
 await as(ADMIN);await call('ql_admin_decide_payment',id,true,'ok');
 await as(B);const mine=await call('ql_my_plan');
 assert.equal(mine.plan?.id??mine.plan_id,'pro');
});

test('Help & Support: student message reaches the admin, the reply reaches the student',async()=>{
 await as(A);
 await call('ql_support_send','Hello, I need help',null);
 await assert.rejects(call('ql_support_send','bad picture','javascript:alert(1)'+'x'.repeat(200)));
 await as(ADMIN);
 assert.ok(Number(await call('ql_admin_support_unread'))>=1);
 const list=await call('ql_admin_support_list');
 assert.ok(JSON.stringify(list).includes('Hello, I need help'));
 await call('ql_admin_support_reply',A,'We fixed it',null);
 await as(A);
 assert.equal(Number(await call('ql_support_unread')),1);
 const mine=JSON.stringify(await call('ql_support_mine'));
 assert.ok(mine.includes('Hello, I need help')&&mine.includes('We fixed it'));
 await as(B);
 assert.ok(!JSON.stringify(await call('ql_support_mine')).includes('Hello, I need help'),'another student cannot read it');
 await assert.rejects(call('ql_admin_support_list'),/Admins only/);
});
