// Per-person daily limit for Make Google Form (supabase/google_forms_user_limits.sql) in PGlite.
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
 create function ql__effective_plan(p_uid uuid) returns text language sql stable as $$select 'free'::text$$;
 create table ql_admins(user_id uuid primary key);insert into ql_admins values('${ADM}');
 create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from ql_admins where user_id=p_uid)$$;
 create function ql__need_admin() returns void language plpgsql stable security definer set search_path=public as $$begin if auth.uid() is null or not exists(select 1 from ql_admins where user_id=auth.uid()) then raise exception 'Admins only' using errcode='42501';end if;end$$;
 create table student_share_profiles(user_id uuid,share_id text,display_name text);insert into student_share_profiles values('${A}','QL-BONA0003','Bona');`);
 await db.exec(file('supabase/dashboard.sql').split('-- The payload without quiz questions')[0]);
 await db.exec(file('supabase/item_sharing.sql'));
 await db.exec(file('supabase/google_forms.sql'));await db.exec(file('supabase/google_forms_user_limits.sql'));
 // running either file again (in any order) must keep the per-person limits
 await db.exec(file('supabase/google_forms.sql'));await db.exec(file('supabase/google_forms_user_limits.sql'));await db.exec(file('supabase/google_forms.sql'));
 await as(ADM);await db.query('select public.ql_admin_gform_save($1,$2,$3)',[URL1,'s1',5]);
 await as();
});after(()=>db.close());


const mine=()=>rpc('ql_gform_mine');
const set=(u,mode,n=null)=>rpc('ql_admin_gform_user_rule_set',[u,mode,n]);
const fail=id=>service(()=>rpc('ql_gform__fail',[id,'test']));
async function makeN(n){const out=[];for(let i=0;i<n;i++)out.push(await reserve('Q'+i));return out}
const reset=()=>admin(()=>db.exec(`update ql_google_forms set created_at=now()-interval '2 days' where created_at>now()-interval '1 day'`));

test('Default: the global number (5); students cannot change their own limit',async()=>{
 await as(A);const m=await mine();assert.deepEqual([m.mode,m.unlimited,m.limit,m.left,m.cap],['default',false,5,5,100]);
 await assert.rejects(set(A,'unlimited'),/Admins only/);await assert.rejects(rpc('ql_admin_gform_user_rules'),/Admins only/);
 await assert.rejects(db.query('select * from ql_gform_user_limits'),/permission denied/);
 await makeN(5);await assert.rejects(reserve('6th'),/5 Google Forms a day/);await reset();
});
test('A custom number for one person, including 0 and up to 1000',async()=>{
 await as(ADM);const r=await set(A,'custom',2);assert.deepEqual([r.mode,r.limit,r.global],['custom',2,5]);
 await as(A);assert.deepEqual([(await mine()).limit,(await mine()).left],[2,2]);
 await makeN(2);await assert.rejects(reserve('3rd'),/2 Google Forms a day/);
 await as(B);assert.equal((await mine()).limit,5,'others keep the default');
 await as(ADM);await set(A,'custom',1);await as(A);await assert.rejects(reserve('x'),/1 Google Form a day/);
 await as(ADM);await set(A,'custom',0);await as(A);await assert.rejects(reserve('x'),/turned off for your account/);assert.equal((await mine()).left,0);
 await as(ADM);await set(A,'custom',1000);await assert.rejects(set(A,'custom',1001),/0 to 1000/);await assert.rejects(set(A,'custom',-1),/0 to 1000/);
 await assert.rejects(set(A,'weekly',3),/Choose Default/);await assert.rejects(set('99999999-9999-4999-8999-999999999999','unlimited'),/not found/);
 await as(A);assert.equal((await mine()).limit,1000);await reset();
});
test('Unlimited: no daily number, but the safety cap (100, Admin can change) still stops runaway use',async()=>{
 await as(ADM);await set(A,'unlimited');await as(A);let m=await mine();assert.deepEqual([m.mode,m.unlimited,m.limit,m.cap,m.left],['unlimited',true,null,100,100]);
 const r=await reserve('one');assert.deepEqual([r.unlimited,r.limit,r.left],[true,null,99]);
 await as(ADM);await assert.rejects(rpc('ql_admin_gform_cap_set',[0]),/1 to 1000/);assert.equal(await rpc('ql_admin_gform_cap_set',[3]),3);assert.equal(await rpc('ql_admin_gform_cap_get'),3);
 await as(A);await makeN(2);await assert.rejects(reserve('4th'),/3 Google Forms today, the safety limit/);
 m=await mine();assert.deepEqual([m.unlimited,m.left,m.cap],[true,0,3]);
 await as(ADM);assert.equal((await rpc('ql_admin_gform_get')).daily_limit,5,'the global number is untouched');await reset();
});
test('Admin accounts are Unlimited by themselves; Default removes the setting; badges list',async()=>{
 await as(ADM);const me=await mine();assert.deepEqual([me.mode,me.unlimited],['admin',true]);
 const rules=await rpc('ql_admin_gform_user_rules');assert.deepEqual(rules,{[A]:{unlimited:true,daily_limit:null}});
 await set(B,'custom',7);assert.deepEqual((await rpc('ql_admin_gform_user_rules'))[B],{unlimited:false,daily_limit:7});
 const g=await rpc('ql_admin_gform_user_rule_get',[B]);assert.deepEqual([g.mode,g.limit,g.used_today],['custom',7,0]);
 await set(A,'default');assert.ok(!(A in await rpc('ql_admin_gform_user_rules')));
 await as(A);assert.deepEqual([(await mine()).mode,(await mine()).limit],['default',5]);
 await admin(()=>db.exec(`delete from auth.users where id='${B}'`));await as(ADM);assert.deepEqual(await rpc('ql_admin_gform_user_rules'),{},'deleting the account removes its setting');
});
test('The shared functions are written the same in both SQL files',()=>{
 const S='-- ------------------------------------------------------------------ same as google_forms.sql';
 const E='-- ------------------------------------------------------------------ end of "same as google_forms.sql"';
 const part=f=>{const s=file(f);return s.slice(s.indexOf(S),s.indexOf(E))};
 assert.ok(part('supabase/google_forms.sql').includes('ql__gform_user_rule'));
 assert.equal(part('supabase/google_forms.sql'),part('supabase/google_forms_user_limits.sql'));
});
