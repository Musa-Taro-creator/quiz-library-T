"""Rooms look in the browser against disposable PostgreSQL (no production requests): cover theme,
live header (studying now, stats), "since your last visit", NEW badges, the + Add menu, search,
filters, sort, grid/list view, pins and quiz scores on the cards."""
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
def rpc(user,action,room=None,data=None,fail=False,fn='ql_room_v1'):
 result=post('/rpc',{'user':user,'fn':fn,'args':{'p_action':action,'p_room':room,'p_data':data or {}}})
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

  room=rpc(A,'create',None,{'name':'MD-Y3-S2','description':'Our shared space for notes, practice and the next exam.'});rid=room['id'];code=room['invite_code']
  rpc(B,'join',None,{'code':code});rpc(D,'join',None,{'code':code})
  def add(user,kind,title,parent=None,extra=None):return rpc(user,'insert',rid,{'id':str(uuid.uuid4()),'payload':{'kind':kind,'title':title,'parent_id':parent,**(extra or {})}})
  folder=add(A,'folder','Cardiology');add(A,'folder','Week 3 notes');link=add(A,'link','Lecture recording',None,{'url':'https://www.youtube.com/watch?v=1'})
  quiz=add(D,'quiz','Heart sounds practice');add(D,'quiz','ECG basics',folder['id'])
  qs=[{'id':'q1','type':'true_false','prompt':'One','correct_answer':True,'points':1},{'id':'q2','type':'true_false','prompt':'Two','correct_answer':False,'points':1}]
  sid=str(uuid.uuid4());rpc(D,'save_begin',rid,{'id':quiz['id'],'save_id':sid,'revision':1,'fingerprint':'f','count':2,'settings':{}});rpc(D,'save_part',rid,{'id':quiz['id'],'save_id':sid,'part':0,'questions':qs});saved=rpc(D,'save_finish',rid,{'id':quiz['id'],'save_id':sid})
  for user,a2 in [(B,False),(D,True)]:rpc(user,'quiz_submit',rid,{'id':quiz['id'],'attempt_id':str(uuid.uuid4()),'revision':saved['_qlRevision'],'answers':[{'question_id':'q1','given_answer':True},{'question_id':'q2','given_answer':a2}]})
  rpc(D,'summary',rid,{},fn='ql_room_look_v1')
  # Sokha's last visit was 2 days ago; Dara's quiz came after it.
  post('/test-sql',{'sql':"insert into ql_room_visits_v1(room_id,user_id,last_seen_at,prev_seen_at,active_at) values($1,$2,now()-interval '2 days',now()-interval '3 days',now()-interval '2 days') on conflict(room_id,user_id) do update set last_seen_at=excluded.last_seen_at,prev_seen_at=excluded.prev_seen_at",'params':[rid,B]})
  post('/test-sql',{'sql':"update ql_room_members_v1 set joined_at=now()-interval '5 days' where room_id=$1",'params':[rid]})
  post('/test-sql',{'sql':"update ql_room_items_v1 set created_at=now()-interval '4 days' where room_id=$1 and creator_id=$2",'params':[rid,A]})

  oc,op,oe,od=boot(A)
  op.locator(f'[data-rm-open="{rid}"]').click();op.locator('[data-rm-add]').wait_for();op.locator('.rm-hstats').wait_for()
  # Owner: theme + emoji, pin.
  op.locator('[data-rm-theme]').click();op.locator('[data-rm-swatch="sunset"]').click();op.locator('[data-rm-emoji="🫀"]').click();op.locator('#rmThemeSave').click();op.locator('.rm-themeform').wait_for(state='detached')
  op.locator('.rm-cover .rm-hero-symbol',has_text='🫀').wait_for();r=rpc(A,'open',rid)['room'];assert r['theme']=='sunset' and r['emoji']=='🫀'
  assert '#f97316' in op.locator('.rm-room-hero').get_attribute('style')
  op.locator(f'[data-rm-more="{quiz["id"]}"]').click();op.locator('[data-room-action="pin"]',has_text='Pin to top').click();op.locator('.rm-pins',has_text='Heart sounds practice').wait_for()
  op.locator('[data-rm-close]').click();op.locator('#qlRoomsNav').click();op.locator(f'[data-rm-open="{rid}"] .rm-room-symbol',has_text='🫀').wait_for()
  ok('Owner sets the cover colour and emoji (also on the room list) and pins a quiz')

  mc,mp,me,md=boot(B)
  mp.locator(f'[data-rm-open="{rid}"]').click();mp.locator('.rm-whatsnew').wait_for()
  assert '2 new things since your last visit' in mp.locator('.rm-whatsnew').inner_text();assert 'Heart sounds practice' in mp.locator('.rm-whatsnew').inner_text()
  assert mp.locator('[data-rm-theme]').count()==0 and mp.locator('.rm-code-chip').count()==0,'members do not get the owner controls'
  stats=mp.locator('.rm-hstats').inner_text();assert '3\nmembers' in stats and '2\nquizzes' in stats and '2\nquestions' in stats and '2\ntaken this week' in stats,stats
  assert 'studying now' in mp.locator('.rm-hero-badges').inner_text()
  card=mp.locator(f'[data-rm-item="{quiz["id"]}"]');assert card.locator('.rm-new').count()==1;assert '2 classmates took it' in card.inner_text();assert '100%' in card.inner_text()
  assert mp.locator(f'[data-rm-item="{link["id"]}"]').locator('.rm-new').count()==1,'NEW stays until you open it'
  assert 'Lecture recording' not in mp.locator('.rm-whatsnew').inner_text(),'the strip only lists things added after the last visit'
  assert 'youtube.com' in mp.locator(f'[data-rm-item="{link["id"]}"]').inner_text()
  assert 'Dara' in card.locator('.rm-foot').inner_text()
  ok('Member sees studying now, room numbers, "2 new things since your last visit", NEW badges, classmates who took it and their best score')
  # Pinned quiz shows the score ring and Continue.
  pin=mp.locator('.rm-pin',has_text='Heart sounds practice');assert '100%' in pin.inner_text() and 'Continue' in pin.inner_text()
  # Opening an item removes NEW and the strip entry.
  mp.locator('[data-rm-new]',has_text='Heart sounds practice').click();mp.locator('#qzTopClose').click();mp.wait_for_function('!document.querySelector("#qzPageOverlay").classList.contains("show")')
  mp.evaluate('qlRooms.refresh()');mp.wait_for_timeout(400);assert card.locator('.rm-new').count()==0;assert 'Heart sounds practice' not in (mp.locator('.rm-whatsnew').inner_text() if mp.locator('.rm-whatsnew').count() else '')
  ok('Pinned quiz shows the score ring; opening a new item removes its NEW badge and strip entry')
  # Search, filters, sort and list view.
  mp.locator('[data-rm-search]').fill('ecg');mp.locator('[data-rm-heading]',has_text='Search results').wait_for();assert mp.locator('[data-rm-item]').count()==1;assert mp.locator('[data-rm-search]').evaluate('(e)=>e===document.activeElement')
  mp.locator('[data-rm-search]').fill('');mp.locator('[data-rm-filter="quiz"]').click();assert mp.locator('.rm-library [data-rm-item]').count()==1
  mp.locator('[data-rm-filter="new"]').click();newest=mp.locator('.rm-library [data-rm-item] .item-title').all_inner_texts();assert 'Lecture recording' in newest and 'Heart sounds practice' not in newest,newest;mp.locator('[data-rm-filter="all"]').click()
  mp.locator('[data-rm-sort]').select_option('az');names=mp.locator('.rm-library [data-rm-item] .item-title').all_inner_texts();assert names==['Cardiology','Week 3 notes','Heart sounds practice','Lecture recording'],names
  mp.locator('[data-rm-view="list"]').click();mp.locator('.rm-list-view .rm-row').first.wait_for();assert mp.evaluate("localStorage.getItem('ql_rm_view')")=='list'
  mp.locator('[data-rm-view="grid"]').click()
  ok('Search keeps typing focus; filter chips, A–Z sort and list view work')
  # Phone layout: no sideways scrolling and the Add menu fits.
  mp.set_viewport_size({'width':390,'height':844});mp.wait_for_timeout(200);assert mp.locator('#qlRooms').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
  mp.locator('[data-rm-add]').click();box=mp.locator('.rm-add-menu').bounding_box();assert box['x']>=0 and box['x']+box['width']<=391,box
  mp.screenshot(path='/tmp/rooms-look-phone.png',full_page=False);mp.locator('[data-rm-add]').click()
  for theme in ['neon','ocean']:
   mp.evaluate('(t)=>{document.body.classList.remove("ql-white","ql-neon","ql-ocean");document.body.classList.add("ql-"+t)}',theme);mp.wait_for_timeout(100);mp.screenshot(path=f'/tmp/rooms-look-{theme}.png')
  ok('Phone: no sideways scroll; the Add menu fits on screen; neon and ocean themes render')
  op.set_viewport_size({'width':1280,'height':1400});op.locator(f'[data-rm-open="{rid}"]').click();op.locator('.rm-hstats').wait_for();op.wait_for_timeout(300);op.screenshot(path='/tmp/rooms-look-desktop.png')
  for e in [oe,me]:assert not e,e
  assert not od and not md,(od,md)
  oc.close();mc.close();browser.close()
 print(f'{len(checks)} Rooms look scenarios passed against disposable PostgreSQL; no production requests.')
finally:
 proc.terminate();proc.wait(timeout=10)
