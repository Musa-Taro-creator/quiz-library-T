"""A hidden tab does not keep asking the server; it catches up when it is visible again.

Uses the simulated Supabase from the password-recovery test and Playwright's clock to
fast-forward 5 minutes. Counts ql_device_check and ql_support_unread calls.
Set QL_HIDDEN_SOURCE_REF to an older Git ref to see the old behaviour.
"""
from pathlib import Path
import os, re, subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
if os.environ.get('QL_HIDDEN_SOURCE_REF'):
    SOURCE = subprocess.check_output(['git', 'show', os.environ['QL_HIDDEN_SOURCE_REF'] + ':index.html'], cwd=ROOT, text=True)
BASE = re.search(r"STUB = r'''(.*?)'''", (ROOT / 'tests/password-recovery.browser.py').read_text(), re.S).group(1)
SESSION = """sessionStorage.setItem('local-recovery-session',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',
 email:'audit@example.test',app_metadata:{provider:'email'},user_metadata:{full_name:'Local test'}},expires_at:Math.floor(Date.now()/1000)+3600}));"""
COUNT = r'''
window.pollTest={calls:{}};let hidden=false;
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
window.setHidden=v=>{hidden=v;document.dispatchEvent(new Event('visibilitychange'))};
const realFactory=window.supabase.createClient;
window.supabase.createClient=(...args)=>{const c=realFactory(...args),rpc=c.rpc;
 c.rpc=async(name,args)=>{pollTest.calls[name]=(pollTest.calls[name]||0)+1;
  if(name==='ql_device_check')return {data:{signed_in:true,any:true,limit:1,count:1,newest:null},error:null};
  if(name==='ql_support_unread')return {data:0,error:null};
  return rpc(name,args)};return c};
'''
WATCH = ['ql_device_check', 'ql_support_unread']
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1024, 'height': 768}, service_workers='block')
    context.add_init_script(SESSION + BASE + COUNT)
    def route(r):
        url = r.request.url
        if url.startswith('http://127.0.0.1:8798/'):
            sub = url.split('8798/', 1)[1].split('?', 1)[0]
            if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
            elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
            else: r.fulfill(status=404, body='')
        elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
        else: r.abort()
    context.route('**/*', route)
    page = context.new_page()
    page.clock.install()
    page.goto('http://127.0.0.1:8798/')
    page.clock.run_for(10000)
    page.wait_for_function('(pollTest.calls.ql_device_check||0)>0', timeout=10000)
    count = lambda: page.evaluate('(names)=>names.map(n=>pollTest.calls[n]||0)', WATCH)
    page.evaluate('setHidden(true)')
    before = count()
    page.clock.run_for(5 * 60 * 1000)   # 5 minutes in a hidden tab
    during = [a - b for a, b in zip(count(), before)]
    print('server calls while hidden for 5 min (device check, support unread):', during, flush=True)
    assert during == [0, 0], during
    ok('A hidden tab makes no device or support checks')
    page.evaluate('setHidden(false)')
    page.clock.run_for(6000)
    back = [a - b for a, b in zip(count(), before)]
    assert back[0] >= 1 and back[1] >= 1, back
    ok('Coming back to the tab checks again at once')
    browser.close()
print(f'{len(checks)} checks passed')
