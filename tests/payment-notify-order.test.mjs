// Payment notifications survive re-running payment_review.sql. Disposable local PGlite only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test,before,after} from 'node:test';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite(),root=new URL('../',import.meta.url);
const U='11111111-1111-4111-8111-111111111111';
// pg_net is a Supabase extension; a local stand-in for net.http_post is created below.
const sql=n=>fs.readFileSync(new URL('supabase/'+n,root),'utf8').replace(/create extension if not exists pg_net[^;]*;/gi,'');
const run=async(...names)=>{for(const n of names)await db.exec(sql(n))};
const fnDef=async()=>(await db.query("select pg_get_functiondef('public.ql__push_on_payment()'::regprocedure) d")).rows[0].d;
async function pushes(action){
 await db.exec('delete from push_log');await action();
 return (await db.query('select title from push_log order by n')).rows.map(r=>r.title);
}
before(async()=>{
 await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 insert into auth.users(id,email,raw_user_meta_data) values('${U}','s@example.test','{"full_name":"Test Student"}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create schema extensions;create schema net;
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 1000) returns bigint language sql as $$select 1::bigint$$;`);
 await run('plans_admin.sql','plan_sale.sql','support_messages.sql','admin_push.sql','payment_review.sql',
           'khqr_payment.sql','khqr_autocheck.sql','khqr_auto_detect.sql');
 // Record notifications instead of sending them.
 await db.exec(`create table push_log(n serial,title text);
 create or replace function public.ql__push(p_title text,p_body text,p_url text,p_tag text default null) returns void language sql as $$insert into push_log(title) values(p_title)$$;`);
});
after(()=>db.close());

test('Re-running payment_review.sql keeps the KHQR-aware notification',async()=>{
 const before=await fnDef();assert.ok(before.includes('tg_op'));
 await run('payment_review.sql');await run('payment_review.sql');
 assert.equal(await fnDef(),before);
});

test('Showing a QR does not notify; a KHQR payment found by the phone does',async()=>{
 let id;
 assert.deepEqual(await pushes(async()=>{
  id=(await db.query(`insert into ql_payment_requests(user_id,plan_id,period,amount,status,method,bill,khqr,khqr_md5)
   values($1,'pro','month',4,'qr','khqr','QL-1','qr-text',md5('qr-text')) returning id`,[U])).rows[0].id;
 }),[]);
 assert.deepEqual(await pushes(()=>db.query(`update ql_payment_requests set status='approved',bakong_hash='h1' where id=$1`,[id])),['💰 Paid by KHQR — plan is on']);
});

test('A receipt upload still notifies once',async()=>{
 assert.deepEqual(await pushes(()=>db.query(`insert into ql_payment_requests(user_id,plan_id,period,amount,status,method)
   values($1,'pro','month',4,'waiting','receipt')`,[U])),['💳 New payment receipt']);
});

test('Without the KHQR version, payment_review.sql still installs its review-window version',async()=>{
 const fresh=new PGlite();
 try{
  await fresh.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
  create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  create schema extensions;create schema net;
  create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 1000) returns bigint language sql as $$select 1::bigint$$;`);
  for(const n of ['plans_admin.sql','plan_sale.sql','support_messages.sql','admin_push.sql','payment_review.sql'])await fresh.exec(sql(n));
  const d=(await fresh.query("select pg_get_functiondef('public.ql__push_on_payment()'::regprocedure) d")).rows[0].d;
  assert.ok(d.includes('tap to review'));
 }finally{await fresh.close()}
});
