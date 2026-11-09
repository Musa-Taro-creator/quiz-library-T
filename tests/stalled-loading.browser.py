"""Reproduce blank Admin startup and quiz loads held by cache/server requests."""
from pathlib import Path
import ast,os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path(os.environ.get('QL_STALL_SOURCE_DIR',str(ROOT)))
tree=ast.parse((ROOT/'tests/admin-message-drafts.browser.py').read_text())
ADMIN=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='stub' for t in n.targets))+r'''
const oldTimeout=setTimeout;window.setTimeout=(fn,ms,...args)=>oldTimeout(fn,ms===20000?150:ms,...args);
const factory=supabase.createClient;
supabase.createClient=(...args)=>{const c=factory(...args),get=c.auth.getSession,rpc=c.rpc;
 c.auth.getSession=async()=>{if(window.stallStage==='session'&&!localStorage.getItem('ready'))await new Promise(resolve=>window.releaseAuth=resolve);return get()};
 c.rpc=async(name,args)=>{if(name==='ql_am_i_admin'&&window.stallStage==='permission'&&!localStorage.getItem('ready'))await new Promise(resolve=>window.releaseAuth=resolve);return rpc(name,args)};
 return c};
'''
STUDENT=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()+r'''
const oldTimeout=setTimeout;window.setTimeout=(fn,ms,...args)=>oldTimeout(fn,ms===20000&&!window.cacheStall?150:ms,...args);
const beforeStallRpc=auditRpc;
auditRpc=async(name,args)=>{
 if(name==='student_read_quiz_page_v2'){
  if(window.holdRead)await new Promise(resolve=>window.releaseRead=resolve);
  const row=state.items.find(x=>x.id==='split-quiz');
  return {data:{revision:1,count:auditQuiz.questions.length,item:{id:row.id,payload:row,personalized:true},questions:args.p_offset?[]:structuredClone(auditQuiz.questions)},error:null};
 }return beforeStallRpc(name,args)};
const beforeStallFrom=auditClient.from;
auditClient.from=(table)=>{if(table!=='student_quiz_questions')return beforeStallFrom(table);const q=new Proxy({}, {get:(_,p)=>p==='then'?(yes,no)=>(window.holdProbe?new Promise(resolve=>window.releaseProbe=()=>resolve({data:[],error:null,status:200})):Promise.resolve({data:[],error:null,status:200})).then(yes,no):()=>q});return q};
const openDb=indexedDB.open.bind(indexedDB);
indexedDB.open=(name,...args)=>{
 if(name!=='ql_quiz_cache'||!window.cacheStall)return openDb(name,...args);
 const req={};if(cacheStall==='blocked')oldTimeout(()=>req.onblocked?.(),0);
 if(cacheStall==='read'){
  req.result={close(){},objectStoreNames:{contains:()=>true},transaction(){return {objectStore(){return {get(){return {}},put(){return {}}}}}}};oldTimeout(()=>req.onsuccess?.(),0);
 }return req;
};
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 def boot(admin,mode):
  c=browser.new_context(viewport={'width':1024 if admin else 1280,'height':900},service_workers='block');c.add_init_script(('window.stallStage='+repr(mode)+';'+ADMIN) if admin else ('window.cacheStall='+repr(mode)+';'+STUDENT));page=c.new_page();page.set_default_timeout(6000);errors=[];dialogs=[]
  page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:(dialogs.append(d.message),d.dismiss()))
  if admin:source=(SOURCE/'admin.html').read_text()
  else:
   source=(SOURCE/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
   needle='const service=MOCK_MODE?createMockService():createSupabaseService();';source=source.replace(needle,needle+'\nservice.client=window.auditClient;\n',1)
   needle='if(MOCK_MODE||!service.client||!state.user)return Promise.resolve(false);';assert needle in source;source=source.replace(needle,'if(!service.client||!state.user)return Promise.resolve(false);',1)
  def route(r):
   u=r.request.url
   if u.startswith('http://127.0.0.1:8828/'):
    name=u.split('8828/',1)[1].split('?',1)[0]
    if name in ('','index.html','admin.html'):r.fulfill(status=200,content_type='text/html',body=source)
    elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith(('.js','.mjs')) else 'application/octet-stream',body=(ROOT/name).read_bytes())
    else:r.fulfill(status=404,body='Missing')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local transport */')
   else:r.abort()
  c.route('**/*',route);page.goto('http://127.0.0.1:8828/'+('admin.html' if admin else ''),wait_until='domcontentloaded')
  if not admin:
   page.get_by_role('button',name='Continue with Google').click();page.wait_for_function('!!state.user');page.evaluate('service.getSession=async()=>({user:state.user})')
  return c,page,errors,dialogs
 for mode in ['session','permission']:
  c,page,errors,dialogs=boot(True,mode);page.locator('#adminStarting').wait_for();page.locator('#adminStartError',has_text='timed out').wait_for();assert not page.locator('#app').is_visible();page.evaluate('releaseAuth()');page.wait_for_timeout(100);assert not page.locator('#app').is_visible();page.evaluate("localStorage.setItem('ready','1')");page.locator('#adminStarting button').click();page.locator('#view h1',has_text='Dashboard').wait_for();assert page.locator('#app').is_visible();assert not errors,errors;ok('Admin '+mode+': stalled startup has a visible recovery screen; late replies are ignored and Reload works');c.close()
 for mode in ['open','blocked','read']:
  c,page,errors,dialogs=boot(False,mode)
  page.evaluate("""()=>{localStorage.setItem('ql_split_ready_v1','1');const row={id:'split-quiz',kind:'quiz',title:'Split quiz',_student_q_split:true,_student_personalized:true,quiz_settings:{question_count:5,layout:'vertical'}};state.items.push(row);void openItem(row)}""")
  page.locator('#qzExamShell').wait_for();assert page.locator('.qz-run-question').count()>=1;assert not errors,errors;assert not dialogs,dialogs;ok('Quiz cache '+mode+': an unavailable optional cache falls back to the online quiz');c.close()
 for stage in ['probe','read']:
  c,page,errors,dialogs=boot(False,'')
  page.evaluate("""(stage)=>{if(stage==='probe'){localStorage.removeItem('ql_split_ready_v1');window.holdProbe=true}else{localStorage.setItem('ql_split_ready_v1','1');window.holdRead=true}const row={id:'split-quiz',kind:'quiz',title:'Split quiz',_student_q_split:true,_student_personalized:true,quiz_settings:{question_count:5,layout:'vertical'}};state.items.push(row);void openItem(row)}""",stage)
  page.locator('#qzLoadRetry').wait_for();page.evaluate('window.holdProbe=false;window.holdRead=false');page.locator('#qzLoadRetry').click();page.locator('#qzExamShell').wait_for();assert not errors,errors;ok('Quiz '+stage+': a stalled server read is released by a deadline and a new retry succeeds');c.close()
 c,page,errors,dialogs=boot(False,'')
 page.evaluate("""()=>{window.heldQuizzes=[];const row={...auditQuiz,id:'held-quiz',title:'Held quiz',quiz_settings:{question_count:5,layout:'vertical'}};state.items.push(row);service.getQuizForTaking=async()=>await new Promise(resolve=>heldQuizzes.push(()=>resolve({title:'Late old quiz',settings:row.quiz_settings,questions:auditQuiz.questions})));void openItem(row)}""")
 page.locator('#qzLoadRetry').wait_for();assert 'timed out' in page.locator('#qzPageBody').inner_text();page.evaluate("void(service.getQuizForTaking=async()=>({title:'Current quiz',settings:{layout:'vertical'},questions:auditQuiz.questions}))");page.locator('#qzLoadRetry').click();page.locator('#qzExamShell').wait_for();page.evaluate('heldQuizzes.shift()()');page.wait_for_timeout(100);assert page.locator('#qzExamShell').is_visible();assert 'Late old quiz' not in page.locator('#qzPageBody').inner_text();ok('A stalled quiz times out, Retry opens it, and the late previous response cannot replace it')
 page.locator('#qzExamHome').click();page.evaluate("""()=>{service.getQuizForTaking=async()=>await new Promise(resolve=>heldQuizzes.push(()=>resolve({title:'Cancelled quiz',settings:{},questions:auditQuiz.questions})));void openItem(itemById('held-quiz'))}""");page.locator('#qzLoadBack').wait_for();page.locator('#qzLoadBack').click();page.wait_for_function('!document.querySelector("#qzPageOverlay.show")');page.evaluate('heldQuizzes.shift()()');page.wait_for_timeout(100);assert not page.locator('#qzPageOverlay.show').count();assert not errors,errors;ok('Go back exits a stalled quiz and its later reply cannot reopen the screen');c.close();browser.close()
print(f'{len(checks)} stalled-loading recovery scenarios passed; deadlines accelerated only in local fixtures.')
