// Edge Function ql-gform end to end: the real SQL in PGlite + the Apps Script with fake Google services.
// The Edge Function's fetch is routed to them; nothing leaves this machine.
import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {test,before,after} from 'node:test';
import {createObservedTables} from './fixtures/observed-schema.mjs';
const {PGlite}=await import(process.env.QL_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite(),root=new URL('../',import.meta.url);
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ADM='33333333-3333-4333-8333-333333333333';
const URL1='https://script.google.com/macros/s/AKfycbOne/exec';
const file=n=>fs.readFileSync(new URL(n,root),'utf8');
const SRC=file('tools/google-form-maker.gs');
async function as(id=A,role='authenticated'){await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||''])}
async function admin(fn){await db.exec('reset role');try{return await fn()}finally{await as()}}
function google(){
 const props=new Map(),files=new Map(),folders=new Map(),forms=new Map();let seq=0;const log=[];
 const mkFolder=(name,parent)=>{const id='D'+(++seq);const f={id,name,editors:[],parent,getId:()=>id,getUrl:()=>'https://drive.google.com/drive/folders/'+id,
   createFolder:n=>mkFolder(n,id),addEditor(e){if(/bad/.test(e))throw Error('Invalid email');f.editors.push(e)}};folders.set(id,f);return f};
 const mkItem=(kind)=>{const it={kind,choices:[],points:null,title:'',fb:{}};
   it.setTitle=t=>{it.title=t;return it};it.setRequired=v=>{it.required=v;return it};it.createChoice=(text,ok)=>({text,ok});it.setChoices=c=>{if(new Set(c.map(x=>x.text)).size!==c.length||c.some(x=>!x.text))throw Error('Choices must be unique and not empty');it.choices=c;return it};
   it.setPoints=p=>{if(!Number.isInteger(p))throw Error('points must be whole');it.points=p;return it};
   it.setFeedbackForCorrect=f=>{it.fb.right=f;return it};it.setFeedbackForIncorrect=f=>{it.fb.wrong=f;return it};it.setGeneralFeedback=f=>{it.fb.general=f;return it};return it};
 const FormApp={create(title){const id='F'+(++seq);const form={id,title,items:[],quiz:false,published:false,accepting:false,responses:3,
   getId:()=>id,getItems:()=>form.items,setIsQuiz:v=>{form.quiz=v},settings:{},setCollectEmail:v=>{form.settings.email=v},setLimitOneResponsePerUser:v=>{form.settings.one=v},setShuffleQuestions:v=>{form.settings.shuffle=v},setAllowResponseEdits:v=>{form.settings.edits=v},setShowLinkToRespondAgain:v=>{form.settings.again=v},setPublishingSummary:v=>{form.settings.summary=v},setConfirmationMessage:v=>{form.settings.confirm=v},addPageBreakItem:()=>{const i=mkItem('page');form.items.push(i);return i},setDescription:v=>{form.description=v},setProgressBar:()=>{},
   addMultipleChoiceItem:()=>{const i=mkItem('radio');form.items.push(i);return i},addCheckboxItem:()=>{const i=mkItem('checkbox');form.items.push(i);return i},addTextItem:()=>{const i=mkItem('text');form.items.push(i);return i},
   setPublished:v=>{form.published=v},setAcceptingResponses:v=>{form.accepting=v},isAcceptingResponses:()=>form.accepting,getResponses:()=>Array(form.responses),
   getTitle:()=>form.title,setTitle:t=>{form.title=t},getPublishedUrl:()=>'https://docs.google.com/forms/d/e/'+id+'/viewform',shortenFormUrl:()=>'https://forms.gle/'+id,getEditUrl:()=>'https://docs.google.com/forms/d/'+id+'/edit'};
   forms.set(id,form);files.set(id,{id,name:title,parents:['root'],trashed:false});if(google.failOn&&title.includes(google.failOn))form.addMultipleChoiceItem=()=>{throw Error('Google said no')};return form},
  openById(id){if(!forms.has(id))throw Error('No item with the given ID');return forms.get(id)},createFeedback:()=>{let t='';const b={setText:x=>{t=x;return b},build:()=>({text:t})};return b}};
 const DriveApp={getFileById(id){const f=files.get(id);if(!f)throw Error('missing');return {getId:()=>id,setTrashed:v=>{f.trashed=v},moveTo:folder=>{f.parents=[folder.getId()]},setName:n=>{f.name=n},getParents:()=>{const p=[...f.parents];return {hasNext:()=>p.length>0,next:()=>folders.get(p.shift())||{getId:()=>'root'}}}}},
  getFolderById(id){if(!folders.has(id))throw Error('missing');return folders.get(id)},getFoldersByName:n=>{const m=[...folders.values()].filter(f=>f.name===n);return {hasNext:()=>m.length>0,next:()=>m.shift()}},createFolder:n=>mkFolder(n,null)};
 const ctx={FormApp,DriveApp,Logger:{log:m=>log.push(m)},Session:{getEffectiveUser:()=>({getEmail:()=>'quizlibrary.forms@gmail.com'})},
  Utilities:{getUuid:()=>'aaaaaaaa-bbbb-cccc-dddd-'+String(++seq).padStart(12,'0')},LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)??null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:t=>({setMimeType:()=>({text:t})})}};
 vm.createContext(ctx);vm.runInContext(SRC,ctx);
 const post=body=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}}).text);
 return {ctx,props,files,folders,forms,log,post,google};
}
async function setupDb(){await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
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
}
let g,handle,handleNew,calls=[];
before(async()=>{
 await setupDb();
 g=google();g.ctx.setup();g.headers=[];
 const {makeHandler}=await import('data:text/javascript,'+encodeURIComponent(file('supabase/functions/ql-gform/index.ts')));
 // PostgREST stand-in: the token says who is calling; the service key runs as service_role.
 const fakeFetch=async(url,init)=>{
  calls.push(url);
  if(url===URL1){g.lastScriptBody=JSON.parse(init.body);const out=g.ctx.doPost({postData:{contents:init.body}}).text;return new Response(out,{status:200})}
  const m=url.match(/\/rest\/v1\/rpc\/(\w+)$/);if(!m)throw Error('unexpected '+url);
  const auth=init.headers.Authorization,args=JSON.parse(init.body);g.headers.push({apikey:init.headers.apikey,auth:auth||null});
  // new sb_secret_ key: only apikey (no Authorization), like Supabase's gateway expects
  const tok=auth?auth.slice(7):(init.headers.apikey==='sb_secret_test'?'service-key':'');
  if(auth&&/^Bearer sb_/.test(auth))return new Response('{"message":"Invalid JWT"}',{status:401});
  if(tok==='service-key'){await db.exec('reset role;set role service_role')}else if(tok.startsWith('user:')){await as(tok.slice(5))}else return new Response('{"message":"JWT"}',{status:401});
  try{const names=Object.keys(args);const r=await db.query(`select public.${m[1]}(${names.map((n,i)=>n+'=>$'+(i+1)).join(',')}) value`,names.map(n=>typeof args[n]==='object'&&args[n]!==null?JSON.stringify(args[n]):args[n]));
   return new Response(JSON.stringify(r.rows[0].value),{status:200})}
  catch(e){return new Response(JSON.stringify({message:e.message}),{status:400})}
  finally{await db.exec('reset role')}
 };
 handle=makeHandler({SUPABASE_URL:'https://x.supabase.co/',SUPABASE_ANON_KEY:'anon-key',SUPABASE_SERVICE_ROLE_KEY:'service-key'},fakeFetch);
 handleNew=makeHandler({SUPABASE_URL:'https://x.supabase.co',SUPABASE_PUBLISHABLE_KEYS:'{"default":"sb_publishable_test"}',SUPABASE_SECRET_KEYS:'{"default":"sb_secret_test"}',SUPABASE_ANON_KEY:'anon-key',SUPABASE_SERVICE_ROLE_KEY:'service-key'},fakeFetch);
 await as(ADM);await db.query("select public.ql_admin_gform_save($1,$2,$3)",[URL1,g.props.get('SECRET'),5]);await db.exec('reset role');
});
after(()=>db.close());
const call=(who,body)=>handle(new Request('https://x.supabase.co/functions/v1/ql-gform',{method:'POST',headers:{Authorization:'Bearer '+who,'Content-Type':'application/json'},body:JSON.stringify(body)})).then(async r=>({status:r.status,...(await r.json())}));
const QS=[{type:'mcq',prompt:'Valve?',options:['Mitral','Femur'],correct:[0],points:1,image:'data:image/png;base64,AAAA'},{type:'true_false',prompt:'4 chambers',correct:true}];

