"""Rooms controls in the browser against disposable PostgreSQL (no production requests):
Website Control → Rooms switches (Hidden / Lock / By plan) on the room buttons, the item
"Who can change this?" window, the owner's item rules, and the admin Rooms card."""
from pathlib import Path
import ast,json,os,subprocess,urllib.request,uuid
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
proc=subprocess.Popen(['node','tests/fixtures/rooms-backend.mjs'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'QL_PGLITE_MODULE':os.environ.get('QL_PGLITE_MODULE','/tmp/ql-reliability-deps/node_modules/@electric-sql/pglite/dist/index.js')})
port=json.loads(proc.stdout.readline())['port'];origin=f'http://127.0.0.1:{port}'
A='11111111-1111-4111-8111-111111111111';B='22222222-2222-4222-8222-222222222222';C='33333333-3333-4333-8333-333333333333';D='44444444-4444-4444-8444-444444444444'
source=(ROOT/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
needle='const service=MOCK_MODE?createMockService():createSupabaseService();';source=source.replace(needle,needle+'\nservice.client=window.auditClient;\n',1)
init=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()+r'''
const beforeRoomsRpc=auditRpc;
auditRpc=async(name,args)=>name==='ql_room_v1'||name==='ql_room_look_v1'?await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:state.user.id,fn:name,args})}).then(r=>r.json()):beforeRoomsRpc(name,args);
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
def post(path,payload):
 req=urllib.request.Request(origin+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'});return json.load(urllib.request.urlopen(req))
def rpc(user,action,room=None,data=None,fail=False):
 result=post('/rpc',{'user':user,'args':{'p_action':action,'p_room':room,'p_data':data or {}}})
 if fail:assert result.get('error'),result;return result['error']['message']
 assert not result.get('error'),result;return result['data']
def server_features(features,plan=None):post('/test-features',{'features':features,'plan':plan or {}})
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
     elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith(('.mjs','.js')) else 'text/css' if name.endswith('.css') else 'application/octet-stream',body=(ROOT/name).read_bytes())
     else:r.fulfill(status=404,body='Missing')
    elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local transport */')
    else:r.abort()
   context.route('**/*',route);page.goto(origin+'/',wait_until='domcontentloaded');page.get_by_role('button',name='Continue with Google').click();page.wait_for_function('!!state.user');page.wait_for_timeout(700)
   page.evaluate('''(id)=>{const u={...state.user,id};state.user=u;for(const store of [localStorage,sessionStorage])for(const k of Object.keys(store))if(k.startsWith("ql_mock_auth_session_"))store.setItem(k,JSON.stringify(u));service.getSession=async()=>({user:u});render()}''',user)
   page.wait_for_function('qlPlansState()?.mine?.plan')
   # Keep the page's Website Control in step with what the test sets (also after a plan refresh).
   page.evaluate('''()=>{window.testFeatures={};window.testPlan={};const prior=service.client.rpc;service.client.rpc=async(name,args)=>{const r=await prior(name,args);if(name==='ql_public_config'&&r.data){r.data.settings=r.data.settings||{};r.data.settings.features={...(r.data.settings.features||{}),...testFeatures};(r.data.plans||[]).forEach(p=>p.visibility='public')}if(name==='ql_my_plan'&&r.data?.plan)r.data.plan.features={...(r.data.plan.features||{}),...testPlan};return r}}''')
   if width<700:page.locator('#mobileMenu').click()
   page.locator('#studentWelcomeFloat').wait_for(state='detached')
   page.locator('#qlRoomsNav').click();page.locator('[data-rm-create]').wait_for()
   return context,page,errors,dialogs
  def page_features(page,features,plan=None):
   page.evaluate('''([f,pl])=>{testFeatures=f;testPlan=pl;const x=qlPlansState();x.cfg.settings.features={...f};x.mine.plan.features={...pl};x.cfg.plans.forEach(p=>p.visibility='public');render()}''',[features,plan or {}]);page.wait_for_timeout(250)
  def set_features(pages,features,plan=None):
   server_features(features,plan)
   for pg in pages:page_features(pg,features,plan)

  room=rpc(A,'create',None,{'name':'MD-Y3-S2'});rid=room['id'];code=room['invite_code']
  rpc(B,'join',None,{'code':code});rpc(D,'join',None,{'code':code})
  link=rpc(B,'insert',rid,{'id':str(uuid.uuid4()),'payload':{'kind':'link','title':'Lecture recording','url':'https://example.test/rec','parent_id':None}})

  oc,op,oe,od=boot(A)
  # 1. Website Control on the Rooms buttons (each person's own plan).
  set_features([op],{'room_create':'off','room_join':'off'})
  op.locator('[data-rm-create]').wait_for(state='hidden');assert not op.locator('[data-rm-join]').is_visible()
  assert 'Creating rooms' in rpc(A,'create',None,{'name':'x'},fail=True);ok('Hidden: Create Room / Join are gone on the page and refused by the server')
  set_features([op],{})
  op.locator(f'[data-rm-open="{rid}"]').click();op.locator('[data-rm-add]').wait_for();op.locator('[data-rm-add]').click();op.locator('[data-rm-tool="pdf"]').wait_for()
  set_features([op],{'room_pdf':'off'});op.locator('[data-rm-tool="pdf"]').wait_for(state='hidden');assert op.locator('[data-rm-tool="link"]').is_visible()
  set_features([op],{'room_pdf':'lock'});op.locator('[data-rm-tool="pdf"].ql-locked').wait_for();op.locator('[data-rm-tool="pdf"]').click()
  op.wait_for_timeout(300);assert op.locator('#pdfInput').count()==0 or not op.locator('#pdfInput').is_visible();assert 'locked' in op.locator('#toast').inner_text();assert op.locator('.qu-plans').count()==0
  set_features([op],{'room_pdf':'plan'});op.locator('[data-rm-tool="pdf"].ql-locked').wait_for();op.locator('[data-rm-tool="pdf"]').click();op.locator('.qu-plans').wait_for();op.locator('#modalClose').click()
  set_features([op],{'room_pdf':'plan'},{'room_pdf':True});op.locator('[data-rm-tool="pdf"]:not(.ql-locked)').wait_for()
  op.locator('[data-rm-add]').click();op.locator('.rm-add-menu').wait_for(state='hidden')
  set_features([op],{});ok('Upload PDF follows Hidden, Lock (toast), By plan without it (Choose your plan) and By plan with it')
  set_features([op],{'room_edit':'lock','room_trash':'off','room_save_copy':'plan'})
  op.locator(f'[data-rm-more="{link["id"]}"]').click();op.locator('[data-room-action="edit"].ql-locked').wait_for()
  assert not op.locator('[data-room-action="trash"]').is_visible();assert op.locator('[data-room-action="copy"].ql-locked').count()==1
  op.locator('[data-room-action="edit"]').click();op.wait_for_timeout(200);assert op.locator('#editorTitle').count()==0 or not op.locator('#editorTitle').is_visible()
  op.evaluate('closeModal()');assert 'Editing room content' in rpc(A,'patch',rid,{'id':link['id'],'patch':{'title':'x'}},fail=True)
  set_features([op],{});ok('Edit (Lock), Trash (Hidden) and Save copy (By plan) follow Website Control in the ⋮ menu and on the server')

  # 2. The creator chooses "Only me"; another member sees the lock.
  mc,mp,me,md=boot(B,390);mp.locator(f'[data-rm-open="{rid}"]').click();mp.locator(f'[data-rm-more="{link["id"]}"]').wait_for()
  mp.locator(f'[data-rm-more="{link["id"]}"]').click();mp.locator('[data-room-action="access"]').click();mp.locator('.rm-acc').wait_for()
  assert mp.locator('.rm-acc-opt').count()==3;assert 'Only me' in mp.locator('.rm-acc').inner_text();assert 'Dara' in mp.locator('.rm-acc-people').text_content()
  assert mp.locator('#modalBody').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1');mp.screenshot(path='/tmp/rooms-access-phone.png')
  mp.locator('[name="rmAccMode"][value="creator"]').check();mp.locator('#rmAccCopy').uncheck();mp.locator('#rmAccSave').click();mp.locator('.rm-acc').wait_for(state='detached')
  mp.locator(f'[data-rm-item="{link["id"]}"] .rm-lock-badge',has_text='Only you').wait_for()
  item=next(x for x in rpc(D,'open',rid)['items'] if x['id']==link['id']);assert item['_edit_mode']=='creator' and item['_can_edit'] is False and item['_can_copy'] is False
  ok('The creator saves "Only me" and turns off copies from the ⋮ menu on a phone')
  dc,dp,de,dd=boot(D);dp.locator(f'[data-rm-open="{rid}"]').click();dp.locator(f'[data-rm-item="{link["id"]}"] .rm-lock-badge',has_text='Only Room Member').wait_for()
  dp.screenshot(path='/tmp/rooms-lock-card.png')
  dp.locator(f'[data-rm-more="{link["id"]}"]').click();assert dp.locator('[data-room-action="edit"]').count()==0;assert dp.locator('[data-room-action="access"]').count()==0
  assert dp.locator('.rm-locked-action').count()==3 and 'Only Room Member' in dp.locator('.rm-item-menu').inner_text();assert dp.locator('[data-room-action="copy"]').is_disabled()
  dp.screenshot(path='/tmp/rooms-locked-menu.png')
  dp.evaluate('closeModal()');assert 'Only Room Member' in rpc(D,'patch',rid,{'id':link['id'],'patch':{'title':'x'}},fail=True)
  ok('Other members see "Only Room Member", greyed Edit/Move/Trash and no copy; the server refuses their edit')
  # Me and people I choose → Dara can edit; the owner can always edit.
  mp.locator(f'[data-rm-more="{link["id"]}"]').click();mp.locator('[data-room-action="access"]').click();mp.locator('.rm-acc').wait_for()
  mp.locator('[name="rmAccMode"][value="chosen"]').check();mp.locator('.rm-acc-people').wait_for();assert 'Room Owner' not in mp.locator('.rm-acc-people').inner_text()
  mp.locator('.rm-acc-person',has_text='Dara').locator('input').check();mp.locator('#rmAccSave').click();mp.locator('.rm-acc').wait_for(state='detached')
  assert rpc(D,'patch',rid,{'id':link['id'],'patch':{'title':'Lecture recording (Dara)'}})['title']=='Lecture recording (Dara)'
  dp.evaluate('qlRooms.refresh()');dp.locator(f'[data-rm-item="{link["id"]}"] .rm-lock-badge',has_text='Only Room Member + 1').wait_for()
  dp.locator(f'[data-rm-more="{link["id"]}"]').click();dp.locator('[data-room-action="edit"]').wait_for();dp.evaluate('closeModal()')
  assert rpc(A,'patch',rid,{'id':link['id'],'patch':{'title':'Owner title'}})['title']=='Owner title';ok('"Me and people I choose" lets the chosen member edit; the owner can always edit')

  # 3. Owner rules: new items start as "only the creator", creators cannot choose.
  op.evaluate('qlRooms.refresh()');op.locator('[data-rm-manage]').click();op.locator('#rmSaveSettings').wait_for()
  op.locator('[name="rmItemDefault"]').first.scroll_into_view_if_needed();op.screenshot(path='/tmp/rooms-owner-items.png')
  op.locator('[name="rmItemDefault"][value="creator"]').check();op.locator('#rmCreatorChoice').uncheck();op.locator('#rmSaveSettings').click();op.wait_for_timeout(400)
  perms=rpc(A,'open',rid)['room']['permissions'];assert perms['item_default']=='creator' and perms['creator_choice'] is False
  folder=rpc(D,'insert',rid,{'id':str(uuid.uuid4()),'payload':{'kind':'folder','title':'Dara notes','parent_id':None}});assert folder['_edit_mode']=='creator' and folder['_can_access'] is False
  dp.evaluate('qlRooms.refresh()');dp.locator(f'[data-rm-more="{folder["id"]}"]').click();assert dp.locator('[data-room-action="access"]').count()==0;dp.evaluate('closeModal()')
  op.evaluate('qlRooms.refresh()');op.locator(f'[data-rm-more="{folder["id"]}"]').click();op.locator('[data-room-action="access"]').wait_for();op.evaluate('closeModal()')
  ok('Room settings: "Only the creator can edit" for new items and "Let creators choose" off; the owner still can')
  for pg,e,d in [(op,oe,od),(mp,me,md),(dp,de,dd)]:assert not e,e
  assert not [x for x in od+md+dd if 'Permanently' not in x],od+md+dd

  # 4. Admin: Website Control has the Rooms card; Admin → Rooms keeps only the limits.
  tree=ast.parse((ROOT/'tests/admin-message-drafts.browser.py').read_text());admin_stub=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='stub' for t in n.targets))
  ac=browser.new_context(viewport={'width':1280,'height':900},service_workers='block');ac.add_init_script(admin_stub+f"\nwindow.adminFixture={{settings:fakeSettings,plan:fakePlan}};const previousClient=window.supabase.createClient;window.supabase.createClient=(...args)=>{{const c=previousClient(...args),previousRpc=c.rpc;c.rpc=(name,args)=>{{if(name==='ql_admin_set_setting'){{const row=fakeSettings.find(x=>x.key===args.p_key);if(row)row.value=structuredClone(args.p_value);return Promise.resolve({{data:true,error:null}})}}if(name==='ql_admin_save_plan'){{Object.assign(fakePlan,args.p);return Promise.resolve({{data:fakePlan,error:null}})}}return name==='ql_room_v1'?fetch('/rpc',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{user:'{C}',args}})}}).then(r=>r.json()):previousRpc(name,args)}};return c}};")
  ap=ac.new_page();ae=[];ap.on('pageerror',lambda e:ae.append(str(e)));ap.on('dialog',lambda d:d.accept())
  def admin_route(r):
   u=r.request.url
   if u==origin+'/rpc':r.continue_()
   elif u.startswith(origin+'/'):
    path=ROOT/u[len(origin)+1:].split('?',1)[0];r.fulfill(status=200,content_type='text/html' if path.suffix=='.html' else 'text/plain',body=path.read_bytes()) if path.is_file() else r.fulfill(status=404,body='')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* mock transport */')
   else:r.abort()
  ac.route('**/*',admin_route);ap.goto(origin+'/admin.html');ap.locator('.nav[data-v="rooms"]').click();ap.locator('#raSave').wait_for()
  assert ap.locator('[data-ra-perm]').count()==0;ap.locator('#raToCtl').click();ap.locator('.mode[data-k="room_create"]').wait_for()
  card=ap.locator('.grpgrid .card',has=ap.locator('.mode[data-k="room_create"]'));keys=card.locator('.mode').evaluate_all('(e)=>e.map(x=>x.dataset.k)')
  assert keys==['nav_rooms','room_create','room_join','room_pdf','room_link','room_folder','room_quiz','room_edit','room_trash','room_save_copy'],keys
  assert ap.locator('.grpgrid .card',has_text='Left menu & tabs').locator('.mode[data-k="nav_rooms"]').count()==0
  card.locator('.mode[data-k="room_pdf"] [data-m="plan"]').click();ap.wait_for_function("adminFixture.settings.find(x=>x.key==='features').value.room_pdf==='plan'")
  ap.locator('[data-gall="Rooms"][data-m="lock"]').click();ap.wait_for_function("adminFixture.settings.find(x=>x.key==='features').value.room_save_copy==='lock'")
  ap.screenshot(path='/tmp/rooms-website-control-card.png')
  ap.locator('.nav[data-v="plans"]').click();ap.locator('[data-edit="free"]').click();ap.locator('[data-feat="room_pdf"]').check();ap.locator('#pSave').click();ap.wait_for_function('adminFixture.plan.features.room_pdf===true')
  assert not ae,ae;ok('Website Control has a Rooms card (10 switches) also in Edit plan; Admin → Rooms points there instead of its old ticks')
  ac.close();oc.close();mc.close();dc.close();browser.close()
 print(f'{len(checks)} Rooms controls scenarios passed against disposable PostgreSQL; no production requests.')
finally:
 proc.terminate();proc.wait(timeout=10)
