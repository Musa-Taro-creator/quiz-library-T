"""One open tab must not call ql_device_check in a loop.

The simulated server behaves like the old SQL: every ql_device_check writes "last seen",
and Realtime sends that UPDATE back to the tab. Before the fix the tab answered each
update with another check, without a pause. No real accounts or network are used.
Set QL_LOOP_SOURCE_REF to an older Git ref to see the old behaviour.
"""
from pathlib import Path
import os, re, subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
if os.environ.get('QL_LOOP_SOURCE_REF'):
    SOURCE = subprocess.check_output(['git', 'show', os.environ['QL_LOOP_SOURCE_REF'] + ':index.html'], cwd=ROOT, text=True)
# Reuse the simulated Supabase from the password-recovery test (real app code, fake server).
BASE = re.search(r"STUB = r'''(.*?)'''", (ROOT / 'tests/password-recovery.browser.py').read_text(), re.S).group(1)
SESSION = """sessionStorage.setItem('local-recovery-session',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',
 email:'audit@example.test',app_metadata:{provider:'email'},user_metadata:{full_name:'Local test'}},expires_at:Math.floor(Date.now()/1000)+3600}));"""
LIVE = r'''
window.loopTest={checks:0,handlers:[]};
const realFactory=window.supabase.createClient;
window.supabase.createClient=(...args)=>{const c=realFactory(...args);
 c.channel=()=>{const ch={on(type,filter,cb){loopTest.handlers.push({table:filter&&filter.table,cb});return ch},subscribe(){return ch},unsubscribe(){}};return ch};
 c.removeChannel=async()=>{};
 const rpc=c.rpc;
 c.rpc=async(name,args)=>{
  if(name==='ql_device_check'){loopTest.checks++;
   // like the old SQL: the check updates last_seen, and Realtime reports it
   setTimeout(()=>loopTest.handlers.filter(h=>h.table==='ql_signed_devices').forEach(h=>h.cb({eventType:'UPDATE',new:{device_id:'x'}})),20);
   return {data:{signed_in:true,any:true,limit:1,count:1,newest:null},error:null}}
  return rpc(name,args)};
 return c};
'''
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1024, 'height': 768}, service_workers='block')
    context.add_init_script(SESSION + BASE + LIVE)
    def route(r):
        url = r.request.url
        if url.startswith('http://127.0.0.1:8796/'):
            sub = url.split('8796/', 1)[1].split('?', 1)[0]
            if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
            elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
            else: r.fulfill(status=404, body='')
        elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
        else: r.abort()
    context.route('**/*', route)
    page = context.new_page()
    page.goto('http://127.0.0.1:8796/')
    page.wait_for_function('loopTest.checks>0 && loopTest.handlers.some(h=>h.table==="ql_signed_devices")', timeout=15000)
    start = page.evaluate('loopTest.checks')
    page.wait_for_timeout(8000)
    made = page.evaluate('loopTest.checks') - start
    print('device checks in 8 s:', made, flush=True)
    assert made <= 2, f'{made} device checks in 8 seconds: the tab is checking in a loop'
    ok('A "last seen" live update does not start another device check')
    # A device that is added or removed still triggers a check (at most one at a time).
    before = page.evaluate('loopTest.checks')
    page.evaluate('loopTest.handlers.filter(h=>h.table==="ql_signed_devices").forEach(h=>{h.cb({eventType:"DELETE",old:{}});h.cb({eventType:"INSERT",new:{}})})')
    page.wait_for_timeout(6500)
    after = page.evaluate('loopTest.checks') - before
    assert 1 <= after <= 2, after
    ok('A device added or removed still starts one check')
    browser.close()
print(f'{len(checks)} checks passed')
