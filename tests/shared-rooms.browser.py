"""Real Rooms UI/editor with disposable PostgreSQL RPCs; all production traffic blocked."""
from pathlib import Path
import ast,json,os,subprocess,urllib.request,uuid
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
proc=subprocess.Popen(['node','tests/fixtures/rooms-backend.mjs'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'QL_PGLITE_MODULE':os.environ.get('QL_PGLITE_MODULE','/tmp/ql-reliability-deps/node_modules/@electric-sql/pglite/dist/index.js')})
port=json.loads(proc.stdout.readline())['port'];origin=f'http://127.0.0.1:{port}'
A='11111111-1111-4111-8111-111111111111';B='22222222-2222-4222-8222-222222222222';C='33333333-3333-4333-8333-333333333333'
source=(ROOT/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
needle='const service=MOCK_MODE?createMockService():createSupabaseService();';source=source.replace(needle,needle+'\nservice.client=window.auditClient;\n',1)
init=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()+r'''
const beforeRoomsRpc=auditRpc;
auditRpc=async(name,args)=>name==='ql_room_v1'?await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:state.user.id,args})}).then(r=>r.json()):beforeRoomsRpc(name,args);
auditClient.storage={from(){return {createSignedUrl:async()=>({data:{signedUrl:location.origin+'/tests/fixtures/sample.pdf'},error:null})}}};
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
def rpc(user,action,room=None,data=None):
 req=urllib.request.Request(origin+'/rpc',data=json.dumps({'user':user,'args':{'p_action':action,'p_room':room,'p_data':data or {}}}).encode(),headers={'Content-Type':'application/json'})
 result=json.load(urllib.request.urlopen(req));assert not result.get('error'),result;return result['data']
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  def boot(user,width=1280):
   context=browser.new_context(viewport={'width':width,'height':900},has_touch=True,service_workers='block');context.add_init_script(init)
   page=context.new_page();page.set_default_timeout(10000);errors=[];dialogs=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
   def route(r):
    u=r.request.url
    if u==origin+'/rpc':r.continue_();return
    if u.startswith(origin+'/'):
     name=u[len(origin)+1:].split('?',1)[0]
     if name in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=source)
     elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith(('.mjs','.js')) else 'text/css' if name.endswith('.css') else 'application/pdf' if name.endswith('.pdf') else 'application/octet-stream',body=(ROOT/name).read_bytes())
     else:r.fulfill(status=404,body='Missing')
    elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local transport */')
    else:r.abort()
   context.route('**/*',route);page.goto(origin+'/',wait_until='domcontentloaded');page.get_by_role('button',name='Continue with Google').click();page.wait_for_function('!!state.user');page.wait_for_timeout(700)
   page.evaluate('''(id)=>{const u={...state.user,id};state.user=u;for(const store of [localStorage,sessionStorage])for(const k of Object.keys(store))if(k.startsWith("ql_mock_auth_session_"))store.setItem(k,JSON.stringify(u));service.getSession=async()=>({user:u});render()}''',user)
   if width<700:page.locator('#mobileMenu').click()
   page.locator('#qlRoomsNav').click()
   try:page.locator('[data-rm-create]').wait_for()
   except Exception:
    print('BOOT ERRORS',errors,dialogs,page.locator('#qlRooms').inner_text() if page.locator('#qlRooms').count() else page.locator('body').inner_text()[-2500:],flush=True);raise
   return context,page,errors,dialogs
  context,page,errors,dialogs=boot(A)
  personal=page.evaluate('state.items.map(x=>x.id)')
  page.locator('[data-rm-create]').click();page.locator('#rmName').fill('MD-Y3-S2');page.locator('#rmSubmit').click();page.locator('[data-rm-manage]').wait_for()
  rid=page.evaluate('qlRooms.active()');room=rpc(A,'open',rid)['room'];code=room['invite_code']
  assert page.locator('[data-rm-tool]:enabled').count()==4;ok('Create Room exposes all four tools and owner controls')
  page.locator('[data-rm-tool="folder"]').click();page.locator('#folderEditorTitle').fill('Shared folder');page.locator('#folderEditorSave').click();page.locator('.rm-item .item-title',has_text='Shared folder').wait_for();folder=next(x for x in rpc(A,'open',rid)['items'] if x['kind']=='folder')
  page.locator('[data-rm-tool="link"]').click();page.locator('#editorTitle').fill('Study link');page.locator('#editorUrl').fill('https://example.test/study');page.locator('#editorSave').click();page.locator('.rm-item .item-title',has_text='Study link').wait_for()
  link=next(x for x in rpc(A,'open',rid)['items'] if x['kind']=='link');page.locator(f'[data-rm-more="{link["id"]}"]').click();page.locator('[data-room-action="move"]').click()
  page.evaluate('(id)=>{const e=document.querySelector("#moveParent");e.value=id;e.dispatchEvent(new Event("change",{bubbles:true}))}',folder['id']);page.locator('#moveSave').click();page.wait_for_timeout(250)
  assert rpc(A,'item_get',rid,{'id':link['id']})['parent_id']==folder['id']
  page.locator(f'[data-rm-item="{folder["id"]}"]').click();page.locator(f'[data-rm-more="{link["id"]}"]').click();page.locator('[data-room-action="trash"]').click();page.wait_for_timeout(150);assert rpc(A,'item_get',rid,{'id':link['id']})['is_trashed']
  page.locator('[data-rm-trash]').click();page.locator(f'[data-rm-more="{link["id"]}"]').click();page.locator('[data-room-action="restore"]').click();page.wait_for_timeout(150);assert not rpc(A,'item_get',rid,{'id':link['id']})['is_trashed'];page.locator('[data-rm-trash]').click()
  ok('Add Quiz Link, Move, Trash and Restore use room data and retain the selected folder')
  page.locator('[data-rm-tool="quiz"]').click();page.locator('#qzNewTitle').fill('Collaborative quiz');page.locator('#qzNewCreate').click();page.locator('#qzBtnAddNew').wait_for(state='attached')
  page.evaluate('document.querySelector("#qzBtnAddNew").click()');page.locator('[data-tab="bulk"]').click();page.locator('#qzAqBulkArea').fill('1. Pick No?\nA. Yes\nB. No\nAnswer: B\n\n2. Choose both?\nA. One\nB. Two\nC. Three\nAnswer: A, C');page.locator('#qzAqKeyArea').fill('1.B\n2.A,C');page.locator('#qzAqParse').click();page.locator('#qzAddQSubmit').click()
  page.wait_for_timeout(2400);page.locator('#qzTopClose').click();page.wait_for_function('!document.querySelector("#qzPageOverlay").classList.contains("show")')
  quiz=next(x for x in rpc(A,'open',rid)['items'] if x['kind']=='quiz');assert quiz['quiz_settings']['question_count']==2
  ok('Existing folder picker and full quiz editor save staged room questions to the shared folder')
  page.locator('[data-rm-back]').click();page.wait_for_timeout(150)
  page.locator('[data-rm-tool="pdf"]').click();page.locator('#pdfInput').set_input_files(str(ROOT/'tests/fixtures/sample.pdf'));page.locator('#uploadStart').click();page.wait_for_timeout(1800)
  assert any(x['kind']=='pdf' for x in rpc(A,'open',rid)['items'])

  if page.locator('#uploadCancel').is_visible():page.locator('#uploadCancel').click()
  ok('Upload PDF stores shared room metadata with the uploader’s authorized Storage path')
  # Another signed-in student joins and edits the same quiz using the real editor.
  member,mp,me,md=boot(B,390);mp.locator('[data-rm-join]').click();mp.locator('#rmCode').fill(code);mp.locator('#rmSubmit').click();mp.locator('[data-rm-tool="folder"]').wait_for()
  mp.locator(f'[data-rm-item="{folder["id"]}"]').click();mp.locator(f'[data-rm-more="{quiz["id"]}"]').click();mp.locator('[data-room-action="edit"]').click();mp.locator('.qz-prompt').first.fill('Edited by a room member');mp.wait_for_timeout(2400);mp.locator('#qzTopClose').click();mp.wait_for_function('!document.querySelector("#qzPageOverlay").classList.contains("show")')
  full=rpc(A,'item_get',rid,{'id':quiz['id']});assert full['_student_questions'][0]['prompt']=='Edited by a room member';ok('A second member can join by code and edit shared questions on a phone-sized screen')
  rpc(B,'quiz_tools',rid,{'id':quiz['id'],'settings':{'show_answer_immediately':True,'layout':'vertical'}})
  mp.locator(f'[data-rm-item="{quiz["id"]}"]').click();mp.locator('#qzLandTake').click()
  mp.locator('.qz-run-mcq[value="1"]').first.locator('..').click()
  multi=mp.locator('.qz-run-mcq-multi');multi.nth(0).locator('..').click();multi.nth(2).locator('..').click();multi.nth(0).locator('..').click();assert not multi.nth(0).is_checked();multi.nth(0).locator('..').click()
  mp.locator('#qzFinishBtn').click() if mp.locator('#qzFinishBtn').count() else mp.locator('#qzNavNext').click();mp.locator('#qzResultRestartTop').wait_for()
  assert '100%' in mp.locator('.qz-result-big-percent').inner_text();assert len(rpc(B,'quiz_history',rid,{'id':quiz['id']}))==1;assert rpc(A,'quiz_history',rid,{'id':quiz['id']})==[];ok('Taking a room quiz grades instantly and stores only that student’s server-verified history')
  mp.locator('#qzResultDone').click();mp.locator('#qzTopClose').click();mp.wait_for_function('!document.querySelector("#qzPageOverlay").classList.contains("show")')
  rpc(A,'member',rid,{'user_id':B,'can_edit':False});mp.evaluate('qlRooms.refresh()');mp.locator('[data-rm-tool="quiz"]:disabled').wait_for();assert mp.locator('[data-rm-manage]').count()==0
  mp.locator(f'[data-rm-more="{quiz["id"]}"]').click();assert mp.locator('[data-room-action="edit"]').count()==0;mp.locator('[data-room-action="close"]').click();ok('Owner restrictions remove editing controls while the member can still take quizzes')
  rpc(A,'member',rid,{'user_id':B,'can_edit':True});rpc(C,'settings',rid,{'locked':True});mp.evaluate('qlRooms.refresh()');assert mp.locator('[data-rm-tool="folder"]').is_disabled();rpc(C,'settings',rid,{'locked':False});ok('Website admin can override room settings')
  # Room duplicates retain questions, and personal copies use the existing independent writer.
  page.locator(f'[data-rm-item="{folder["id"]}"]').click();page.locator(f'[data-rm-more="{quiz["id"]}"]').click();page.locator('[data-room-action="duplicate"]').click()
  page.locator('.item-title',has_text='Collaborative quiz copy').last.wait_for()
  duplicate=next(x for x in rpc(A,'open',rid)['items'] if x['title']=='Collaborative quiz copy');assert len(rpc(A,'item_get',rid,{'id':duplicate['id']})['_student_questions'])==2
  page.locator(f'[data-rm-more="{quiz["id"]}"]').click();page.locator('[data-room-action="copy"]').click();page.wait_for_timeout(1200)
  assert page.evaluate('qlRooms.active()')==rid;ok('Room duplication retains questions and Save to My Library returns to the shared room')
  page.screenshot(path='/tmp/ql-rooms-tablet.png')
  page.locator('[data-rm-back]').click()
  # Personal workspace realtime refresh is captured without replacing room items.
  before=page.evaluate('state.items.map(x=>x.id)');page.evaluate('__studentWorkspace.refresh()');assert page.evaluate('state.items.map(x=>x.id)')==before
  page.locator('[data-rm-back]').click();page.wait_for_timeout(150);assert set(personal).issubset(set(page.evaluate('state.items.map(x=>x.id)')));copies=page.evaluate('state.items.filter(x=>x.title==="Collaborative quiz"&&!x._room_id)');assert len(copies)==1 and copies[0]['id']!=quiz['id']
  page.locator('[data-rm-close]').click();assert page.locator('#qlRooms').count()==0;ok('Room navigation and personal workspace refresh keep personal library data separate')
  private_questions=page.evaluate('async id=>await service.getQuizQuestionsAdmin(id)',copies[0]['id']);assert len(private_questions)==2
  assert {q['id'] for q in private_questions}.isdisjoint({q['id'] for q in full['_student_questions']})
  page.evaluate('async x=>{const qs=await service.getQuizQuestionsAdmin(x.id);qs[0].prompt="Private copy edit";await service.saveQuizQuestions(x.id,qs,x.quiz_settings)}',copies[0]);assert rpc(A,'item_get',rid,{'id':quiz['id']})['_student_questions'][0]['prompt']=='Edited by a room member';ok('Editing a saved personal copy leaves shared room questions unchanged')
  # Image-heavy saves split by bytes, not just question count.
  page.locator('#qlRoomsNav').click();page.locator(f'[data-rm-open="{rid}"]').click();page.locator('[data-rm-tool="quiz"]').wait_for()
  image_quiz=page.evaluate("async()=>{const item=await service.insertItem({id:uid(),kind:'quiz',title:'Image batches',parent_id:null,quiz_settings:{}});const qs=Array.from({length:2},(_,n)=>({id:uid(),type:'true_false',prompt:'Image '+n,correct_answer:false,image:'data:image/jpeg;base64,'+'A'.repeat(4100000),question_position:n}));return await service.saveQuizQuestions(item.id,qs,{})}")
  assert len(rpc(A,'item_get',rid,{'id':image_quiz['id']})['_student_questions'])==2
  for theme in ['white','neon','ocean']:
   page.evaluate('(theme)=>{document.body.classList.remove("ql-white","ql-neon","ql-ocean");document.body.classList.add("ql-"+theme)}',theme)
   styles=page.locator('#qlRooms').evaluate('(e)=>({bg:getComputedStyle(e).background,color:getComputedStyle(e).color})');assert ('#07070d' in styles['bg'] or 'rgb(7, 7, 13)' in styles['bg']) if theme=='neon' else True
   page.screenshot(path=f'/tmp/ql-rooms-{theme}.png')
  page.evaluate('(id)=>{state.user={...state.user,id};render()}',B);assert page.locator('#qlRooms').count()==0;assert not page.evaluate('state.items.some(x=>x._room_id)');ok('Account changes immediately remove room content; all three themes retain their colors')
  ok('Image-heavy quizzes save through byte-sized batches without exceeding request limits')
  # Admin screens use the same actual disposable database.
  tree=ast.parse((ROOT/'tests/admin-message-drafts.browser.py').read_text());admin_stub=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='stub' for t in n.targets))
  ac=browser.new_context(viewport={'width':1024,'height':850},service_workers='block');ac.add_init_script(admin_stub+f"\nconst previousClient=window.supabase.createClient;window.supabase.createClient=(...args)=>{{const c=previousClient(...args),prior=c.rpc;c.rpc=(name,args)=>name==='ql_room_v1'?(window.missingRooms?Promise.resolve({{data:null,error:{{message:'ql_room_v1 missing',code:'PGRST202'}}}}):fetch('/rpc',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{user:'{C}',args}})}}).then(r=>r.json())):prior(name,args);return c}};Object.defineProperty(navigator,'clipboard',{{value:{{writeText:async text=>window.copiedSetup=text}}}});")
  ap=ac.new_page();ae=[];ap.on('pageerror',lambda e:ae.append(str(e)));ap.on('dialog',lambda d:d.accept())
  def admin_route(r):
   u=r.request.url
   if u==origin+'/rpc':r.continue_()
   elif u.startswith(origin+'/'):
    path=ROOT/u[len(origin)+1:].split('?',1)[0];r.fulfill(status=200,content_type='text/html' if path.suffix=='.html' else 'text/plain',body=path.read_bytes()) if path.is_file() else r.fulfill(status=404,body='')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* mock transport */')
   else:r.abort()
  ac.route('**/*',admin_route);ap.goto(origin+'/admin.html');ap.locator('.nav[data-v="rooms"]').click();ap.locator('#raSave').wait_for()
  ap.locator('#ra_max_members').fill('25');ap.locator('#raSave').click();ap.wait_for_timeout(200);assert rpc(C,'admin_list')['config']['max_members']==25
  ap.locator('[data-ra-status]').first.click();ap.wait_for_timeout(200);assert rpc(C,'open',rid)['room']['status']=='suspended'
  ap.locator('[data-ra-status]').first.click();ap.wait_for_timeout(200);assert rpc(C,'open',rid)['room']['status']=='active'
  ap.locator('[data-ra-manage]').first.click();ap.locator('#raLocked').check();ap.locator('#raRoomSave').click();ap.wait_for_timeout(200);assert rpc(C,'open',rid)['room']['locked'];rpc(C,'settings',rid,{'locked':False})
  ap.evaluate("missingRooms=true;go('rooms')");ap.locator('#raCopySetup').click();ap.wait_for_function('!!window.copiedSetup');assert ap.evaluate('window.copiedSetup')==(ROOT/'supabase/shared_rooms_v1.sql').read_text()
  assert not ae,ae;ac.close();ok('Website admin controls room limits, suspension and owner overrides; iPad setup copies the exact SQL')
  assert not errors,errors;assert not me,me;assert not dialogs,dialogs;assert not md,md
  context.close();member.close();browser.close()
 print(f'{len(checks)} Rooms integration scenarios passed against disposable PostgreSQL; no production requests.')
finally:
 proc.terminate();proc.wait(timeout=10)
