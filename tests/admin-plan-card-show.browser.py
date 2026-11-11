"""Admin → Plans → Edit plan: every limit row has "👁 Shown / Hidden" (Show on student card).
Storage is Hidden by default, the other rows Shown; the choice is saved with the plan
(features._card), a saved choice comes back when the plan is opened again, and the limit
value itself is saved either way.

Uses the simulated admin backend from admin-message-drafts.browser.py; no real accounts.
"""
from pathlib import Path
import ast, sys
from playwright.sync_api import sync_playwright
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
ROOT = Path(__file__).resolve().parents[1]
tree = ast.parse((ROOT / 'tests/admin-message-drafts.browser.py').read_text())
STUB = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'stub' for t in n.targets))
EXTRA = r'''
window.pc={saves:[]};
const baseCreate=window.supabase.createClient;
window.supabase.createClient=(...a)=>{const c=baseCreate(...a),rpc0=c.rpc;
 c.rpc=async(name,args)=>{
  if(name==='ql_admin_plans')return {data:[
     {id:'free',name:'Free',color:'#94a3b8',limits:{storage_mb:100,results_kept:3,devices:1,folders:3},features:{new_folder:true},is_default:true,visibility:'public',sort:1},
     {id:'pro',name:'Pro',color:'#6366f1',price_month:4,limits:{storage_mb:2048,results_kept:null,devices:2,gform_per_day:5},features:{gform:true,_card:{storage_mb:true,devices:false,gform_per_day:false}},visibility:'public',sort:2}],error:null};
  if(name==='ql_admin_save_plan'){pc.saves.push(args.p);return {data:args.p,error:null}}
  return rpc0(name,args)};
 return c};
'''
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in (1280, 768, 390):
        context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=True, service_workers='block')
        context.add_init_script(STUB + EXTRA)
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        def route(r):
            u = r.request.url
            if u.startswith('http://127.0.0.1:8836/'):
                name = u.split('8836/', 1)[1].split('?', 1)[0]
                if name == 'admin.html': r.fulfill(status=200, content_type='text/html', body=(ROOT / name).read_bytes())
                elif (ROOT / name).is_file(): r.fulfill(status=200, body=(ROOT / name).read_bytes())
                else: r.fulfill(status=404, body='Missing')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='/* simulated */')
            else: r.abort()
        context.route('**/*', route)
        page.goto('http://127.0.0.1:8836/admin.html#plans')
        tag = f'[{width}px] '
        state = lambda: page.evaluate("Object.fromEntries([...document.querySelectorAll('[data-show]')].map(b=>[b.dataset.show,b.classList.contains('on')]))")

        # 1. a plan with no saved choice: Storage Hidden, every other row Shown (also rows under a feature tick)
        page.locator('[data-edit="free"]').click(); page.locator('[data-show="storage_mb"]').wait_for()
        st = state()
        assert st['storage_mb'] is False, st
        assert all(v for k, v in st.items() if k != 'storage_mb'), st
        for k in ('results_kept', 'devices', 'folders', 'quizzes', 'questions_per_quiz', 'links', 'pdfs', 'gform_questions', 'gform_per_day'):
            assert k in st, (k, st)
        assert page.locator('[data-show="storage_mb"]').inner_text() == 'Hidden' and page.locator('[data-show="devices"]').inner_text() == '👁 Shown'
        assert 'still applies' in page.locator('.ovl .dlg').last.inner_text()
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        fit = page.evaluate("(()=>{const d=[...document.querySelectorAll('.ovl .dlg')].at(-1).getBoundingClientRect();return [...document.querySelectorAll('.ovl .dlg .lim')].filter(e=>e.offsetParent).every(e=>{const r=e.getBoundingClientRect();return r.right<=d.right+1&&r.left>=d.left-1})})()")
        assert fit, 'every limit row (with its eye) fits inside the window'
        if SHOTS: page.locator('[data-show="storage_mb"]').scroll_into_view_if_needed(); page.screenshot(path=f'{SHOTS}/adm-card-show-{width}.png')
        ok(tag + 'Edit plan Free (no saved choice): Storage Hidden, Results kept / Devices / rows under features Shown')

        # 2. toggle and save: the choice goes with the plan, the limits are saved either way
        page.locator('[data-show="storage_mb"]').click(); page.locator('[data-show="devices"]').click()
        assert page.locator('[data-show="storage_mb"]').get_attribute('aria-pressed') == 'true'
        page.locator('#pSave').click(); page.wait_for_function('pc.saves.length===1')
        sv = page.evaluate('pc.saves.at(-1)')
        assert sv['features']['_card']['storage_mb'] is True and sv['features']['_card']['devices'] is False and sv['features']['_card']['results_kept'] is True, sv['features']
        assert sv['limits']['storage_mb'] == 100 and sv['limits']['devices'] == 1, sv['limits']
        assert sv['features']['new_folder'] is True
        ok(tag + 'Toggling Storage on / Devices off saves features._card with the plan; the limits themselves are still saved')

        # 3. a saved choice comes back when the plan is opened again
        page.locator('[data-edit="pro"]').click(); page.locator('[data-show="storage_mb"]').wait_for()
        st = state()
        assert st['storage_mb'] is True and st['devices'] is False and st['gform_per_day'] is False and st['results_kept'] is True, st
        page.locator('#pSave').click(); page.wait_for_function('pc.saves.length===2')
        assert page.evaluate('pc.saves.at(-1).features._card.gform_per_day') is False
        assert page.evaluate('pc.saves.at(-1).limits.gform_per_day') == 5
        ok(tag + "Edit plan Pro: the saved Shown/Hidden choices come back (incl. Google Forms per day) and save again unchanged")
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
