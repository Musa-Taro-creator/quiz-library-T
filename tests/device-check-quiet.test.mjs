// ql_device_check must not write on every call (each write is a live update that made
// every open tab check again). Disposable local PGlite only, never Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test,before,after} from 'node:test';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');
const root=new URL('../',import.meta.url);
const A='11111111-1111-4111-8111-111111111111';
const sql=n=>fs.readFileSync(new URL('supabase/'+n,root),'utf8');
async function setup(withFix){
 const db=new PGlite();
 await db.exec(`create role authenticated;create role anon;create schema auth;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');insert into auth.users(id,email) values('${A}','a@example.test');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 for(const n of ['plans_admin.sql','single_device_login.sql','device_history.sql','multi_device.sql',...(withFix?['device_check_quiet.sql']:[])])await db.exec(sql(n));
 // Every UPDATE/INSERT/DELETE here is what Realtime would send to the app.
 await db.exec(`create table live_updates(tbl text,op text);
 create function log_live() returns trigger language plpgsql as $$begin insert into live_updates values(tg_table_name,tg_op);return null;end$$;
 create trigger live after insert or update or delete on ql_signed_devices for each row execute function log_live();
 create trigger live after insert or update or delete on ql_device_log for each row execute function log_live();`);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[A]);
 return db;
}
const call=async(db,fn,...args)=>(await db.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as v`,args)).rows[0].v;
const updates=async(db,tbl)=>Number((await db.query('select count(*) n from live_updates where tbl=$1',[tbl])).rows[0].n);
let oldDb,db;
before(async()=>{oldDb=await setup(false);db=await setup(true)});
after(async()=>{await oldDb.close();await db.close()});

test('Old version: every check writes, so every check sends live updates (the loop)',async()=>{
 await call(oldDb,'ql_device_signin','dev-1','iPad · Safari');
 await oldDb.exec('delete from live_updates');
 for(let i=0;i<5;i++)await call(oldDb,'ql_device_check','dev-1','iPad · Safari');
 assert.equal(await updates(oldDb,'ql_signed_devices'),5);
});

test('Fixed: repeated checks only read, so they send no live updates',async()=>{
 const first=await call(db,'ql_device_signin','dev-1','iPad · Safari');
 assert.equal(first.signed_in,true);
 await db.exec('delete from live_updates');
 for(let i=0;i<5;i++){const d=await call(db,'ql_device_check','dev-1','iPad · Safari');assert.equal(d.signed_in,true)}
 assert.equal(await updates(db,'ql_signed_devices'),0);
 assert.equal(await updates(db,'ql_device_log'),0);
});

test('Fixed: "last seen" is still updated when it is more than 5 minutes old',async()=>{
 await db.exec(`update ql_signed_devices set last_seen=now()-interval '6 minutes';update ql_device_log set last_seen=now()-interval '6 minutes';delete from live_updates`);
 await call(db,'ql_device_check','dev-1','iPad · Safari');
 assert.equal(await updates(db,'ql_signed_devices'),1);
 assert.equal(await updates(db,'ql_device_log'),1);
 await call(db,'ql_device_check','dev-1','iPad · Safari');
 assert.equal(await updates(db,'ql_signed_devices'),1,'the next check right after writes nothing');
});

test('Fixed: a blocked device is still refused',async()=>{
 await db.exec("update ql_device_log set blocked=true where device_id='dev-1'");
 await assert.rejects(call(db,'ql_device_check','dev-1','iPad · Safari'),/device_blocked/);
 await db.exec("update ql_device_log set blocked=false where device_id='dev-1'");
});

test('Fixed: the device limit still signs out the older device',async()=>{
 await call(db,'ql_device_signin','dev-2','iPhone · Safari');   // Free plan: 1 device at a time
 const old=await call(db,'ql_device_check','dev-1','iPad · Safari');
 assert.equal(old.signed_in,false);
 assert.equal((await call(db,'ql_device_check','dev-2','iPhone · Safari')).signed_in,true);
});

test('Fixed: a missing device id is refused',async()=>{
 await assert.rejects(call(db,'ql_device_check','  ',null),/missing device id/);
});
