// Loopback-only disposable PostgreSQL bridge for browser integration tests.
import fs from 'node:fs';import http from 'node:http';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
await db.exec(`create role authenticated;create role anon;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');insert into auth.users(id,email,raw_user_meta_data) values('${A}','owner@example.test','{"full_name":"Room Owner"}'),('${B}','member@example.test','{"full_name":"Room Member"}'),('${C}','admin@example.test','{"full_name":"Website Admin"}');
create table ql_site_settings(key text primary key,value jsonb);create table ql_subscriptions(user_id uuid,status text);create function ql__is_admin(p_uid uuid default auth.uid()) returns boolean language sql stable as $$select p_uid='${C}'::uuid$$;create table ql_dash_posts(id uuid primary key,owner_id uuid,status text,payload jsonb);`);
for(const name of ['dashboard_quiz_access_v1.sql','shared_rooms_v1.sql'])await db.exec(fs.readFileSync(new URL('../../supabase/'+name,import.meta.url),'utf8'));
let pending=Promise.resolve();
const server=http.createServer((req,res)=>{
 if(req.url!=='/rpc'){res.writeHead(404);res.end();return}let body='';req.on('data',b=>body+=b);req.on('end',()=>{
 pending=pending.then(async()=>{try{const x=JSON.parse(body);if(![A,B,C].includes(x.user))throw Error('Unknown test user');await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[x.user]);const r=(await db.query('select ql_room_v1($1,$2,$3) value',[x.args.p_action,x.args.p_room,JSON.stringify(x.args.p_data||{})])).rows[0].value;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:r,error:null}))}catch(e){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:null,error:{message:e.message,code:e.code}}))}});
 });
});server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
process.on('SIGTERM',async()=>{server.close();await db.close();process.exit(0)});
