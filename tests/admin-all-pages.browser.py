"""Every Admin page opens, shows its content, and causes no browser errors.

Uses the simulated admin backend from admin-message-drafts.browser.py; no real accounts.
"""
from pathlib import Path
import ast
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
tree = ast.parse((ROOT / 'tests/admin-message-drafts.browser.py').read_text())
STUB = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'stub' for t in n.targets))
PAGES = ['dash', 'users', 'plans', 'pay', 'ctl', 'news', 'settings', 'board', 'msgs', 'rooms']
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in [390, 1280]:
        context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=True, service_workers='block')
        context.add_init_script(STUB)
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        def route(r):
            u = r.request.url
            if u.startswith('http://127.0.0.1:8832/'):
                name = u.split('8832/', 1)[1].split('?', 1)[0]
                if name == 'admin.html': r.fulfill(status=200, content_type='text/html', body=(ROOT / name).read_bytes())
                elif (ROOT / name).is_file(): r.fulfill(status=200, body=(ROOT / name).read_bytes())
                else: r.fulfill(status=404, body='Missing')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='/* simulated admin transport */')
            else: r.abort()
        context.route('**/*', route)
        page.goto('http://127.0.0.1:8832/admin.html'); page.locator('#view h1', has_text='Dashboard').wait_for()
        for v in PAGES:
            nav = page.locator(f'.nav[data-v="{v}"]').first
            if nav.is_visible(): nav.click()
            else: page.evaluate('(v)=>go(v)', v)
            page.wait_for_function("()=>!document.querySelector('#view .loading') && document.querySelector('#view').innerText.trim().length>10", timeout=10000)
            text = page.locator('#view').inner_text()
            assert 'Something went wrong' not in text and 'is not defined' not in text, (v, text[:200])
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), f'{v} overflows sideways at {width}px'
            assert page.evaluate('(v)=>location.hash.slice(1)', v) == v
        assert not errors, errors
        ok(f'{width}px: all {len(PAGES)} Admin pages open with content, no sideways overflow and no errors')
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
