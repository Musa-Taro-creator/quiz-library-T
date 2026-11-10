"""Admin → Settings → Make Google Form: paste the Apps Script URL + secret, Check connection,
switch back to an older Gmail, and the on/off switch in Website Control.

Uses the simulated admin backend from admin-message-drafts.browser.py plus a fake Edge
Function; no real accounts, no Google.
"""
from pathlib import Path
import ast
from playwright.sync_api import sync_playwright
import sys
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
THEME = sys.argv[2] if len(sys.argv) > 2 else None
ROOT = Path(__file__).resolve().parents[1]
tree = ast.parse((ROOT / 'tests/admin-message-drafts.browser.py').read_text())
STUB = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'stub' for t in n.targets))
EXTRA = r'''
window.gf={owners:[],limit:5,saves:[],invokes:[],cap:100,rules:{},ruleSets:[]};
const baseCreate=window.supabase.createClient;
window.supabase.createClient=(...a)=>{const c=baseCreate(...a),rpc0=c.rpc;
 c.rpc=async(name,args)=>{
  if(name==='ql_admin_gform_cap_get')return {data:gf.cap,error:null};
  if(name==='ql_admin_gform_cap_set'){gf.cap=args.p_cap;return {data:gf.cap,error:null}}
  if(name==='ql_admin_gform_user_rules')return {data:{...gf.rules},error:null};
  if(name==='ql_admin_gform_user_rule_get'||name==='ql_admin_gform_user_rule_set'){
    if(name==='ql_admin_gform_user_rule_set'){gf.ruleSets.push(args);if(args.p_mode==='default')delete gf.rules[args.p_user];else gf.rules[args.p_user]={unlimited:args.p_mode==='unlimited',daily_limit:args.p_mode==='custom'?args.p_limit:null}}
    const x=gf.rules[args.p_user];return {data:{mode:!x?'default':x.unlimited?'unlimited':'custom',limit:!x?gf.limit:x.unlimited?null:x.daily_limit,cap:gf.cap,global:gf.limit,used_today:2},error:null}}
  if(name==='ql_admin_gform_get')return {data:{daily_limit:gf.limit,owners:gf.owners.map(o=>({...o})),made_today:2,made_total:9},error:null};
  if(name==='ql_admin_gform_save'){gf.saves.push(args);
    if(args.p_script_url&&!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(args.p_script_url))return {data:null,error:{message:'Paste the Web app URL from Apps Script. It starts with https://script.google.com/macros/s/ and ends with /exec'}};
    if(args.p_daily_limit!=null)gf.limit=args.p_daily_limit;
    if(args.p_script_url){let o=gf.owners.find(x=>x.script_url===args.p_script_url);if(!o){o={script_url:args.p_script_url,owner_email:null,active:false,checked_at:null};gf.owners.push(o)}gf.owners.forEach(x=>x.active=x===o)}
    return {data:{},error:null}}
  return rpc0(name,args)};
 c.functions={invoke:async(name,o)=>{gf.invokes.push(o.body);const a=gf.owners.find(x=>x.active);if(!a)return {data:{ok:false,error:'not set up'},error:null};
   a.owner_email=a.script_url.includes('Two')?'second.forms@gmail.com':'quizlibrary.forms@gmail.com';a.checked_at=new Date().toISOString();return {data:{ok:true,owner:a.owner_email},error:null}}};
 return c};
'''
URL1 = 'https://script.google.com/macros/s/AKfycbOne/exec'
URL2 = 'https://script.google.com/macros/s/AKfycbTwo/exec'
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in (1280, 390):
        context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=True, service_workers='block')
        context.add_init_script(STUB + EXTRA + ("try{localStorage.setItem('ql_admin_theme','%s')}catch(e){}" % THEME if THEME else ''))
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        def route(r):
            u = r.request.url
            if u.startswith('http://127.0.0.1:8835/'):
                name = u.split('8835/', 1)[1].split('?', 1)[0]
                if name == 'admin.html': r.fulfill(status=200, content_type='text/html', body=(ROOT / name).read_bytes())
                elif (ROOT / name).is_file(): r.fulfill(status=200, body=(ROOT / name).read_bytes())
                else: r.fulfill(status=404, body='Missing')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='/* simulated */')
            else: r.abort()
        context.route('**/*', route)
        page.goto('http://127.0.0.1:8835/admin.html#settings')
        page.locator('#gfCard #gfUrl').wait_for()
        tag = f'[{width}px] '
        assert 'No Gmail connected yet' in page.locator('#gfActive').inner_text()
        page.locator('#gfUrl').fill('https://example.com/nope'); page.locator('#gfSecret').fill('s'); page.locator('#gfSave').click()
        page.wait_for_function("document.getElementById('gfMsg').textContent.includes('Web app URL')")
        page.locator('#gfUrl').fill(URL1); page.locator('#gfSecret').fill('secret-one'); page.locator('#gfLimit').fill('4'); page.locator('#gfSave').click()
        page.wait_for_function("document.getElementById('gfMsg').textContent.includes('Saved and connected')")
        assert page.evaluate('gf.saves.at(-1)') == {'p_script_url': URL1, 'p_secret': 'secret-one', 'p_daily_limit': 4}
        assert page.evaluate('gf.invokes.at(-1)') == {'action': 'ping'}
        act = page.locator('#gfActive').inner_text()
        assert 'quizlibrary.forms@gmail.com' in act and 'Made today: 2' in act, act
        assert page.locator('#gfSecret').input_value() == '' and 'leave empty to keep' in page.locator('#gfSecret').get_attribute('placeholder')
        ok(tag + 'Paste URL + secret: wrong URL explained; saved, checked, shows which Gmail makes the forms; secret field stays empty')
        page.locator('#gfUrl').fill(URL2); page.locator('#gfSecret').fill('secret-two'); page.locator('#gfSave').click()
        page.wait_for_function("document.getElementById('gfActive').textContent.includes('second.forms@gmail.com')")
        page.locator(f'[data-gf-use="{URL1}"]').wait_for()
        page.locator(f'[data-gf-use="{URL1}"]').click()
        page.wait_for_function(f"gf.owners.find(o=>o.active).script_url==='{URL1}'")
        page.locator('#gfPing').click()
        page.wait_for_function("document.getElementById('gfMsg').textContent.includes('Connected. Forms are made by quizlibrary.forms@gmail.com')")
        assert page.evaluate('gf.saves.at(-1)')['p_secret'] == '', 'switching back keeps the saved secret'
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        ok(tag + 'Switch to a second Gmail and back ("Use this one"); Check connection names the Gmail')
        # safety cap for Unlimited, saved with Save
        assert page.locator('#gfCap').input_value() == '100'
        page.locator('#gfCap').fill('150'); page.locator('#gfSave').click()
        page.wait_for_function('gf.cap===150')
        ok(tag + 'Settings: safety cap for Unlimited people is shown and saved')
        # Users: per-person Google Forms per day + badge
        page.evaluate("go('users')")
        page.locator('[data-u="student-1"]').wait_for()
        assert page.locator('[data-gfb="student-1"]').inner_text() == ''
        page.locator('[data-u="student-1"]').click()
        page.wait_for_function("document.getElementById('gfNow')?.textContent.includes('4 a day (the default')")
        assert 'made today: 2' in page.locator('#gfNow').inner_text()
        assert page.locator('[data-gfm="default"].on').count() == 1
        page.locator('#gfN').fill('1001'); page.locator('#gfNSave').click()
        page.locator('#gfN').fill('20'); page.locator('#gfNSave').click()
        page.wait_for_function("document.getElementById('gfNow').textContent.includes('20 a day')")
        assert page.evaluate('gf.ruleSets.at(-1)') == {'p_user': 'student-1', 'p_mode': 'custom', 'p_limit': 20}
        assert len(page.evaluate('gf.ruleSets')) == 1, 'the 1001 was refused before saving'
        page.locator('[data-gfm="unlimited"]').click()
        page.wait_for_function("document.getElementById('gfNow').textContent.includes('Unlimited') && document.getElementById('gfNow').textContent.includes('safety cap 150')")
        page.locator('.ovl .dlg-h .x').last.click()
        page.evaluate("go('users')")
        page.wait_for_function("document.querySelector('[data-gfb=\"student-1\"]')?.textContent.includes('∞')")
        page.evaluate("gf.rules['student-1']={unlimited:false,daily_limit:20};go('users')")
        page.wait_for_function("document.querySelector('[data-gfb=\"student-1\"]')?.textContent.includes('20/day')")
        if SHOTS:
            page.locator('table').first.screenshot(path=f'{SHOTS}/adm-users-{width}-{THEME or "white"}.png')
            page.locator('[data-u="student-1"]').click(); page.wait_for_function("document.getElementById('gfNow')?.textContent.includes('20 a day')")
            sec = page.locator('#gfMode'); sec.scroll_into_view_if_needed(); page.wait_for_timeout(200)
            page.screenshot(path=f'{SHOTS}/adm-manage-{width}-{THEME or "white"}.png')
            page.locator('.ovl .dlg-h .x').last.click()
        ok(tag + 'Users: Manage → Google Forms per day (Default / number 0–1000 / Unlimited) and the badge in the list')
        page.evaluate("go('ctl')")
        page.wait_for_function("document.querySelector('#view').innerText.includes('Make Google Form')")
        ok(tag + 'Website Control lists the Make Google Form on/off switch')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
