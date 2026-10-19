from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
stub=r'''
window.rpcCalls=[];window.unhandledRpc=[];
const student={user_id:'student-1',id:'student-1',name:'Audit student',email:'student@example.test',total:1,plan_id:'free',status:'active',created_at:new Date().toISOString()};
const fakeSettings=[{key:'site',value:{open:true,signups:true}},{key:'features',value:{}},{key:'announcement',value:{}},{key:'payment',value:{}},{key:'limits',value:{}}];
const fakePlan={id:'free',name:'Free',color:'#94a3b8',limits:{},features:{},is_default:true,visibility:'public',sort:1};
window.allowAdmin=true;window.replyMode='ok';window.secondStudent={...student,user_id:'student-2',id:'student-2',name:'Second student'};
const rpc=async(name,args)=>{rpcCalls.push({name,args});let data;if(name==='ql_admin_support_reply'){if(replyMode==='pending')await new Promise(resolve=>window.releaseReply=resolve);if(replyMode==='fail')return {data:null,error:{message:'Simulated send failure'}};return {data:true,error:null}};
 const values={ql_am_i_admin:allowAdmin,ql_admin_plans:[fakePlan],ql_admin_stats:{users:1,users_month:1,signups_weeks:[1,2],by_plan:{free:1},storage_bytes:1024},ql_admin_storage:{files_bytes:1024,db_bytes:2048},ql_admin_users:[student],ql_admin_payments:[],ql_admin_codes:[],ql_admin_dash:[],ql_admin_support_unread:0,ql_admin_support_list:[secondStudent,{...student,last_body:'Hi',last_at:new Date().toISOString(),unread:0}],ql_admin_support_thread:[{body:'Hi',from_admin:false,created_at:new Date().toISOString()},{body:'Reply',from_admin:true,created_at:new Date().toISOString()}],ql_admin_khqr_checker:{has_secret:false},ql_admin_push_info:{devices:[]}};
 if(Object.hasOwn(values,name))data=values[name];else {unhandledRpc.push(name);data={};}
 return {data,error:null};
};
const channel={on(){return this},subscribe(){return this}};
window.supabase={createClient:()=>({rpc,from:()=>({select:async()=>({data:fakeSettings,error:null})}),channel:()=>channel,auth:{getSession:async()=>({data:{session:{user:{id:'admin-mock',email:'admin@example.test'}}}}),signOut:async()=>({error:null}),signInWithPassword:async()=>({error:null})}})};
'''
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 c=b.new_context(viewport={'width':1280,'height':900},service_workers='block');page=c.new_page();errors=[];requests=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('dialog',lambda d:d.dismiss())
 def route(r):
  u=r.request.url
  if u.startswith('http://127.0.0.1:8766/'):
   name=u.split('8766/',1)[1].split('?',1)[0]
   if name=='admin.html':r.fulfill(status=200,content_type='text/html',body=(root/name).read_text())
   elif (root/name).is_file():r.fulfill(status=200,body=(root/name).read_bytes())
   else:r.fulfill(status=404,body='')
  elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='(()=>{'+stub+'})();')
  else:requests.append(u);r.abort()
 c.route('**/*',route)
 page.goto('http://127.0.0.1:8766/admin.html',wait_until='domcontentloaded')
 page.wait_for_timeout(400)
 print('ADMIN_START',json.dumps({'errors':errors,'appVisible':page.locator('#app').is_visible()}),flush=True)
 pages=[]
 for v in ['dash','users','plans','pay','ctl','board','msgs','news','settings']:
  page.locator('.nav[data-v="'+v+'"]').click();page.wait_for_timeout(250)
  text=page.locator('#view').inner_text()
  pages.append({'view':v,'heading':page.locator('#view h1').all_text_contents(),'has_error':'Run plans_admin.sql' in text or 'TypeError' in text,'chars':len(text)})
  if v=='msgs':
   assert page.locator('.msgm.them .b').bounding_box()['width']<100
   page.locator('#msgText').fill('Unsaved local response')
   page.evaluate("go('msgs')");page.wait_for_timeout(150)
   pages[-1]['draft_after_refresh']=page.locator('#msgText').input_value()
   assert pages[-1]['draft_after_refresh']=='Unsaved local response'
 page.evaluate("go('msgs')");page.wait_for_timeout(150)
 page.locator('[data-mu="student-1"]').click();page.wait_for_timeout(150)
 page.locator('#msgText').fill('First thread draft')
 page.locator('#msgFile').set_input_files({'name':'photo.png','mimeType':'image/png','buffer':__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==')})
 page.wait_for_function('!document.querySelector("#msgPic").classList.contains("hidden")')
 page.locator('[data-mu="student-2"]').click();page.wait_for_timeout(150)
 page.locator('#msgText').fill('Second thread draft')
 page.locator('[data-mu="student-1"]').click();page.wait_for_timeout(150)
 assert page.locator('#msgText').input_value()=='First thread draft'
 assert page.locator('#msgPic').is_visible()
 page.evaluate("replyMode='fail'");page.locator('#msgSend').click();page.wait_for_timeout(100)
 assert page.locator('#msgText').input_value()=='First thread draft' and page.locator('#msgPic').is_visible()
 page.evaluate("replyMode='pending'");page.locator('#msgSend').click()
 page.wait_for_function('typeof releaseReply === "function"')
 page.locator('#msgText').fill('New draft typed during send')
 page.evaluate('releaseReply()');page.wait_for_timeout(150)
 assert page.locator('#msgText').input_value()=='New draft typed during send'
 assert not page.locator('#msgPic').is_visible()
 page.evaluate("replyMode='ok'");page.locator('#msgSend').click();page.wait_for_timeout(150)
 assert page.locator('#msgText').input_value()==''
 page.locator('[data-mu="student-2"]').click();page.wait_for_timeout(150)
 assert page.locator('#msgText').input_value()=='Second thread draft'
 print('Photo/thread drafts, failed send, edits during send, and successful send passed',flush=True)
 print(json.dumps({'pages':pages,'errors':errors,'unhandledRpc':page.evaluate('unhandledRpc'),'rpc_names':page.evaluate('[...new Set(rpcCalls.map(x=>x.name))]'),'external_requests':requests},indent=2),flush=True)
 assert not errors,errors
 b.close()
