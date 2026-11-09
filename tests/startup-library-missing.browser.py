"""When the Supabase library cannot be downloaded, both apps explain it instead of
showing an empty library or a page stuck on "Connecting…"; Retry reloads.
All outside requests are blocked; nothing reaches production."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://127.0.0.1:8826/'
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
def route(r):
 u=r.request.url
 if u.startswith(ORIGIN):
  name=u[len(ORIGIN):].split('?',1)[0] or 'index.html'
  f=ROOT/name
  if f.is_file():r.fulfill(status=200,content_type='text/html' if name.endswith('.html') else None,body=f.read_bytes())
  else:r.fulfill(status=404,body='Missing')
 else:r.abort()  # CDN (Supabase library), fonts and Supabase itself are unreachable
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':390,'height':844},service_workers='block');context.route('**/*',route)
 page=context.new_page();loads=[]
 page.on('load',lambda:loads.append(1))
 page.goto(ORIGIN+'index.html');page.wait_for_selector('#setupScreen.show',timeout=10000)
 assert page.text_content('#setupTitle')=='Unable to open Quiz Library'
 assert 'did not load' in page.text_content('#setupError')
 ok('student app shows the startup error screen instead of an empty library')
 before=len(loads);page.click('#retrySetup');page.wait_for_timeout(1500)
 assert len(loads)>before,'Retry did not reload the page'
 ok('Retry reloads the student app')
 admin=context.new_page();admin.goto(ORIGIN+'admin.html');admin.wait_for_selector('#adminStartError:not(.hidden)',timeout=10000)
 assert 'did not load' in admin.text_content('#adminStartError')
 assert admin.text_content('#adminStartStatus')=='Could not connect'
 ok('Admin explains the missing library instead of staying on "Connecting…"')
 browser.close()
print(f'{len(checks)} checks passed')
