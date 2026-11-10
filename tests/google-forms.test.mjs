// "Make Google Form" database side (supabase/google_forms.sql) in a local PGlite database.
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
 await db.exec(file('supabase/google_forms.sql'));await db.exec(file('supabase/google_forms.sql'));
 await as();
});after(()=>db.close());

test('Nothing works until Admin saves an Apps Script address; Admin never sees the secret',async()=>{
 const mine=await rpc('ql_gform_mine');assert.deepEqual([mine.enabled,mine.set_up,mine.limit,mine.left,mine.forms],[true,false,5,5,[]]);
 await assert.rejects(reserve(),/not set up yet/);
 await assert.rejects(rpc('ql_admin_gform_save',[URL1,'s1',5]),/Admins only/);
 await as(ADM);
 await assert.rejects(rpc('ql_admin_gform_save',['https://example.com/x','s',5]),/Web app URL/);
 await assert.rejects(rpc('ql_admin_gform_save',[URL1,'',5]),/secret/);
 const cfg=await rpc('ql_admin_gform_save',[URL1,' secret-one ',5]);
 assert.equal(cfg.owners.length,1);assert.equal(cfg.owners[0].active,true);assert.ok(!JSON.stringify(cfg).includes('secret-one'));
 await as();assert.equal((await rpc('ql_gform_mine')).set_up,true);
 await assert.rejects(db.query('select * from ql_gform_owners'),/permission denied/);
 await assert.rejects(rpc('ql_gform__owner',[null]),/permission denied/);
 assert.deepEqual(await service(()=>rpc('ql_gform__owner',[null])),{script_url:URL1,secret:'secret-one',owner_email:null});
});
test('Five a day per student (Cambodia day); a failed or stuck form gives the place back',async()=>{
 const r=await reserve('Cardio',12);assert.equal(r.user_label,'Bona (QL-BONA0003)');assert.equal(r.left,4);assert.equal(r.user_id,A);
 const done=await service(()=>rpc('ql_gform__finish',[r.record_id,JSON.stringify({form_id:'F1',title:'Cardio',question_count:12,responder_url:'https://forms.gle/x',edit_url:'https://docs.google.com/forms/d/F1/edit',folder_url:'https://drive.google.com/drive/folders/D1',owner:'quizlibrary.forms@gmail.com',editor_email:'bona@gmail.com'})]));
 assert.equal(done.form_id,'F1');assert.equal(done.owner_email,'quizlibrary.forms@gmail.com');
 const bad=await reserve('Oops');await service(()=>rpc('ql_gform__fail',[bad.record_id,'Apps Script error']));
 for(let i=0;i<4;i++)await reserve('Q'+i);
 await assert.rejects(reserve('Sixth'),/5 Google Forms a day/);
 await admin(()=>db.exec(`update ql_google_forms set created_at=now()-interval '11 minutes' where title='Q3'`));
 const again=await reserve('After timeout');assert.equal(again.left,0,'the stuck one stopped counting');
 await admin(()=>db.exec(`update ql_google_forms set created_at=now()-interval '1 day' where user_id='${A}'`));
 assert.equal((await rpc('ql_gform_mine')).left,5,'a new day starts again');
 await as(B);const other=await reserve('Chea quiz');assert.match(other.user_label,/^chea \(22222222\)$/);assert.equal((await rpc('ql_gform_mine')).forms.length,0);await as();
 await assert.rejects(rpc('ql_gform_reserve',['x',0,'paste']),/at least one/);await assert.rejects(rpc('ql_gform_reserve',['x',201,'paste']),/200/);
});
test('Students see only their own ready forms; remove hides it but still counts; get checks the owner',async()=>{
 const mine=await rpc('ql_gform_mine');assert.deepEqual(mine.forms.map(f=>f.title),['Cardio']);
 const id=mine.forms[0].id;assert.equal((await rpc('ql_gform_get',[id])).form_id,'F1');
 await as(B);assert.equal(await rpc('ql_gform_get',[id]),null);await rpc('ql_gform_remove',[id]);await as();
 assert.equal((await rpc('ql_gform_mine')).forms.length,1,'someone else cannot remove it');
 await service(()=>rpc('ql_gform__update',[id,JSON.stringify({title:'Cardio v2',accepting:false,editor_email:'new@gmail.com'})]));
 const f=(await rpc('ql_gform_mine')).forms[0];assert.deepEqual([f.title,f.accepting,f.editor_email],['Cardio v2',false,'new@gmail.com']);
 await rpc('ql_gform_remove',[id]);assert.equal((await rpc('ql_gform_mine')).forms.length,0);
 assert.equal(await rpc('ql_gform_get',[id]),null);
 await assert.rejects(db.query('select * from ql_google_forms'),/permission denied/);
 await assert.rejects(rpc('ql_gform__finish',[id,'{}']),/permission denied/);
});
test('Switching to another Gmail: new address becomes active, old one is still found for old forms',async()=>{
 await as(ADM);await rpc('ql_admin_gform_save',[URL2,'secret-two',3]);
 const cfg=await rpc('ql_admin_gform_get');assert.deepEqual(cfg.owners.map(o=>[o.script_url,o.active]),[[URL2,true],[URL1,false]]);assert.equal(cfg.daily_limit,3);
 await rpc('ql_admin_gform_save',[URL1,'',null]);assert.equal((await rpc('ql_admin_gform_get')).owners.find(o=>o.active).script_url,URL1,'re-activating keeps the saved secret');
 await rpc('ql_admin_gform_save',[URL2,'',null]);
 await service(()=>rpc('ql_gform__checked',[URL1,'quizlibrary.forms@gmail.com']));
 assert.equal((await service(()=>rpc('ql_gform__owner',['QuizLibrary.Forms@gmail.com']))).script_url,URL1);
 assert.equal((await service(()=>rpc('ql_gform__owner',[null]))).script_url,URL2);
 await as();assert.equal((await rpc('ql_gform_mine')).limit,3);
});
test('The Admin on/off switch and suspended accounts stop new forms',async()=>{
 await admin(()=>db.exec(`update ql_site_settings set value='{"gform":"off"}' where key='features'`));
 assert.equal((await rpc('ql_gform_mine')).enabled,false);await assert.rejects(reserve(),/turned off/);
 await admin(()=>db.exec(`update ql_site_settings set value='{}' where key='features';insert into ql_subscriptions(user_id,plan_id,status) values('${A}','free','suspended')`));
 await assert.rejects(reserve(),/suspended/);
 await as(null,'anon');await assert.rejects(rpc('ql_gform_mine'),/permission denied/);await as();
});
