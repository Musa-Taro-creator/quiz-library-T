from pathlib import Path
import json,re
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1];s=(root/'index.html').read_text()
script=re.search(r'<script id="qlItemShare">([\s\S]*?)</script>',s)[1]
setup=(root/'tests/fixtures/sharing-setup.js').read_text()
friendly=s[s.index('function friendlyError(error){'):s.index('function toast(msg)')]
wrappers=s[s.index('  service.createExternalQuizShare=async function('):s.index('  service.resolveShortShareLink=async function(')]
instrument=r'''
window.steps=[];window.createdShares=[];window.posts=[];window.failure='';
window.failError=()=>({message:'canceling statement due to statement timeout',code:'57014'});
window.prepared=new Map();window.uploads=new Map();
service.client.rpc=async(name,args)=>{
 steps.push({stage:name,item:args?.p_item_id});
 if(name==='ql_prepare_dash_quiz_v2'){
  const key=args.p_operation_id+':'+args.p_item_id;
  if(prepared.has(key))return {data:prepared.get(key)};
  if(failure==='share'&&args.p_item_id==='quiz-6')return {error:failError()};
  const result={share_token:'token-'+(createdShares.length+1)};createdShares.push({item:args.p_item_id,token:result.share_token});prepared.set(key,result);return {data:result};
 }
 if(name==='ql_begin_dash_upload_v2'){
  if(!uploads.has(args.p_operation_id))uploads.set(args.p_operation_id,{args,parts:new Map(),post:null});
  return {data:uploads.get(args.p_operation_id).post};
 }
 if(name==='ql_stage_dash_upload_v2'){
  if(failure==='part'&&args.p_part===1)return {error:failError()};
  uploads.get(args.p_operation_id).parts.set(args.p_part,Uint8Array.from(atob(args.p_base64),c=>c.charCodeAt(0)));return {data:null};
 }
 if(name==='ql_finalize_dash_upload_v2'){
  if(failure==='post')return {error:failError()};
  const upload=uploads.get(args.p_operation_id);if(upload.post)return {data:upload.post};
  const parts=[...upload.parts].sort((a,b)=>a[0]-b[0]).map(x=>x[1]),bytes=new Uint8Array(parts.reduce((n,x)=>n+x.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}
  const payload=JSON.parse(new TextDecoder().decode(bytes));posts.push({p_payload:payload});upload.post='post-'+posts.length;return {data:upload.post};
 }
 return {data:0};
};
service.createShortShareLink=async()=>null;
service.getQuizQuestionsAdmin=async(id)=>{
 steps.push({stage:'read',item:id});
 if(failure==='read'&&id==='quiz-6')throw failError();
 return Array.from({length:250},(_,i)=>({id:id+'-q'+i,question_position:i,type:'mcq',prompt:'Synthetic question '+i,options:[{text:'A'},{text:'B'}],correct_answer:0,points:1}));
};
service.signedUrl=async(x)=>{steps.push({stage:'pdf',item:x.id});if(failure==='pdf'&&x.id==='pdf-6')throw failError();return 'https://example.test/'+x.id+'.pdf'};
state.items=[{id:'root',kind:'folder',title:'MD-Y3-S2',parent_id:null,color:'#65676B',icon:'book'}];
for(let i=1;i<=24;i++)state.items.push({id:'folder-'+i,parent_id:i===1?'root':'folder-'+(i-1),kind:'folder',title:'Folder '+i,color:'#123ABC',icon:'atom'});
for(let i=1;i<=12;i++)state.items.push({id:'quiz-'+i,parent_id:'folder-'+(i*2),kind:'quiz',title:'Quiz '+i,quiz_settings:{shuffle:true}});
for(let i=1;i<=14;i++)state.items.push({id:'pdf-'+i,parent_id:'folder-'+i,kind:'pdf',title:'PDF '+i,storage_path:'mock/'+i+'.pdf'});
'''
results=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for failure in ['', 'read','share','pdf','part','post']:
  page=b.new_page();errors=[];network=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body='<body></body>') if r.request.url.startswith('http://127.0.0.1:8765/') else (network.append(r.request.url),r.abort()))
  page.goto('http://127.0.0.1:8765/');page.evaluate(setup);page.evaluate("(()=>{"+friendly+";window.friendlyError=friendlyError})()");page.evaluate("(()=>{"+wrappers+"})()");page.evaluate(instrument);page.evaluate(script)
  page.evaluate('(f)=>failure=f',failure)
  page.evaluate("qlPostToDash(itemById('root'))")
  summary=page.locator('.ql-is-card').inner_text();assert '24 folders' in summary and '12 quizzes' in summary and '14 PDFs' in summary
  page.evaluate("async()=>await document.querySelector('#qlDashGo').onclick()")
  result=page.evaluate('''()=>({failure,counts:Object.fromEntries([...new Set(steps.map(x=>x.stage))].map(k=>[k,steps.filter(x=>x.stage===k).length])),createdShares:createdShares.length,posts:posts.length,error:document.querySelector('#qlIsStatus')?.textContent||null,payloadBytes:posts[0]?new TextEncoder().encode(JSON.stringify(posts[0].p_payload)).length:0,nodes:posts[0]?.p_payload.nodes.length||0,questionCopies:posts[0]?.p_payload.nodes.filter(x=>x.kind==='quiz').reduce((n,x)=>n+x.questions.length,0)||0})''')
  if failure in ('read','share','pdf','part','post'):
   assert 'taking longer than usual' in result['error'],result
   assert result['posts']==0
   page.evaluate("failure='' ");page.evaluate("async()=>await document.querySelector('#qlDashGo').onclick()")
   result['afterRetry']=page.evaluate('''()=>({createdShares:createdShares.length,uniqueQuizzes:new Set(createdShares.map(x=>x.item)).size,posts:posts.length})''')
   assert result['afterRetry']['posts']==1
   assert result['afterRetry']['createdShares']==12,result
  else:
   assert result['posts']==1 and result['nodes']==51 and result['questionCopies']==3000
  assert not errors,errors;assert not network,network
  results.append(result);page.close()
 b.close()
success=results[0]
assert success['counts']['read']==12 and success['createdShares']==12
assert success['counts']['ql_prepare_dash_quiz_v2']==12
assert success['counts']['ql_finalize_dash_upload_v2']==1
print(json.dumps(results,indent=2))
print('6 full frontend posting scenarios passed, including four preparation/upload failure stages and finalization; retries created exactly one share per quiz and one post.')
