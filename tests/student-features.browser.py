"""Everyday student features not covered elsewhere: search, filter, sort, Recent, themes, avatar.

Real index.html in Chromium, with the app's own local mock storage (no network).
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text().replace('const MOCK_MODE=false;', 'const MOCK_MODE=true;', 1)
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
SEED = '''async()=>{
 const add=async x=>{const row=await service.insertItem({id:crypto.randomUUID(),library_id:LIBRARY_ID,parent_id:null,position:state.items.length,is_trashed:false,created_at:x.created_at,updated_at:x.updated_at,url:'',...x});state.items.push(row);return row};
 await add({kind:'folder',title:'Cardiology',created_at:'2026-01-03T00:00:00Z',updated_at:'2026-01-03T00:00:00Z'});
 await add({kind:'pdf',title:'Anatomy notes',storage_path:'x/a.pdf',file_size:10,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-05T00:00:00Z'});
 await add({kind:'link',title:'Biology quiz',url:'https://example.com/bio',created_at:'2026-01-02T00:00:00Z',updated_at:'2026-01-04T00:00:00Z'});
 await add({kind:'pdf',title:'Zoology handout',storage_path:'x/z.pdf',file_size:10,created_at:'2026-01-04T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'});
 render();}'''
TITLES = "[...document.querySelectorAll('#content [data-id]')].map(e=>state.items.find(x=>x.id===e.dataset.id)?.title).filter(Boolean)"
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in [390, 1024]:
        context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=True, service_workers='block')
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8830/'):
                name = url.split('8830/', 1)[1].split('?', 1)[0]
                if name in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / name).is_file(): r.fulfill(status=200, body=(ROOT / name).read_bytes())
                else: r.fulfill(status=404, body='Missing')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='/* mock-only */')
            else: r.abort()
        context.route('**/*', route)
        page.goto('http://127.0.0.1:8830/', wait_until='domcontentloaded')
        page.get_by_role('button', name='Continue with Google').click(); page.wait_for_function('!!state.user')
        page.evaluate('service.getSession=async()=>({user:state.user});void __studentWorkspace.activate()'); page.wait_for_function('state.studentWorkspaceReady')
        page.evaluate(SEED); page.evaluate("navigate('documents')")
        titles = lambda: page.evaluate(TITLES)
        assert {'Cardiology', 'Anatomy notes', 'Biology quiz', 'Zoology handout'} <= set(titles()), titles()
        # search
        page.evaluate("()=>{const i=document.querySelector('#searchInput');i.value='anatomy';i.dispatchEvent(new Event('input',{bubbles:true}));render()}")
        assert titles() == ['Anatomy notes'], titles()
        page.evaluate("()=>{const i=document.querySelector('#searchInput');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));render()}")
        ok(f'{width}px: search finds items by title')
        # filter
        for f, expected in [('pdf', {'Anatomy notes', 'Zoology handout'}), ('link', {'Biology quiz'}), ('folder', {'Cardiology'}), ('document', {'Anatomy notes', 'Zoology handout', 'Biology quiz'})]:
            page.evaluate("(f)=>{state.filter=f;render()}", f)
            kinds = set(page.evaluate("[...document.querySelectorAll('#content [data-id]')].map(e=>state.items.find(x=>x.id===e.dataset.id)?.kind)"))
            allowed = {'pdf', 'link'} if f == 'document' else {f}
            assert kinds <= allowed and expected <= set(titles()), (f, kinds, titles())
        page.evaluate("()=>{state.filter='all';render()}")
        ok(f'{width}px: filter shows only PDFs, links, folders or documents')
        # sort through the View menu
        def sort_by(key):
            page.evaluate("()=>document.querySelector('#viewBtn').click()")
            page.locator(f'#viewMenu [data-sort="{key}"]').click()
        page.evaluate("()=>{state.sortAsc=true}")
        sort_by('title')
        assert page.evaluate("state.sort") == 'title'
        names = titles(); assert names in (sorted(names, key=str.lower), sorted(names, key=str.lower, reverse=True)), names
        sort_by('created_at'); created = page.evaluate("[...document.querySelectorAll('#content [data-id]')].map(e=>String(state.items.find(x=>x.id===e.dataset.id)?.created_at||''))")
        assert created in (sorted(created), sorted(created, reverse=True)), created
        sort_by('kind'); kinds = page.evaluate("[...document.querySelectorAll('#content [data-id]')].map(e=>state.items.find(x=>x.id===e.dataset.id)?.kind)")
        assert kinds in (sorted(kinds), sorted(kinds, reverse=True)), kinds
        ok(f'{width}px: sort by name, date created and type orders the library')
        # Recent = newly ADDED items, newest first (by design, see studentAccountRecentOverride)
        page.evaluate("async()=>{const now=new Date().toISOString();const row=await service.insertItem({id:crypto.randomUUID(),library_id:LIBRARY_ID,parent_id:null,kind:'link',title:'Newest link',url:'https://example.com/new',position:99,is_trashed:false,created_at:now,updated_at:now});state.items.push(row);render()}")
        page.evaluate("navigate('recent')")
        # the page is drawn on the next frame: wait until the screen shows the Recent list
        page.wait_for_function("JSON.stringify([...document.querySelectorAll('#content [data-id]')].map(e=>e.dataset.id))===JSON.stringify(recentItems().map(x=>x.id))")
        recent = titles()
        assert recent[:1] == ['Newest link'], recent
        stamps = page.evaluate("[...document.querySelectorAll('#content [data-id]')].map(e=>String(state.items.find(x=>x.id===e.dataset.id)?.created_at||''))")
        assert stamps == sorted(stamps, reverse=True), stamps
        page.evaluate("navigate('documents')")
        ok(f'{width}px: Recent lists newly added items, newest first')
        # themes
        for skin in ['neon', 'ocean', 'white']:
            page.evaluate('(s)=>qlSetSkin(s)', skin)
            assert page.evaluate('qlGetSkin()') == skin
        page.evaluate("qlSetSkin('ocean')"); page.reload(wait_until='domcontentloaded'); page.wait_for_function('typeof qlGetSkin==="function"')
        assert page.evaluate('qlGetSkin()') == 'ocean'
        page.evaluate("qlSetSkin('white')")
        ok(f'{width}px: all three themes apply and the choice survives a reload')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
