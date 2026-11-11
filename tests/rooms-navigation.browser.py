"""Rooms design, folder navigation and browser Back against disposable PostgreSQL."""
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
auditRpc=async(name,args)=>name==='ql_room_v1'||name==='ql_room_look_v1'?await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:state.user.id,fn:name,args})}).then(r=>r.json()):beforeRoomsRpc(name,args);
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
   page.locator('#studentWelcomeFloat').wait_for(state='detached')
   page.locator('#qlRoomsNav').click()
   try:page.locator('[data-rm-create]').wait_for()
   except Exception:
    print('BOOT ERRORS',errors,dialogs,page.locator('#qlRooms').inner_text() if page.locator('#qlRooms').count() else page.locator('body').inner_text()[-2500:],flush=True);raise
   return context,page,errors,dialogs
  room=rpc(A,'create',None,{'name':'MD-Y3-S2','description':'Our shared space for notes, practice and the next exam.'});rid=room['id']
  def add(kind,title,parent=None):return rpc(A,'insert',rid,{'id':str(uuid.uuid4()),'payload':{'kind':kind,'title':title,'parent_id':parent,'quiz_settings':{'question_count':0}}})
  folder=add('folder','Z. Course materials');nested=add('folder','Practice cases',folder['id']);quiz=add('quiz','Anatomy · Practice',nested['id'])
  for n in range(24):add('folder',f'Week {n+1:02} · Lecture notes')
  other=rpc(A,'create',None,{'name':'Anatomy study circle','description':'Diagrams, notes and revision with friends.'})
  rpc(A,'create',None,{'name':'Exam week · Questions & answers','description':'A room with a longer title to check small screens.'})
  for theme in (['white'] if os.environ.get('QL_ROOMS_VISUAL_ONLY') else ['white','neon','ocean']):
   for width in ([390,768] if os.environ.get('QL_ROOMS_VISUAL_ONLY') else [320,390,768,1280]):
    context,page,errors,dialogs=boot(A,width)
    page.evaluate('(theme)=>{document.body.classList.remove("ql-white","ql-neon","ql-ocean");document.body.classList.add("ql-"+theme)}',theme)
    assert page.locator('[data-rm-back]').inner_text().strip()=='My Library'
    assert page.locator('[data-rm-open]').count()==3
    assert page.locator('#qlRooms').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
    if width in [390,768]:page.screenshot(path=f'/tmp/rooms-new-list-{theme}-{width}.png')
    page.locator(f'[data-rm-open="{rid}"]').click();page.locator('[data-rm-add]').wait_for()
    assert 'All Rooms' in page.locator('[data-rm-back]').inner_text();assert page.locator('#qlRooms').evaluate('(e)=>e.scrollTop')==0
    for element in page.locator('[data-rm-add],[data-rm-search],[data-rm-back],[data-rm-close],[data-rm-manage]').all():
     box=element.bounding_box();assert box['x']>=-1 and box['x']+box['width']<=width+1,(width,theme,box)
    if width in [390,768]:page.screenshot(path=f'/tmp/rooms-new-library-{theme}-{width}.png')
    # A real click scrolls the last card into view; Back restores that exact root position.
    page.evaluate('''()=>document.addEventListener('click',e=>{if(e.target.closest('[data-rm-item]'))window.navSourceScroll=document.querySelector('#qlRooms').scrollTop},true)''')
    page.locator(f'[data-rm-item="{folder["id"]}"]').click();page.locator('[data-rm-heading]',has_text='Z. Course materials').wait_for()
    saved=page.evaluate('navSourceScroll');assert saved>100
    page.locator(f'[data-rm-item="{nested["id"]}"]').focus();page.keyboard.press('Enter');page.locator('[data-rm-heading]',has_text='Practice cases').wait_for()
    assert page.locator('.rm-crumbs [aria-current="page"]').inner_text()=='Practice cases'
    assert 'Z. Course materials' in page.locator('[data-rm-back]').inner_text()
    page.locator('[data-rm-trash]').click();assert page.locator('.rm-crumbs [aria-current="page"]').inner_text()=='Trash'
    page.locator('[data-rm-back]').click();assert page.locator('[data-rm-heading]').inner_text().startswith('Practice cases')
    page.locator(f'[data-rm-item="{quiz["id"]}"]').click();page.locator('#qzTopClose').click();page.wait_for_function('!document.querySelector("#qzPageOverlay").classList.contains("show")')
    assert page.locator('[data-rm-heading]').inner_text().startswith('Practice cases')
    page.locator('[data-rm-manage]').click();page.locator('#rmActivity').click();page.locator('#rmActivityBack').click();page.locator('#rmManageClose').click()
    assert page.locator('[data-rm-heading]').inner_text().startswith('Practice cases')
    # Parent breadcrumbs, visible Back and system Back all follow the same levels.
    page.locator(f'[data-rm-path="{folder["id"]}"]').click();page.locator(f'[data-rm-item="{nested["id"]}"]').focus();page.keyboard.press('Space')
    page.locator('[data-rm-heading]',has_text='Practice cases').wait_for()
    page.evaluate('history.back()');page.locator('[data-rm-heading]',has_text='Z. Course materials').wait_for()
    page.locator('[data-rm-back]').click();page.locator('[data-rm-heading]',has_text='Room library').wait_for()
    assert abs(page.locator('#qlRooms').evaluate('(e)=>e.scrollTop')-saved)<8
    assert page.locator(f'[data-rm-item="{folder["id"]}"]').evaluate('(e)=>e===document.activeElement')
    # Header stays reachable while deep in a long folder listing.
    box=page.locator('[data-rm-back]').bounding_box();assert 0<=box['y']<150
    page.locator('[data-rm-back]').click();page.locator('[data-rm-open]').first.wait_for()
    assert page.locator(f'[data-rm-open="{rid}"]').evaluate('(e)=>e===document.activeElement')
    page.locator(f'[data-rm-open="{rid}"]').click();page.locator('[data-rm-add]').wait_for();page.evaluate('history.back()');page.locator('[data-rm-open]').first.wait_for()
    page.evaluate('history.back()');page.wait_for_function('!document.querySelector("#qlRooms")')
    assert not page.evaluate('state.items.some(x=>x._room_id)')
    if theme=='white' and width==390:
     page.locator('#mobileMenu').click();page.locator('#qlRoomsNav').click();page.locator('[data-rm-open]').first.wait_for()
     page.evaluate('''(rid)=>{const prior=service.client.rpc;window.holdRoom=rid;service.client.rpc=async(name,args)=>{const data=await prior(name,args);if(name==='ql_room_v1'&&args.p_action==='open'&&args.p_room===holdRoom){holdRoom=null;await new Promise(resolve=>window.releaseRoomOpen=resolve)}return data}}''',rid)
     page.locator(f'[data-rm-open="{rid}"]').click();page.wait_for_function('!!window.releaseRoomOpen')
     page.locator(f'[data-rm-open="{other["id"]}"]').click();page.wait_for_function('(id)=>qlRooms.active()===id',arg=other['id'])
     page.evaluate('releaseRoomOpen()');page.wait_for_timeout(150);assert page.evaluate('qlRooms.active()')==other['id']
     page.locator('[data-rm-close]').click();ok('A delayed room-opening response cannot replace a more recently selected room')
    assert not errors,errors;assert not dialogs,dialogs
    ok(f'{theme}/{width}px: nested entry, breadcrumbs, Trash, quiz/settings return, sticky Back, scroll/focus restoration and system Back')
    context.close()
  browser.close()
 print(f'{len(checks)} Rooms navigation/layout scenarios passed; no production requests.')
finally:
 proc.terminate();proc.wait(timeout=10)