test('Not signed in, or signed in with the public key only: refused before anything else',async()=>{
 calls=[];assert.equal((await call('anon-key',{action:'make',questions:QS})).status,401);
 assert.equal((await handle(new Request('https://x/f',{method:'POST',body:'{}'}))).status,401);
 assert.equal(calls.length,0,'no database or Google call');
 assert.equal((await handle(new Request('https://x/f',{method:'OPTIONS'}))).headers.get('Access-Control-Allow-Origin'),'*');
});
test('Admin "Check connection" saves the Gmail that owns the forms; students cannot',async()=>{
 assert.match((await call('user:'+A,{action:'ping'})).error,/Admins only/);
 const r=await call('user:'+ADM,{action:'ping'});assert.deepEqual([r.ok,r.owner],[true,'quizlibrary.forms@gmail.com']);
 await as(ADM);const cfg=(await db.query('select public.ql_admin_gform_get() v')).rows[0].v;await db.exec('reset role');
 assert.equal(cfg.owners[0].owner_email,'quizlibrary.forms@gmail.com');
});
test('make: form made, saved in the list, secret never sent back, pictures not sent to Google',async()=>{
 const r=await call('user:'+A,{action:'make',title:'Cardio',questions:QS,editor_email:'Bona@gmail.com',source:'paste'});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.left,4);
 assert.equal(r.form.title,'Cardio');assert.equal(r.form.owner_email,'quizlibrary.forms@gmail.com');assert.equal(r.form.editor_email,'bona@gmail.com');
 assert.match(r.form.responder_url,/^https:\/\/forms\.gle\//);assert.ok(!JSON.stringify(r).includes(g.props.get('SECRET')));
 assert.ok(!JSON.stringify(g.lastScriptBody.questions).includes('data:image'),'no pictures');
 assert.equal(g.lastScriptBody.user_label,'Bona (QL-BONA0003)');
 const folder=[...g.folders.values()].find(f=>f.name==='Quiz Library - Bona (QL-BONA0003)');assert.ok(folder.editors.includes('bona@gmail.com'));
 await as(A);const mine=(await db.query('select public.ql_gform_mine() v')).rows[0].v;await db.exec('reset role');
 assert.deepEqual(mine.forms.map(f=>f.title),['Cardio']);assert.equal(mine.left,4);
});
test('A Google error gives the place back; a wrong secret says so clearly',async()=>{
 g.google.failOn='Broken';const r=await call('user:'+A,{action:'make',title:'Broken',questions:QS});
 assert.deepEqual([r.ok,r.error],[false,'Google said no']);
 await as(A);assert.equal((await db.query('select public.ql_gform_mine() v')).rows[0].v.left,4);await db.exec('reset role');
 g.props.set('SECRET','changed');const w=await call('user:'+A,{action:'make',title:'X',questions:QS});
 assert.match(w.error,/secret in Admin does not match/);g.ctx.newSecret();
 await as(ADM);await db.query("select public.ql_admin_gform_save($1,$2,$3)",[URL1,g.props.get('SECRET'),null]);await db.exec('reset role');
});
test('status, rename, close, share work on my own forms only',async()=>{
 await as(A);const mine=(await db.query('select public.ql_gform_mine() v')).rows[0].v;await db.exec('reset role');const f=mine.forms[0];
 const st=await call('user:'+A,{action:'status'});assert.deepEqual(st.forms[f.form_id],{accepting:true,responses:3,title:'Cardio'});
 assert.equal((await call('user:'+A,{action:'rename',id:f.id,title:'Cardio 2'})).title,'Cardio 2');
 assert.equal((await call('user:'+A,{action:'accepting',id:f.id,accepting:false})).accepting,false);
 const sh=await call('user:'+A,{action:'share',id:f.id,email:'me@gmail.com'});assert.equal(sh.editor_email,'me@gmail.com');
 const other=await call('user:'+B,{action:'rename',id:f.id,title:'stolen'});assert.deepEqual([other.status,other.ok],[404,false]);
 await as(A);const after=(await db.query('select public.ql_gform_mine() v')).rows[0].v.forms[0];await db.exec('reset role');
 assert.deepEqual([after.title,after.accepting,after.editor_email],['Cardio 2',false,'me@gmail.com']);
 assert.equal(g.forms.get(f.form_id).title,'Cardio 2');assert.equal(g.forms.get(f.form_id).accepting,false);
});
test('With the new Supabase keys (sb_publishable / sb_secret) it works the same and never sends sb_ keys as a login',async()=>{
 g.headers.length=0;
 const call2=(who,body)=>handleNew(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer '+who,'Content-Type':'application/json'},body:JSON.stringify(body)})).then(async r=>({status:r.status,...(await r.json())}));
 const r=await call2('user:'+A,{action:'make',title:'New keys',questions:QS});assert.equal(r.ok,true,JSON.stringify(r));
 assert.ok(g.headers.some(h=>h.apikey==='sb_secret_test'&&h.auth===null),'secret key sent only as apikey');
 assert.ok(g.headers.some(h=>h.apikey==='sb_publishable_test'&&h.auth==='Bearer user:'+A),'student calls use the publishable key + the login');
 assert.ok(!g.headers.some(h=>/sb_/.test(h.auth||'')),'no sb_ key in Authorization');
 assert.equal((await call2('sb_publishable_test',{action:'ping'})).status,401);assert.equal((await call2('anon-key',{action:'ping'})).status,401);
});
test('Big forms go in parts of 30 (no call long enough for Supabase to cut it off); old app / old Apps Script still work; discard',async()=>{
 const big=Array.from({length:75},(_,i)=>({type:'mcq',prompt:'Q'+(i+1),options:['Yes','No'],correct:[0]}));
 const r=await call('user:'+B,{action:'make',title:'Big',questions:big,chunked:true});
 assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual([r.next,r.total,r.part,r.form.question_count],[30,75,30,75]);
 assert.equal(g.lastScriptBody.questions.length,30,'only the first part goes in the first call');
 const form=g.forms.get(r.form.form_id);assert.deepEqual([form.items.length,form.accepting],[30,false]);
 const a1=await call('user:'+B,{action:'add',id:r.form.id,questions:big.slice(30,60),start:30,last:false});
 assert.deepEqual([a1.ok,a1.added,a1.question_count,form.accepting],[true,30,60,false]);
 const stolen=await call('user:'+A,{action:'add',id:r.form.id,questions:big.slice(0,5),start:60});
 assert.deepEqual([stolen.status,stolen.ok],[404,false]);assert.equal(form.items.length,60,'someone else cannot add to it');
 const a2=await call('user:'+B,{action:'add',id:r.form.id,questions:big.slice(60),start:60,last:true});
 assert.deepEqual([a2.added,a2.question_count,a2.last,form.accepting,form.items[74].title],[15,75,true,true,'Q75']);
 const tooBig=await call('user:'+B,{action:'add',id:r.form.id,questions:big,start:75,last:true});
 assert.equal(g.lastScriptBody.questions.length,30,'one add call carries at most one part');
 assert.equal(tooBig.ok,true);
 // an app from before this change (no chunked): everything in one call, as before
 const old=await call('user:'+B,{action:'make',title:'Old app',questions:big});
 assert.deepEqual([old.next,g.forms.get(old.form.form_id).items.length,g.forms.get(old.form.form_id).accepting],[null,75,true]);
 // an Apps Script from before this change (no "add"): everything in one call too
 g.ctx.VERSION=1;const oldScript=await call('user:'+B,{action:'make',title:'Old script',questions:big,chunked:true});g.ctx.VERSION=3;
 assert.deepEqual([oldScript.next,g.forms.get(oldScript.form.form_id).items.length],[null,75]);
 // a part that keeps failing: the app discards the half-made form (trashed in Drive, gone from the list)
 const half=await call('user:'+B,{action:'make',title:'Half',questions:big,chunked:true});
 const d=await call('user:'+B,{action:'discard',id:half.form.id});assert.equal(d.ok,true);
 assert.equal(g.files.get(half.form.form_id).trashed,true);
 await as(B);const mine=(await db.query('select public.ql_gform_mine() v')).rows[0].v;await db.exec('reset role');
 assert.ok(!mine.forms.some(f=>f.id===half.form.id),'removed from the list');assert.ok(mine.forms.some(f=>f.title==='Big'&&f.question_count===75));
});
test('Exam forms: settings cleaned and passed to the Apps Script; an older Apps Script (v2) refuses with a clear message and gives the place back',async()=>{
 const big=Array.from({length:40},(_,i)=>({type:'mcq',prompt:(i+1)+'. Q',options:['Yes','No'],correct:[0]}));
 const exam={fields:['Full name',' Student ID ','', 'x'.repeat(150)],one_response:1,collect_email:true,shuffle:true,lock:'yes',extra:'ignored'};
 const r=await call('user:'+ADM,{action:'make',title:'Final exam',questions:big,chunked:true,exam,source:'exam_quiz'});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.next,30);
 assert.deepEqual(g.lastScriptBody.exam,{fields:['Full name','Student ID','x'.repeat(100)],one_response:true,collect_email:true,shuffle:true,lock:true});
 const form=g.forms.get(r.form.form_id);assert.deepEqual([form.items[0].title,form.items[3].kind,form.settings.one],['Full name','page',true]);
 const a=await call('user:'+ADM,{action:'add',id:r.form.id,questions:big.slice(30),start:30,last:true,required:true});
 assert.equal(a.ok,true);assert.equal(g.lastScriptBody.required,true);assert.ok(form.items.slice(-10).every(i=>i.required));
 await as(ADM);const mine=(await db.query('select public.ql_gform_mine() v')).rows[0].v;await db.exec('reset role');
 assert.equal(mine.forms.find(f=>f.id===r.form.id).source,'exam_quiz','the list knows it is an exam');
 g.ctx.VERSION=2;const old=await call('user:'+ADM,{action:'make',title:'Old exam',questions:big.slice(0,5),exam});g.ctx.VERSION=3;
 assert.deepEqual([old.status,old.ok],[503,false]);assert.match(old.error,/Exam forms need the new Apps Script \(version 3\)/);
 assert.equal([...g.forms.values()].filter(f=>f.title==='Old exam').length,0,'no form made');
 await as(ADM);const after=(await db.query('select public.ql_gform_mine() v')).rows[0].v;await db.exec('reset role');
 assert.ok(!after.forms.some(f=>f.title==='Old exam'));
});
test('The daily limit holds through the Edge Function too',async()=>{
 for(let i=0;i<3;i++)assert.equal((await call('user:'+A,{action:'make',title:'Q'+i,questions:QS})).ok,true); // 2 made above + 3 = 5
 const sixth=await call('user:'+A,{action:'make',title:'Sixth',questions:QS});assert.match(sixth.error,/5 Google Forms a day/);
 assert.equal([...g.forms.values()].filter(f=>f.title==='Sixth').length,0,'Google was not asked');
});
