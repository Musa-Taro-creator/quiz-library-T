"""Visible Dashboard Back buttons: real UI and browser history, local transport."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
needle='const service=MOCK_MODE?createMockService():createSupabaseService();'
SOURCE=SOURCE.replace(needle,needle+'\nservice.client=window.auditClient;\n',1)
INIT=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()+r'''
const beforeBackRpc=auditRpc;
window.backPacket={root_ref:'root',nodes:[
 {ref:'root',kind:'folder',title:'MD-Y3-S2'},
 {ref:'links',parent_ref:'root',kind:'folder',title:'Link Quizzes'},
 {ref:'pathology',parent_ref:'links',kind:'folder',title:'Anatomopathology'},
 {ref:'file',parent_ref:'pathology',kind:'link',title:'Study link',url:'https://example.test'}
]};
auditRpc=async(name,args)=>{
 if(name==='ql_dash_list'&&audit.holdList)await new Promise(resolve=>window.releaseBackList=resolve);
 if(name==='ql_dash_list'&&audit.failList)return {error:{message:'Simulated loading error'}};
 if(name==='ql_dash_open')return {data:{payload:audit.emptyFolder?{nodes:[]}:backPacket},error:null};
 if(name==='ql_get_external_item_share')return {data:{payload:backPacket},error:null};
 return beforeBackRpc(name,args);
};
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 c=b.new_context(viewport={'width':1280,'height':894},has_touch=True,service_workers='block');c.add_init_script(INIT)
 page=c.new_page();page.set_default_timeout(8000);errors=[];dialogs=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('dialog',lambda d:(dialogs.append(d.message),d.dismiss()))
 def route(r):
  u=r.request.url
  if u.startswith('http://127.0.0.1:8793/'):
   name=u.split('8793/',1)[1].split('?',1)[0]
   if name in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=SOURCE)
   elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith('.mjs') else 'application/octet-stream',body=(ROOT/name).read_bytes())
   else:r.fulfill(status=404,body='Missing')
  elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local transport */')
  else:r.abort()
 c.route('**/*',route)
 page.goto('http://127.0.0.1:8793/',wait_until='domcontentloaded');page.get_by_role('button',name='Continue with Google').click()
 page.wait_for_function('!!state.user');page.wait_for_timeout(650)
 page.evaluate('service.getSession=async()=>state.user?{user:state.user}:null')
 def open_board():
  page.evaluate('qlOpenDash()');page.locator('#qlDash [data-post="folder-post"]').wait_for()
 def open_deep():
  page.locator('#qlDash [data-post="folder-post"]').click()
  page.locator('#qlItemViewer [data-ref="links"]').click();page.locator('#qlItemViewer [data-ref="pathology"]').click()
 for skin in ['white','neon','ocean']:
  for width in [1280,768,390,320]:
   page.set_viewport_size({'width':width,'height':894});page.evaluate('(s)=>document.body.className="ql-skin ql-"+s',skin)
   open_board();back=page.locator('#qlDash [data-ql-dash-back]');assert back.is_visible()
   assert back.bounding_box()['height']>=44
   assert page.locator('#qlDash').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
   open_deep();back=page.locator('#qlItemViewer [data-ql-dash-back]');assert back.is_visible()
   assert page.locator('#qlItemViewer').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
   if skin=='white' and width==1280:page.screenshot(path='/tmp/ql-dashboard-back-tablet.png')
   r=back.bounding_box();close=page.locator('#qlItemViewer .ql-iv-close').bounding_box();assert r['x']+r['width']<=close['x']
   back.click();assert page.locator('#qlItemViewer [data-ref="pathology"]').count()==1
   page.locator('#qlItemViewer [data-ql-dash-back]').click();assert page.locator('#qlItemViewer [data-ref="links"]').count()==1
   page.locator('#qlItemViewer [data-ql-dash-back]').click();assert page.locator('#qlItemViewer').count()==0
   assert page.locator('#qlDash').count()==1
   page.locator('#qlDash [data-ql-dash-back]').click();page.wait_for_timeout(180)
   assert page.locator('#qlDash').count()==0 and page.evaluate('state.section')=='documents'
   ok(f'{skin}/{width}px: visible Back returns through each parent, Dashboard and library; no header overflow')
 # X keeps closing the viewer as a whole, even from a nested folder.
 open_board();open_deep();page.locator('#qlItemViewer .ql-iv-close').click()
 assert page.locator('#qlItemViewer').count()==0 and page.locator('#qlDash').count()==1
 page.locator('#qlDash [data-ql-dash-back]').click();page.wait_for_timeout(200)
 n=len(dialogs);page.evaluate('history.back()');page.wait_for_timeout(200)
 assert dialogs[n:]==['Leave Quiz Library?']
 ok('Close still exits the viewer; visible Back leaves no invisible browser-history layers')
 # System Back and breadcrumbs remain available alongside visible Back.
 open_board();open_deep();page.evaluate('history.back()');page.wait_for_timeout(150)
 assert page.locator('#qlItemViewer [data-ref="pathology"]').count()==1
 page.locator('#qlItemViewer [data-crumb="root"]').click()
 page.locator('#qlItemViewer [data-ql-dash-back]').click();page.locator('#qlDash [data-ql-dash-back]').click();page.wait_for_timeout(200)
 ok('System Back and breadcrumbs still navigate their existing routes')
 # Loading/errors/empty payloads also provide a working exit.
 page.evaluate('audit.holdList=true;void qlOpenDash()');page.locator('#qlDash [data-ql-dash-back]').click()
 page.evaluate('audit.holdList=false;releaseBackList()');page.wait_for_timeout(200)
 assert page.locator('#qlDash').count()==0
 page.evaluate('audit.failList=true;qlOpenDash()');page.locator('#qlDash .qd-empty').wait_for()
 page.locator('#qlDash [data-ql-dash-back]').click();page.evaluate('audit.failList=false')
 open_board();page.evaluate('audit.emptyFolder=true');page.locator('#qlDash [data-post="folder-post"]').click()
 page.locator('#qlItemViewer [data-ql-dash-back]').click();assert page.locator('#qlItemViewer').count()==0
 page.locator('#qlDash [data-ql-dash-back]').click();page.wait_for_timeout(150)
 ok('Back works during loading, after errors, and for an empty posted folder')
 # The additional controls are restricted to Dashboard views.
 page.evaluate('audit.emptyFolder=false;qlOpenItemShareViewer("test-public-link")')
 page.locator('#qlItemViewer [data-ref="links"]').wait_for()
 assert page.locator('#qlItemViewer [data-ql-dash-back]').count()==0
 ok('External shared-folder pages retain their existing controls')
 assert not errors,errors
 c.close();b.close()
print(f'{len(checks)} Dashboard Back scenarios passed; no live requests.')
