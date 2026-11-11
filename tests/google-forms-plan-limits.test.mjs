// Plan limits for Make Google Form (supabase/google_forms_plan_limits.sql) in PGlite: per day + questions per form.
import assert from 'node:assert/strict';import fs from 'node:fs';import {test,before,after} from 'node:test';
import {createObservedTables} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite(),root=new URL('../',import.meta.url);
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ADM='33333333-3333-4333-8333-333333333333';
const URL1='https://script.google.com/macros/s/AKfycbOne/exec',URL2='https://script.google.com/macros/s/AKfycbTwo/exec';
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
async function as(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await as()}}
async function rpc(name,args=[]){return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value}
const reserve=(t='Quiz',n=3)=>rpc('ql_gform_reserve',[t,n,'paste']);
const service=fn=>admin(async()=>{await db.exec('set role service_role');try{return await fn()}finally{await db.exec('reset role')}});
before(async()=>{await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');insert into auth.users(id,email) values('${A}','bona@example.test'),('${B}','chea@example.test'),('${ADM}','admin@example.test');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon,service_role;
 grant usage on schema public to service_role;`);
 await createObservedTables(db,['ql_site_settings','ql_plans','ql_subscriptions']);
 await db.exec(`alter table ql_site_settings add primary key (key);insert into ql_site_settings(key,value) values('features','{}');insert into ql_plans(id,name,features,is_default) values('free','Free','{}',true);
 create function ql__default_plan() returns text language sql as $$select 'free'::text$$;
 create function ql__effective_plan(p_uid uuid) returns text language sql stable security definer set search_path=public as $$select coalesce((select plan_id from ql_subscriptions where user_id=p_uid and status='active'),'free')$$;
 create table ql_admins(user_id uuid primary key);insert into ql_admins values('${ADM}');
 create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from ql_admins where user_id=p_uid)$$;
 create function ql__need_admin() returns void language plpgsql stable security definer set search_path=public as $$begin if auth.uid() is null or not exists(select 1 from ql_admins where user_id=auth.uid()) then raise exception 'Admins only' using errcode='42501';end if;end$$;
 create table student_share_profiles(user_id uuid,share_id text,display_name text);insert into student_share_profiles values('${A}','QL-BONA0003','Bona');`);
 await db.exec(file('supabase/dashboard.sql').split('-- The payload without quiz questions')[0]);
 await db.exec(file('supabase/item_sharing.sql'));
 await db.exec(file('supabase/google_forms.sql'));await db.exec(file('supabase/google_forms_user_limits.sql'));await db.exec(file('supabase/google_forms_plan_limits.sql'));
 // running any of the three files again, in any order, keeps the same functions
 await db.exec(file('supabase/google_forms_plan_limits.sql'));await db.exec(file('supabase/google_forms.sql'));await db.exec(file('supabase/google_forms_user_limits.sql'));
 await db.exec(`alter table ql_subscriptions add primary key (user_id);insert into ql_plans(id,name,features,limits,is_default) values('pro','Pro','{}','{}',false)`);
 await as(ADM);await db.query('select public.ql_admin_gform_save($1,$2,$3)',[URL1,'s1',5]);
 await as();
});after(()=>db.close());



const mine=()=>rpc('ql_gform_mine');
const setUser=(u,mode,n=null)=>rpc('ql_admin_gform_user_rule_set',[u,mode,n]);
const planLimits=(id,limits)=>admin(()=>db.query('update ql_plans set limits=$1 where id=$2',[JSON.stringify(limits),id]));
const onPlan=(u,plan)=>admin(()=>db.query(`insert into ql_subscriptions(user_id,plan_id,status) values($1,$2,'active') on conflict (user_id) do update set plan_id=excluded.plan_id,status='active'`,[u,plan]));
const reserveQ=n=>rpc('ql_gform_reserve',['Quiz',n,'paste']);
const reset=()=>admin(()=>db.exec(`update ql_google_forms set created_at=now()-interval '2 days' where created_at>now()-interval '1 day'`));

test('Existing plans (nothing set): the global number and 200 questions — nothing changes',async()=>{
 await as(A);const m=await mine();assert.deepEqual([m.mode,m.limit,m.max_questions,m.plan_name],['default',5,200,'Free']);
 await onPlan(A,'pro');assert.deepEqual([(await mine()).mode,(await mine()).limit,(await mine()).plan_name],['default',5,'Pro']);
});
test('A plan number is used and shown with the plan name; the 11th form waits for tomorrow',async()=>{
 await planLimits('pro',{gform_per_day:10});await as(A);
 const m=await mine();assert.deepEqual([m.mode,m.limit,m.left,m.plan_name],['plan',10,10,'Pro']);
 const r=await reserve('one');assert.deepEqual([r.mode,r.plan_name,r.limit,r.left],['plan','Pro',10,9]);
 for(let i=0;i<9;i++)await reserve('Q'+i);await assert.rejects(reserve('11th'),/10 Google Forms a day/);
 await as(B);assert.equal((await mine()).limit,5,'someone on Free keeps the global number');await reset();
});
test('Plan Unlimited uses the safety cap; plan 0 means the plan has no Google Forms',async()=>{
 await planLimits('pro',{gform_per_day:'unlimited'});await as(A);let m=await mine();assert.deepEqual([m.mode,m.unlimited,m.limit,m.cap],['plan',true,null,100]);
 await as(ADM);await rpc('ql_admin_gform_cap_set',[2]);await as(A);await reserve('a');await reserve('b');await assert.rejects(reserve('c'),/safety limit/);await reset();
 await as(ADM);await rpc('ql_admin_gform_cap_set',[100]);
 await planLimits('pro',{gform_per_day:0});await as(A);await assert.rejects(reserve('x'),/plan does not include Google Forms/);assert.equal((await mine()).left,0);
 await planLimits('pro',{gform_per_day:5000});await as(A);assert.equal((await mine()).limit,1000,'kept between 0 and 1000');
});
test('Priority: admin > Users → Manage > plan > global',async()=>{
 await planLimits('pro',{gform_per_day:10});
 await as(ADM);await setUser(A,'custom',3);await as(A);assert.deepEqual([(await mine()).mode,(await mine()).limit],['custom',3]);
 await as(ADM);await setUser(A,'unlimited');await as(A);assert.equal((await mine()).mode,'unlimited');
 await as(ADM);await setUser(A,'default');await as(A);assert.deepEqual([(await mine()).mode,(await mine()).limit],['plan',10]);
 await onPlan(ADM,'pro');await as(ADM);const me=await mine();assert.deepEqual([me.mode,me.unlimited,me.max_questions],['admin',true,200]);
 await as(ADM);const g=await rpc('ql_admin_gform_user_rule_get',[A]);assert.deepEqual([g.mode,g.limit,g.plan_name],['plan',10,'Pro']);
});
test('Questions per form from the plan (1–200), with a clear message',async()=>{
 await planLimits('pro',{gform_per_day:10,gform_questions:50});await as(A);
 assert.equal((await mine()).max_questions,50);
 await assert.rejects(reserveQ(80),/Your plan allows 50 questions per form — this has 80\./);
 assert.ok((await reserveQ(50)).record_id);
 await planLimits('pro',{gform_questions:500});await as(A);assert.equal((await mine()).max_questions,200,'never more than 200');
 await assert.rejects(reserveQ(201),/up to 200 questions/);
 await planLimits('pro',{gform_questions:null});await as(A);assert.equal((await mine()).max_questions,200,'Unlimited = 200');
 await planLimits('pro',{gform_questions:1});await as(ADM);assert.ok((await reserveQ(120)).record_id,'admin is not limited by a plan');
 await reset();
});
test('The shared functions are written the same in all three SQL files',()=>{
 const S='-- ------------------------------------------------------------------ same as google_forms.sql';
 const E='-- ------------------------------------------------------------------ end of "same as google_forms.sql"';
 const part=f=>{const s=file(f);return s.slice(s.indexOf(S),s.indexOf(E))};
 assert.ok(part('supabase/google_forms_plan_limits.sql').includes('gform_questions'));
 assert.equal(part('supabase/google_forms.sql'),part('supabase/google_forms_plan_limits.sql'));
 assert.equal(part('supabase/google_forms_user_limits.sql'),part('supabase/google_forms_plan_limits.sql'));
});
test('How many Google Forms (total for the plan): every form ever counts, deleted ones too; failed ones do not',async()=>{
 await admin(()=>db.exec(`delete from ql_google_forms where user_id='${B}'`));
 await onPlan(B,'pro');await planLimits('pro',{gform_total:3,gform_per_day:10});await as(B);
 let m=await mine();assert.deepEqual([m.mode,m.period,m.limit,m.left,m.used_total,m.plan_name],['plan_total','total',3,3,0,'Pro'],'the total wins over an older per-day number');
 const r=await reserve('one');assert.deepEqual([r.mode,r.limit,r.left],['plan_total',3,2]);
 await reserve('two');
 // made on another day, finished, then deleted from My Google Forms: still counts
 await admin(()=>db.exec(`update ql_google_forms set status='ready',removed=true,created_at=now()-interval '20 days' where user_id='${B}'`));
 await as(B);m=await mine();assert.deepEqual([m.left,m.used_total,m.used_today],[1,2,0]);
 // a form that failed to make does not count
 const failed=await reserve('fails');await admin(()=>db.query(`update ql_google_forms set status='failed' where id=$1`,[failed.record_id]));
 await as(B);assert.equal((await mine()).left,1);
 await reserve('three');await assert.rejects(reserve('four'),/You have made all 3 Google Forms in the Pro plan\. Forms you delete still count\. Upgrade to make more\./);
 await as(ADM);const g=await rpc('ql_admin_gform_user_rule_get',[B]);assert.deepEqual([g.mode,g.limit,g.used_total],['plan_total',3,3]);
 // a bigger total on the plan gives room again; the daily safety cap still applies
 await planLimits('pro',{gform_total:50});await as(ADM);await rpc('ql_admin_gform_cap_set',[2]);await as(B);
 assert.equal((await mine()).left,1,'2 a day safety cap, 1 already made today');await reserve('five');await assert.rejects(reserve('six'),/safety limit/);
 await as(ADM);await rpc('ql_admin_gform_cap_set',[100]);
 // Unlimited total = no plan total (safety cap only); 0 = the plan has no Google Forms
 await planLimits('pro',{gform_total:'unlimited'});await as(B);m=await mine();assert.deepEqual([m.mode,m.unlimited,m.period],['plan',true,'day']);
 await planLimits('pro',{gform_total:0});await as(B);await assert.rejects(reserve('x'),/plan does not include Google Forms/);
 // a person's own number (Users → Manage, per day) still wins over the plan
 await as(ADM);await setUser(B,'custom',4);await as(B);assert.deepEqual([(await mine()).mode,(await mine()).limit],['custom',4]);
 await as(ADM);await setUser(B,'default');await reset();
});
