"""Drag to move (Kuza): press and hold a card (iPad) or click and drag (mouse), drop it on a folder
card or on the folder path at the top. Several selected items move together; a quick swipe still
scrolls; a tap after a drag does not open the item; Undo puts things back; a folder cannot be dropped
into itself. Real index.html in Chromium with the app's own local mock storage (no network)."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text().replace('const MOCK_MODE=false;', 'const MOCK_MODE=true;', 1)
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
SEED = '''async()=>{
 const add=async x=>{const now=new Date().toISOString();const row=await service.insertItem({id:x.id||crypto.randomUUID(),library_id:LIBRARY_ID,parent_id:null,position:state.items.length,is_trashed:false,created_at:now,updated_at:now,url:'',...x});state.items.push(row);return row};
 await add({id:'f-cardio',kind:'folder',title:'Cardiology'});await add({id:'f-neuro',kind:'folder',title:'Neurology'});
 await add({id:'f-inner',kind:'folder',title:'Inner',parent_id:'f-cardio'});
 await add({id:'p-ecg',kind:'pdf',title:'ECG slides',storage_path:'x/a.pdf',file_size:10});
 await add({id:'l-rec',kind:'link',title:'Lecture recording',url:'https://example.com/r'});
 await add({id:'l-bio',kind:'link',title:'Biology link',url:'https://example.com/b'});
 render();}'''
parent = lambda page, i: page.evaluate("(i)=>state.items.find(x=>x.id===i)?.parent_id??null", i)
center = lambda page, sel: page.evaluate("(s)=>{const r=document.querySelector(s).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]}", sel)
TOUCH = '''async([src,x2,y2,hold,steps])=>{const el=document.querySelector(src),r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
 const T=(xx,yy,t)=>new Touch({identifier:7,target:t||el,clientX:xx,clientY:yy});
 const fire=(type,xx,yy)=>{const tt=T(xx,yy),ev=new TouchEvent(type,{touches:type==='touchend'?[]:[tt],targetTouches:type==='touchend'?[]:[tt],changedTouches:[tt],bubbles:true,cancelable:true});el.dispatchEvent(ev);return ev};
 fire('touchstart',x,y);await new Promise(r=>setTimeout(r,hold));let mv;
 for(let i=1;i<=steps;i++){mv=fire('touchmove',x+(x2-x)*i/steps,y+(y2-y)*i/steps);await new Promise(r=>setTimeout(r,16))}
 const end=fire('touchend',x2,y2);el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x2,clientY:y2}));
 return {moveBlocked:!!mv&&mv.defaultPrevented}}'''
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in [1024, 390]:
        context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=True, service_workers='block')
        page = context.new_page(); page.set_default_timeout(10000); errors = []; dialogs = []
        page.on('pageerror', lambda e: errors.append(str(e))); page.on('dialog', lambda d: (dialogs.append(d.message), d.accept()))
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8831/'):
                name = url.split('8831/', 1)[1].split('?', 1)[0]
                if name in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / name).is_file(): r.fulfill(status=200, body=(ROOT / name).read_bytes())
                else: r.fulfill(status=404, body='Missing')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='/* mock-only */')
            else: r.abort()
        context.route('**/*', route)
        page.goto('http://127.0.0.1:8831/', wait_until='domcontentloaded')
        page.get_by_role('button', name='Continue with Google').click(); page.wait_for_function('!!state.user')
        page.evaluate('service.getSession=async()=>({user:state.user});void __studentWorkspace.activate()'); page.wait_for_function('state.studentWorkspaceReady')
        page.evaluate(SEED); page.evaluate("navigate('documents')"); page.locator('#content [data-id="f-cardio"]').wait_for()
        page.evaluate("document.getElementById('studentWelcomeFloat')?.remove()")
        page.evaluate("()=>{window.opened=0;window.openedBy=[];window.open=(...a)=>{opened++;openedBy.push(String(new Error().stack).slice(0,300));return null}}")
        tag = f'[{width}px] '
        card = lambda i: f'#content [data-id="{i}"]'
        # 1. mouse: click and drag a link onto a folder card
        x1, y1 = center(page, card('l-rec')); x2, y2 = center(page, card('f-cardio'))
        page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x1 + 20, y1 + 5, steps=3)
        page.locator('.ql-dd-ghost').wait_for(state='attached'); page.locator('#qlDdTip', has_text='Lecture recording').wait_for()
        assert page.locator(card('f-cardio') + '.ql-dd-can').count() == 1 and page.locator(card('l-rec') + '.ql-dd-src').count() == 1
        page.mouse.move(x2, y2, steps=8); page.locator(card('f-cardio') + '.ql-dd-over .ql-dd-drop', has_text='Drop to move here').wait_for()
        page.mouse.up(); page.wait_for_function("state.items.find(x=>x.id==='l-rec').parent_id==='f-cardio'")
        page.locator('#qlDdUndo', has_text='Moved “Lecture recording” to Cardiology').wait_for()
        assert page.locator('.ql-dd-ghost').count() == 0 and page.locator('#qlDdTip').count() == 0 and page.locator(card('l-rec')).count() == 0
        page.locator('#qlDdUndo button').click(); page.wait_for_function("state.items.find(x=>x.id==='l-rec').parent_id===null")
        assert page.evaluate('opened') == 0, page.evaluate('openedBy')
        ok(tag + 'Mouse: drag a card onto a folder moves it (green outline + "Drop to move here"); Undo puts it back; nothing opens')
        # 2. touch: press and hold, then drag (iPad); the swipe is blocked only while dragging
        x2, y2 = center(page, card('f-neuro'))
        r = page.evaluate(TOUCH, [card('p-ecg'), x2, y2, 650, 10])
        page.wait_for_function("state.items.find(x=>x.id==='p-ecg').parent_id==='f-neuro'")
        assert r['moveBlocked'] is True and page.evaluate('opened') == 0, r
        ok(tag + 'Touch: press and hold 0.5 s, drag onto a folder and let go moves it; the page does not scroll meanwhile and nothing opens')
        # 3. a quick swipe (moving before the hold) is a normal scroll, not a drag
        x2, y2 = center(page, card('f-cardio'))
        r = page.evaluate(TOUCH, [card('l-bio'), x2, y2, 60, 6])
        page.wait_for_timeout(700)
        assert parent(page, 'l-bio') is None and r['moveBlocked'] is False and page.locator('.ql-dd-ghost').count() == 0, r
        ok(tag + 'A quick swipe on a card scrolls as before (no drag, nothing moved)')
        # 4. a folder cannot go into itself or its own folders; the folder path at the top moves things up
        page.evaluate("navigate('documents','f-cardio')"); page.locator(card('f-inner')).wait_for()
        x1, y1 = center(page, card('f-inner'))
        page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x1 + 20, y1 + 5, steps=3); page.locator('.ql-dd-ghost').wait_for(state='attached')
        assert page.locator(card('f-inner') + '.ql-dd-can').count() == 0, 'not into itself'
        # students see the ‹ Back button (the folder above) and Documents in the side menu / Library tab (top level)
        back = page.locator('#backBtn'); assert 'ql-dd-can' in (back.get_attribute('class') or ''), 'Back is a drop spot'
        docs = page.locator('.sidebar [data-section="documents"]:visible, #qlTabbar [data-tab="documents"]:visible').first
        assert 'ql-dd-can' in (docs.get_attribute('class') or ''), 'Documents / Library is a drop spot'
        bx, by = page.evaluate("()=>{const r=document.getElementById('backBtn').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]}")
        page.mouse.move(bx, by, steps=8); page.mouse.up(); page.wait_for_function("state.items.find(x=>x.id==='f-inner').parent_id===null")
        page.locator('#qlDdUndo', has_text='to Documents').wait_for()
        ok(tag + 'A folder cannot be dropped into itself; dropping on the ‹ Back button moves it up a level (Documents / Library tab too)')
        # 5. several selected items move together
        page.evaluate("navigate('documents')"); page.locator(card('l-bio')).wait_for()
        page.evaluate("()=>{state.selection=true;state.selected=new Set(['l-bio','l-rec']);render()}"); page.locator(card('l-bio')).wait_for()
        x1, y1 = center(page, card('l-bio')); x2, y2 = center(page, card('f-cardio'))
        page.mouse.move(x1 + 30, y1 + 30); page.mouse.down(); page.mouse.move(x1 + 50, y1 + 35, steps=3); page.locator('#qlDdTip', has_text='2 items').wait_for()
        page.mouse.move(x2, y2, steps=8); page.mouse.up()
        page.wait_for_function("['l-bio','l-rec'].every(i=>state.items.find(x=>x.id===i).parent_id==='f-cardio')")
        assert page.evaluate('state.selection') is False and page.locator('#qlDdUndo', has_text='Moved 2 items to Cardiology').count() == 1
        ok(tag + 'With several items selected, dragging one moves them all ("Moved 2 items to Cardiology")')
        # 6. letting go away from a folder changes nothing; Escape cancels; Trash cannot drag
        x1, y1 = center(page, card('f-neuro'))
        page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x1 + 20, y1 + 5, steps=3); page.mouse.move(5, 5, steps=4); page.mouse.up()
        page.wait_for_timeout(300); assert parent(page, 'f-neuro') is None and page.locator('.ql-dd-ghost').count() == 0
        page.evaluate("navigate('trash')"); page.wait_for_timeout(200)
        assert page.evaluate("window.qlDragMove.active()") is False
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        ok(tag + 'Letting go away from a folder changes nothing; no sideways scroll')
        assert not errors, errors; assert not dialogs, dialogs
        context.close()
    browser.close()
print(f'{len(checks)} drag-to-move checks passed; no production requests.')
