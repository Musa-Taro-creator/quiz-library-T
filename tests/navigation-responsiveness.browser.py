"""Actual Admin/Student UI under deferred and failed RPCs. All traffic stays local."""
from pathlib import Path
import ast, json, os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path(os.environ.get('QL_NAV_SOURCE_DIR',str(ROOT)))
tree=ast.parse((ROOT/'tests/admin-message-drafts.browser.py').read_text())
ADMIN_STUB=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='stub' for t in n.targets))+r'''
window.navTest={pending:[],hold:{},fail:{},calls:[]};
const originalFactory=supabase.createClient;
supabase.createClient=(...args)=>{const c=originalFactory(...args),old=c.rpc,from=c.from;c.rpc=async(name,args={})=>{
 navTest.calls.push({name,args});let reply=await old(name,args);
 if(name==='ql_room_v1'){const room={id:'room-a',name:'Study room',owner_name:'Student',owner_id:'student-1',status:'active'};reply={data:args.p_action==='admin_list'?{rooms:[room],config:{}}:{room,members:[]},error:null}};
 if(navTest.fail[name])reply={error:{code:'PGRST202',message:name+' missing'}};
 if(navTest.hold[name]&&args.p_limit!==1)await new Promise(resolve=>navTest.pending.push({name,args,release:()=>resolve()}));return reply;
};return c};
'''
STUDENT_STUB=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()+r'''
window.navTest={pending:[],hold:{},fail:{},calls:[]};
const previousNavRpc=auditRpc;
auditRpc=async(name,args={})=>{
 navTest.calls.push({name,args});let reply;
 if(name==='ql_support_unread')reply={data:0,error:null};
 else if(name==='ql_support_mine'||name==='ql_my_payments')reply={data:[],error:null};
 else if(name==='ql_room_v1'){
  const room={id:args.p_room||'room-a',name:'Study room',owner_id:state.user.id,owner_name:'Student',members:1,status:'active',permissions:{}};
  reply={data:args.p_action==='list'?{rooms:[room],config:{}}:args.p_action==='activity'?[]:{room,items:[],members:[],config:{},can_edit:true,manager:true},error:null};
 }else reply=await previousNavRpc(name,args);
 if(name==='ql_dash_list'&&navTest.listTitle)reply.data.posts[0].title=navTest.listTitle;
 if(navTest.fail[name])reply={error:{message:'Simulated request failure'}};
 if(navTest.hold[name])await new Promise(resolve=>navTest.pending.push({name,args,release:()=>resolve()}));return reply;
};
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 def boot(admin,width=1280):
  ctx=browser.new_context(viewport={'width':width,'height':900},has_touch=True,service_workers='block');ctx.add_init_script(ADMIN_STUB if admin else STUDENT_STUB);page=ctx.new_page();page.set_default_timeout(9000);errors=[];dialogs=[]
  page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:(dialogs.append(d.message),d.dismiss()))
  if not admin:
   source=(SOURCE/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
   needle='const service=MOCK_MODE?createMockService():createSupabaseService();';source=source.replace(needle,needle+'\nservice.client=window.auditClient;\n',1)
  else:source=(SOURCE/'admin.html').read_text()
  def route(r):
   u=r.request.url
   if u.startswith('http://127.0.0.1:8820/'):
    name=u.split('8820/',1)[1].split('?',1)[0].split('#',1)[0]
    if name in ('','index.html','admin.html'):r.fulfill(status=200,content_type='text/html',body=source)
    elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith(('.js','.mjs')) else 'text/css' if name.endswith('.css') else 'application/octet-stream',body=(ROOT/name).read_bytes())
    else:r.fulfill(status=404,body='Missing local fixture')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* offline simulated transport */')
   else:r.abort()
  ctx.route('**/*',route);page.goto('http://127.0.0.1:8820/'+('admin.html' if admin else ''),wait_until='domcontentloaded')
  if admin:page.locator('#view h1',has_text='Dashboard').wait_for()
  else:
   page.get_by_role('button',name='Continue with Google').click();page.wait_for_function('!!state.user');page.evaluate('service.getSession=async()=>({user:state.user})')
  return ctx,page,errors,dialogs
 def hold(name):page.evaluate('(n)=>navTest.hold[n]=true',name)
 def release(name):page.evaluate('(n)=>{const i=navTest.pending.findIndex(x=>x.name===n);if(i<0)throw Error("No pending "+n);navTest.pending.splice(i,1)[0].release()}',name)
 def wait_pending(name):page.wait_for_function('(n)=>navTest.pending.some(x=>x.name===n)',arg=name)
 def unhold(name):page.evaluate('(n)=>navTest.hold[n]=false',name)
 ctx,page,errors,dialogs=boot(True)
 # Every main Admin renderer must discard responses after leaving and reopening.
 for view,rpc in [('dash','ql_admin_stats'),('users','ql_admin_users'),('plans','ql_admin_plans'),('ctl','ql_admin_plans'),('board','ql_admin_dash'),('rooms','ql_room_v1'),('msgs','ql_admin_support_list'),('news','ql_admin_plans'),('settings','ql_admin_plans')]:
  hold(rpc);page.evaluate('(v)=>go(v)',view);wait_pending(rpc)
  page.evaluate("go('pay')");page.locator('[data-t="receipts"]').wait_for();release(rpc);page.wait_for_timeout(100)
  assert page.locator('[data-t="receipts"]').count()==1,(view,page.locator('#view').inner_text()[:200]);unhold(rpc)
  ok('Admin '+view+': delayed response cannot overwrite Payments')
 # Filters update before the server responds; last click remains authoritative.
 page.evaluate("go('users')");page.locator('#uMaxSave').wait_for();hold('ql_admin_users');page.locator('[data-f="suspended"]').click();wait_pending('ql_admin_users')
 assert page.locator('[data-f="suspended"]').evaluate('e=>e.classList.contains("on")');page.locator('[data-f="all"]').click();wait_pending('ql_admin_users');release('ql_admin_users');page.wait_for_timeout(100)
 assert page.locator('[data-f="all"]').evaluate('e=>e.classList.contains("on")');assert page.locator('#uMaxSave').count()==0;release('ql_admin_users');page.locator('#uMaxSave').wait_for();unhold('ql_admin_users');ok('Admin user filters react immediately and ignore out-of-order results')
 page.evaluate("go('board')");page.locator('[data-bs="removed"]').wait_for();hold('ql_admin_dash');page.locator('[data-bs="removed"]').click();wait_pending('ql_admin_dash');assert page.locator('[data-bs="removed"]').evaluate('e=>e.classList.contains("on")');page.locator('[data-bs="approved"]').click();release('ql_admin_dash');page.wait_for_timeout(100);assert page.locator('[data-bs="approved"]').evaluate('e=>e.classList.contains("on")');release('ql_admin_dash');unhold('ql_admin_dash');ok('Admin Dashboard moderation filters react before loading finishes')
 # Even setup/error views may not replace a newer page.
 for view,rpc in [('rooms','ql_room_v1'),('board','ql_admin_dash'),('msgs','ql_admin_support_list')]:
  hold(rpc);page.evaluate('(n)=>navTest.fail[n]=true',rpc);page.evaluate('(v)=>go(v)',view);wait_pending(rpc);page.evaluate("go('pay')");page.locator('[data-t="receipts"]').wait_for();release(rpc);page.wait_for_timeout(100);assert page.locator('[data-t="receipts"]').count()==1;unhold(rpc);page.evaluate('(n)=>delete navTest.fail[n]',rpc)
 ok('Admin late errors stay on their original screen')
 page.evaluate("go('rooms')");page.locator('[data-ra-manage]').wait_for();hold('ql_room_v1');page.locator('[data-ra-manage]').click();wait_pending('ql_room_v1');assert 'Loading room settings' in page.locator('.ovl').inner_text();page.locator('.ovl .x').click();release('ql_room_v1');page.wait_for_timeout(100);assert page.locator('.ovl').count()==0;unhold('ql_room_v1');page.locator('[data-ra-manage]').click();page.locator('#raName').wait_for();page.locator('.ovl .x').click();ok('Admin Room settings responds immediately, respects Close and retries normally')
 assert not errors,errors;ctx.close()
 for width in [390,1280]:
  ctx,page,errors,dialogs=boot(False,width)
  # Test a first Help open before the availability request has completed.
  hold('ql_support_unread');page.evaluate('void qlOpenSupport()');wait_pending('ql_support_unread');assert 'Loading support' in page.locator('[data-ql-opening]').inner_text();page.locator('[data-ql-opening-cancel]').click();release('ql_support_unread');page.wait_for_timeout(100);assert not page.locator('#modalOverlay.show').count();unhold('ql_support_unread');page.evaluate('void qlOpenSupport()');page.locator('#qlSupText').wait_for();page.evaluate('closeModal()');ok(f'Student {width}px: Help responds immediately, respects cancellation and reopens')
  for section in ['documents','favorites','recent','shared','trash','profile']:
   page.evaluate('(s)=>navigate(s)',section);assert page.evaluate('state.section')==section
  page.evaluate("navigate('documents')");ok(f'Student {width}px: library sections and Profile switch immediately')
  # These views already show a loading state and filter downloaded metadata locally.
  hold('ql_dash_list');page.evaluate('void qlOpenDash()');wait_pending('ql_dash_list');assert 'Loading' in page.locator('#qlDash').inner_text();page.locator('#qlDash [data-qd-close]').click();release('ql_dash_list');page.wait_for_timeout(100);assert page.locator('#qlDash').count()==0;unhold('ql_dash_list')
  page.evaluate('void qlOpenDash()');page.locator('[data-post="audit-post"]').wait_for();before=page.evaluate("navTest.calls.filter(x=>x.name==='ql_dash_list').length")
  page.locator('[data-qd-kind="folder"]').click();assert page.locator('[data-post="folder-post"]').count()==1;page.locator('[data-qd-kind=""]').click();assert page.evaluate("navTest.calls.filter(x=>x.name==='ql_dash_list').length")==before;ok(f'Student {width}px: Dashboard loading, Close and local filters')
  hold('ql_dash_list');page.evaluate("navTest.listTitle='Earlier list';void qlOpenDash()");wait_pending('ql_dash_list');page.evaluate("navTest.listTitle='Latest list';void qlOpenDash()");page.wait_for_function("navTest.pending.filter(x=>x.name==='ql_dash_list').length===2")
  page.evaluate("navTest.pending.pop().release()");page.locator('[data-post="audit-post"] .item-title',has_text='Latest list').wait_for();release('ql_dash_list');page.wait_for_timeout(100);assert 'Latest list' in page.locator('[data-post="audit-post"]').inner_text();unhold('ql_dash_list');ok(f'Student {width}px: a late Dashboard list cannot replace a newer list')
  hold('ql_dash_open');page.locator('[data-post="audit-post"]').click();wait_pending('ql_dash_open');assert 'Loading quiz' in page.locator('[data-ql-opening]').inner_text();page.locator('[data-ql-opening-cancel]').click();release('ql_dash_open');page.wait_for_timeout(100);assert not page.locator('#qzPageOverlay.show').count();unhold('ql_dash_open');ok(f'Student {width}px: opening a Dashboard post reacts immediately and can be cancelled')
  # Its account-based quiz data request must also be cancellable.
  hold('ql_dash_quiz_get_fast_v1');page.locator('[data-post="audit-post"]').click();wait_pending('ql_dash_quiz_get_fast_v1');page.locator('[data-ql-opening-cancel]').click();release('ql_dash_quiz_get_fast_v1');page.wait_for_timeout(100);assert not page.locator('#qzPageOverlay.show').count();unhold('ql_dash_quiz_get_fast_v1')
  page.locator('[data-post="audit-post"]').click()
  page.locator('#qzPageOverlay.show').wait_for()
  page.locator('#qzExamHome').click();page.locator('#qlDash [data-qd-close]').click();ok(f'Student {width}px: Dashboard quiz retry still opens the normal full quiz runner')
  # Library quizzes show a loading screen already; returning to the landing
  # screen before the response must not unexpectedly start the exam later.
  page.evaluate("""()=>{window.ownQuizService=service.getQuizForTaking;window.ownQuizPending=[];service.getQuizForTaking=async()=>await new Promise(resolve=>ownQuizPending.push(()=>resolve({title:auditQuiz.title,settings:auditQuiz.quiz_settings,questions:auditQuiz.questions})));void __quizTest.openQuizLanding(auditQuiz)}""")
  page.locator('#qzLandTake').click();page.wait_for_function('ownQuizPending.length===1');page.locator('#qzTopClose').click();page.locator('#qzLandTake').wait_for();page.evaluate('ownQuizPending.shift()()');page.wait_for_timeout(100);assert page.locator('#qzLandTake').count()==1;assert page.locator('#qzExamShell').count()==0
  page.locator('#qzLandTake').click();page.wait_for_function('ownQuizPending.length===1');page.evaluate('ownQuizPending.shift()()');page.locator('#qzExamHome').wait_for();page.locator('#qzExamHome').click();page.locator('#qzTopClose').click();page.evaluate('void(service.getQuizForTaking=ownQuizService)');ok(f'Student {width}px: library quiz Back cancels a late start and retry works')
  # Closing the quiz removes its Back entry with a delayed history.back(); opening
  # Profile before that finishes lets the late Back land on Documents.
  page.wait_for_function('!history.state?.qlUiLayer');page.evaluate("navigate('profile')");page.locator('[data-qs="hist"]').wait_for();hold('ql_my_payments');page.locator('[data-qs="hist"]').click();wait_pending('ql_my_payments');assert 'Loading' in page.locator('#qhBody').inner_text();page.evaluate("closeModal();openModal('Other screen','<p>Keep this screen</p>')");release('ql_my_payments');page.wait_for_timeout(100);assert 'Keep this screen' in page.locator('#modalBody').inner_text();page.evaluate("closeModal();navigate('documents')");unhold('ql_my_payments');ok(f'Student {width}px: late payment history cannot replace a new dialog')
  # Closing Rooms while the initial module download is pending must cancel entry.
  module_requests=[];page.route('**/rooms.mjs',lambda r:module_requests.append(r));page.evaluate('void qlOpenRooms()');page.locator('[data-ql-opening]').wait_for();assert 'Opening Rooms' in page.locator('[data-ql-opening]').inner_text();page.locator('[data-ql-opening-cancel]').click()
  page.wait_for_timeout(100);assert module_requests;module_requests.pop().fulfill(status=200,content_type='application/javascript',body=(ROOT/'rooms.mjs').read_bytes());page.unroute('**/rooms.mjs');page.wait_for_timeout(100);assert page.locator('#qlRooms').count()==0;ok(f'Student {width}px: first Rooms download shows progress and respects cancellation')
  # Rooms list and entry feedback use mocked room data, never production.
  hold('ql_room_v1');page.evaluate('void qlOpenRooms()');page.wait_for_function("navTest.pending.some(x=>x.name==='ql_room_v1')");assert 'Loading your spaces' in page.locator('#qlRooms').inner_text();release('ql_room_v1');page.locator('[data-rm-open="room-a"]').wait_for();page.locator('[data-rm-open="room-a"]').click();wait_pending('ql_room_v1');assert 'Opening room' in page.locator('[data-rm-open="room-a"]').inner_text();assert page.locator('[data-rm-open="room-a"]').get_attribute('aria-busy')=='true';release('ql_room_v1');page.locator('[data-rm-tool="quiz"]').wait_for()
  page.evaluate('window.savedLoadingDialog=window.qlLoadingDialog;window.qlLoadingDialog=undefined')
  page.locator('[data-rm-manage]').click();wait_pending('ql_room_v1');assert 'Loading room settings' in page.locator('[data-ql-opening]').inner_text();page.locator('[data-ql-opening-cancel]').click();release('ql_room_v1');page.wait_for_timeout(100);assert page.locator('#rmEditName').count()==0
  page.locator('[data-rm-manage]').click();wait_pending('ql_room_v1');release('ql_room_v1');page.locator('#rmActivity').wait_for();page.locator('#rmActivity').click();wait_pending('ql_room_v1');assert 'Loading room activity' in page.locator('[data-ql-opening]').inner_text();release('ql_room_v1');page.locator('#rmActivityBack').wait_for();page.locator('#modalClose').click();page.wait_for_function("!document.querySelector('#modalOverlay.show')");ok(f'Student {width}px: room settings and Activity respond while loading and respect Cancel')
  page.evaluate('void(window.qlLoadingDialog=window.savedLoadingDialog)');page.locator('[data-rm-close]').click();unhold('ql_room_v1');ok(f'Student {width}px: Rooms list and room entry have immediate progress and working Back')
  assert not errors,errors;assert not dialogs,dialogs;ctx.close()
 browser.close()
print(f'{len(checks)} navigation checks passed with simulated slow/error responses; no production calls.')
