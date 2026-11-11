"""Background scroll lock: while a window or full-screen layer is open, the page behind it does
not scroll (Kuza on iPad: "Choose your plan" let the page behind scroll). Checks the wheel, a
touch swipe on the dark backdrop, a swipe inside the window's own scrolling list, closing, and
the Make Google Form / plan windows. Real index.html in Chromium with a simulated Supabase."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
t = (ROOT / 'tests/plan-card-sync.browser.py').read_text()
ns = {}
exec(t[t.index('SOURCE ='):t.index('checks = []')], {'ROOT': ROOT, 're': re, 'Path': Path}, ns)
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
SWIPE = '''([sel,dy])=>{const el=document.querySelector(sel),r=el.getBoundingClientRect(),x=r.left+Math.min(20,r.width/2),y=r.top+Math.min(40,r.height/2);
 const mk=(type,yy)=>{const tt=new Touch({identifier:1,target:el,clientX:x,clientY:yy});return new TouchEvent(type,{touches:type==='touchend'?[]:[tt],targetTouches:type==='touchend'?[]:[tt],changedTouches:[tt],bubbles:true,cancelable:true})};
 el.dispatchEvent(mk('touchstart',y));const mv=mk('touchmove',y-dy);el.dispatchEvent(mv);el.dispatchEvent(mk('touchend',y-dy));return mv.defaultPrevented}'''
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width, height in ((1024, 768), (390, 844)):
        context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True, service_workers='block')
        context.add_init_script(ns['SESSION'] + ns['BASE'] + ns['SERVER'])
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8836/'):
                sub = url.split('8836/', 1)[1].split('?', 1)[0]
                if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=ns['SOURCE'])
                elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
                else: r.fulfill(status=404, body='')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
            else: r.abort()
        context.route('**/*', route)
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:8836/')
        page.wait_for_function('!!state.user && !!window.qlPublicCfg && !!window.qlOpenUpgrade'); page.wait_for_timeout(300)
        tag = f'[{width}px] '
        # a long page, scrolled a little
        page.evaluate("()=>{const d=document.createElement('div');d.id='tallTest';d.style.height='4000px';document.querySelector('.main').append(d);scrollTo(0,300)}")
        page.wait_for_function('scrollY===300')
        assert not page.evaluate("document.documentElement.classList.contains('ql-scroll-locked')")
        page.evaluate('qlOpenUpgrade()'); page.wait_for_selector('.modal .qu-p')
        page.wait_for_function("document.documentElement.classList.contains('ql-scroll-locked')")
        page.mouse.move(5, height - 5); page.mouse.wheel(0, 900); page.wait_for_timeout(250)
        assert page.evaluate('scrollY') == 300, page.evaluate('scrollY')
        assert page.evaluate(SWIPE, ['#modalOverlay', 200]) is True, 'a swipe on the dark backdrop is stopped'
        assert page.evaluate('scrollY') == 300
        ok(tag + 'Choose your plan open: the wheel and a swipe on the backdrop do not move the page behind')
        # the window's own list still scrolls with a swipe
        page.evaluate("()=>{const b=document.getElementById('modalBody');b.style.maxHeight='200px';b.style.overflow='auto';b.scrollTop=0}")
        assert page.evaluate(SWIPE, ['#modalBody .qu-p', 120]) is False, 'a swipe inside the window can scroll it'
        ok(tag + 'A swipe inside the window\'s own scrolling list is not stopped')
        page.evaluate('closeModal()'); page.wait_for_function("!document.documentElement.classList.contains('ql-scroll-locked')")
        assert page.evaluate('scrollY') == 300, 'the page stays where it was'
        assert page.evaluate(SWIPE, ['#tallTest', 200]) is False, 'with no window open, swipes are normal'
        page.mouse.move(width // 2, height // 2); page.mouse.wheel(0, 400); page.wait_for_function('scrollY>300')
        ok(tag + 'Closing the window unlocks the page, which is still where it was and scrolls again')
        # any other window (openModal) and the side menu shade lock it too
        page.evaluate("openModal('Test','<p>Hello</p>')"); page.wait_for_function("document.documentElement.classList.contains('ql-scroll-locked')")
        page.evaluate('closeModal()'); page.wait_for_function("!document.documentElement.classList.contains('ql-scroll-locked')")
        ok(tag + 'Every window opened with openModal locks and unlocks the page the same way')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} scroll-lock checks passed; no production requests.')
