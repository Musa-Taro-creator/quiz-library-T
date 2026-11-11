// Loopback-only disposable PostgreSQL bridge for browser integration tests.
import fs from 'node:fs';import http from 'node:http';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444';
const sql=name=>fs.readFileSync(new URL('../../supabase/'+name,import.meta.url),'utf8');
await db.exec(`create role authenticated;create role anon;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');insert into auth.users(id,email,raw_user_meta_data) values('${A}','owner@example.test','{"full_name":"Room Owner"}'),('${B}','member@example.test','{"full_name":"Room Member"}'),('${C}','admin@example.test','{"full_name":"Website Admin"}'),('${D}','dara@example.test','{"full_name":"Dara"}');
create table ql_site_settings(key text primary key,value jsonb);create table ql_subscriptions(user_id uuid,status text);create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable as $$select p_uid='${C}'::uuid$$;create table ql_dash_posts(id uuid primary key,owner_id uuid,status text,payload jsonb);
create table ql_plans(id text primary key,features jsonb not null default '{}');insert into ql_plans values('free','{}');create function ql__effective_plan(p_uid uuid) returns text language sql stable as $$select 'free'$$;`);
// The real Website Control check (dashboard.sql), then the Rooms SQL in migration order.
await db.exec(sql('dashboard.sql').match(/create or replace function public\.ql__feature_ok[\s\S]*?\$\$;/)[0]);
for(const name of ['dashboard_quiz_access_v1.sql','shared_rooms_v1.sql','rooms_controls_v1.sql'])await db.exec(sql(name));
let pending=Promise.resolve();
const reply=(res,data,error=null)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data,error}))};
const server=http.createServer((req,res)=>{
 if(req.url!=='/rpc'&&req.url!=='/test-features'){res.writeHead(404);res.end();return}let body='';req.on('data',b=>body+=b);req.on('end',()=>{
 pending=pending.then(async()=>{try{const x=JSON.parse(body);
  // Test only: what Website Control (and the free plan) say, so the server checks match the page.
  if(req.url==='/test-features'){await db.exec('reset role');await db.query("insert into ql_site_settings(key,value) values('features',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(x.features||{})]);await db.query("update ql_plans set features=$1 where id='free'",[JSON.stringify(x.plan||{})]);return reply(res,true)}
  if(![A,B,C,D].includes(x.user))throw Error('Unknown test user');await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[x.user]);const r=(await db.query('select ql_room_v1($1,$2,$3) value',[x.args.p_action,x.args.p_room,JSON.stringify(x.args.p_data||{})])).rows[0].value;reply(res,r)}catch(e){reply(res,null,{message:e.message,code:e.code})}});
 });
});server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
process.on('SIGTERM',async()=>{server.close();await db.close();process.exit(0)});
