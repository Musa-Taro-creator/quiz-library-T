"""Plans page sync: the student "Choose your plan" cards show exactly what Admin → Plans →
Edit plan saved (name, short line, colour, badge, price, Limits, ticked features, Others),
"Who can get it" decides which cards show, and an admin save re-draws the open window
without a reload.

Real index.html in Chromium with a simulated Supabase. No network.
"""
from pathlib import Path
import re, sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
BASE = re.search(r"STUB = r'''(.*?)'''", (ROOT / 'tests/password-recovery.browser.py').read_text(), re.S).group(1)
SESSION = """sessionStorage.setItem('local-recovery-session',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',
 email:'audit@example.test',app_metadata:{provider:'email'},user_metadata:{full_name:'Local test'}},expires_at:Math.floor(Date.now()/1000)+3600}));"""
SERVER = r'''
window.srv={calls:0,plans:[
 {id:'free',name:'Free',tagline:'Start here',is_default:true,visibility:'public',sort:10,color:'#94a3b8',badge:'',price_month:0,price_year:null,price_lifetime:null,
  limits:{storage_mb:100,results_kept:3,devices:1,quizzes:3,questions_per_quiz:100,links:3,folders:3,pdfs:null},
  features:{new_folder:true,new_link:true,new_quiz:true,_others:['Community help']}},
 {id:'pro',name:'Pro',tagline:'For one school year',is_default:false,visibility:'public',sort:20,color:'#6366f1',badge:'MOST POPULAR',price_month:5,price_year:null,price_lifetime:null,
  limits:{storage_mb:2048,results_kept:null,devices:2,quizzes:null,questions_per_quiz:null},features:{new_quiz:true,nav_rooms:true}},
 {id:'max',name:'Max',tagline:'Everything',is_default:false,visibility:'code',sort:30,color:'#a855f7',badge:'BEST VALUE',price_month:1000,price_year:null,price_lifetime:null,
  limits:{storage_mb:null},features:{_sale:{pct:33}}}]};
const answers={
 ql_public_config:()=>{srv.calls++;return {plans:JSON.parse(JSON.stringify(srv.plans.filter(p=>p.visibility!=='hidden'))),settings:{features:{},site:{open:true}},payment:{},server_time:new Date().toISOString()}},
 ql_my_plan:()=>({plan:srv.plans[0],subscription:null,usage:{quizzes:0,pdfs:0,links:0,folders:0,storage_bytes:0}}),
 ql_support_mine:()=>[],ql_support_unread:()=>0,ql_my_gifts:()=>[],ql_my_greeting:()=>null,ql_my_payments:()=>[],
 ql_received_item_share_count:()=>0,ql_received_quiz_share_count:()=>0,ql_ensure_share_profile:()=>({share_id:'QL-MINE0001',display_name:'Local test'})
};
const realFactory=window.supabase.createClient;
window.supabase.createClient=(...a)=>{const c=realFactory(...a),rpc=c.rpc;
 c.rpc=async(name,args)=>{if(name in answers)return {data:answers[name](args||{}),error:null};return rpc(name,args)};
 return c};
'''
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width, height in ((1024, 768), (390, 844)):
        context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
        context.add_init_script(SESSION + BASE + SERVER)
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8835/'):
                sub = url.split('8835/', 1)[1].split('?', 1)[0]
                if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
                else: r.fulfill(status=404, body='')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
            else: r.abort()
        context.route('**/*', route)
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:8835/')
        page.wait_for_function('!!state.user && !!window.qlPublicCfg && !!window.qlOpenUpgrade')
        page.wait_for_timeout(300)
        tag = f'[{width}px] '
        cards = lambda: page.evaluate("""[...document.querySelectorAll('.modal .qu-p')].map(c=>({id:c.dataset.qusel,name:c.querySelector('h4').textContent,
            tl:c.querySelector('.tl').textContent,bd:c.querySelector('.bd')?.textContent||'',pc:c.style.getPropertyValue('--pc'),
            pr:c.querySelector('.pr').textContent.replace(/\\s+/g,' ').trim(),lines:[...c.querySelectorAll('li')].map(l=>l.textContent)}))""")

        # 1. cards come from the admin plan data; "Only with a code" plan is not shown
        page.evaluate("qlOpenUpgrade()")
        page.wait_for_function("document.querySelectorAll('.modal .qu-p').length===2")
        c = cards()
        assert [x['id'] for x in c] == ['free', 'pro'], c
        free, pro = c
        assert free['name'] == 'Free' and free['tl'] == 'Start here' and free['bd'] == '' and free['pc'] == '#94a3b8' and free['pr'] == '$0', free
        assert free['lines'] == ['Storage: 100 MB', 'Results kept per quiz: 3', 'Devices at the same time: 1',
            'Create Folder · 3 folders', 'Add Quiz Link · 3 quiz links', 'Create Quiz · 3 quizzes · 100 questions each', 'Community help'], free['lines']
        assert pro['bd'] == 'MOST POPULAR' and pro['pc'] == '#6366f1' and pro['pr'].startswith('$5'), pro
        assert pro['lines'] == ['Storage: 2 GB', 'Results kept per quiz: Unlimited', 'Devices at the same time: 2', 'Rooms',
            'Create Quiz · Unlimited quizzes · Unlimited questions each'], pro['lines']
        if SHOTS: page.screenshot(path=f'{SHOTS}/plans-before-{width}.png')
        ok(tag + 'Free / Pro cards: name, short line, colour, badge, price, every Limits row, ticked features and Others; code-only Max hidden')

        # 2. admin saves (Realtime / refresh): the open window re-draws, the promo code typed stays
        page.fill('#quCode', 'abc123')
        page.evaluate("""()=>{const f=srv.plans[0];f.name='Free+';f.tagline='New line';f.color='#10b981';f.badge='NEW';
            f.limits.storage_mb=200;f.limits.results_kept=null;f.features.pf_themes=true;delete f.features.new_link;f.features._others=['One','Two'];
            srv.plans[2].visibility='public';srv.plans[1].visibility='hidden';
            Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});document.dispatchEvent(new Event('visibilitychange'))}""")
        page.wait_for_function("[...document.querySelectorAll('.modal .qu-p h4')].map(e=>e.textContent).join()==='Free+,Max'")
        free, mx = cards()
        assert free['tl'] == 'New line' and free['bd'] == 'NEW' and free['pc'] == '#10b981', free
        assert free['lines'] == ['Storage: 200 MB', 'Results kept per quiz: Unlimited', 'Devices at the same time: 1',
            'Create Folder · 3 folders', 'Create Quiz · 3 quizzes · 100 questions each', 'App themes', 'One', 'Two'], free['lines']
        assert mx['bd'] == 'BEST VALUE' and '$1000' in mx['pr'] and '$670' in mx['pr'], mx
        assert mx['lines'] == ['Storage: Unlimited', 'Results kept per quiz: Unlimited', 'Devices at the same time: 1'], mx['lines']
        assert page.input_value('#quCode') == 'abc123'
        if SHOTS: page.screenshot(path=f'{SHOTS}/plans-after-{width}.png')
        ok(tag + 'Admin save re-draws the open window right away (new name/line/colour/badge/limits/features/Others; Who can get it)')

        # 3. opening the window asks for the newest plans
        page.evaluate("closeModal()"); n = page.evaluate("srv.calls"); page.evaluate("qlOpenUpgrade()")
        page.wait_for_function(f"srv.calls>{n}")
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        ok(tag + 'Opening Choose your plan fetches the newest plans; no sideways scroll')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
