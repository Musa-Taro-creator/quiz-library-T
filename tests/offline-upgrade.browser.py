"""Real Chromium service-worker upgrades/restarts with a local-only HTTP server.
Only CDN transport URLs are replaced with local no-op dependency fixtures.
The new app, service worker, PDF modules/worker/fonts/decoders are actual repository files.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from threading import Thread
import json,mimetypes
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
mode={'version':'old','failure':''}
old_html='<html><body>Legacy application fixture</body></html>'
old_sw='''self.addEventListener('install',e=>e.waitUntil(caches.open('ql-app-v1').then(c=>c.addAll(['./','index.html'])).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match('index.html')))});'''
cdn={'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2':'deps/supabase.js','https://cdn.jsdelivr.net/npm/tus-js-client@4/dist/tus.min.js':'deps/tus.js','https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js':'deps/pdf-lib.js'}
def app():
 s=(root/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
 for a,b in cdn.items():s=s.replace(a,b)
 return s
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  name=self.path.split('?',1)[0].lstrip('/')
  if name in ('','index.html'):body=(old_html if mode['version']=='old' else app()).encode();typ='text/html'
  elif name=='sw.js':
   body=(old_sw if mode['version']=='old' else (root/'sw.js').read_text()).encode()
   for a,b in cdn.items():body=body.replace(a.encode(),b.encode())
   typ='application/javascript'
  elif name.startswith('deps/'):body=b'/* local mock transport */';typ='application/javascript'
  elif (root/name).is_file():body=(root/name).read_bytes();typ='application/javascript' if name.endswith('.mjs') else mimetypes.guess_type(name)[0] or 'application/octet-stream'
  else:self.send_error(404);return
  if mode['version']=='new' and name.endswith('pdf.worker.min.mjs') and mode['failure']:
   if mode['failure']=='503':self.send_error(503);return
   self.send_response(200);self.send_header('Content-Length',str(len(body)));self.send_header('Content-Type',typ);self.end_headers();self.wfile.write(body[:128]);self.wfile.flush();self.close_connection=True;return
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=Thread(target=server.serve_forever,daemon=True);thread.start()
url='http://127.0.0.1:'+str(server.server_port)+'/'
def wait_async(page,expression):
 for _ in range(200):
  if page.evaluate(expression):return
  page.wait_for_timeout(100)
 raise AssertionError('Timed out waiting for service-worker lifecycle: '+expression)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for failure in ['', '503','disconnect']:
   mode.update(version='old',failure='');context=browser.new_context(service_workers='allow');context.route('https://**/*',lambda r:r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url);page.evaluate("async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready}")
   page.wait_for_function('navigator.serviceWorker.controller')
   pdf=list((root/'tests/fixtures/sample.pdf').read_bytes())
   page.evaluate('''async bytes=>{localStorage.setItem('protected-account-draft','keep');const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('protected-quiz-data',1);r.onupgradeneeded=()=>r.result.createObjectStore('saved');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});await new Promise(resolve=>{const tx=db.transaction('saved','readwrite');tx.objectStore('saved').put('saved quiz','quiz');tx.oncomplete=resolve});const pdf=await caches.open('ql-off-pdf-fixture-user');await pdf.put('https://ql-offline.invalid/fixture.pdf',new Response(new Uint8Array(bytes)));const app=await caches.open('ql-app-v1');await app.put('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',new Response('old fixture only'));}''',pdf)
   mode.update(version='new',failure=failure)
   page.evaluate("async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update()}")
   if failure:
    wait_async(page,"async()=>{const r=await navigator.serviceWorker.getRegistration();return !r.installing}")
    assert page.evaluate("async()=>await caches.has('ql-app-v1')")
    context.set_offline(True);page.close();page=context.new_page();page.goto(url+'index.html');assert 'Legacy application fixture' in page.locator('body').inner_text()
    context.set_offline(False);mode['failure']='';page.evaluate("async()=>await(await navigator.serviceWorker.getRegistration()).update()")
   wait_async(page,"async()=>!await caches.has('ql-app-v1')&&await caches.has('ql-app-reliability-2026-10-19-v2')")
   wait_async(page,"async()=>{const r=await navigator.serviceWorker.getRegistration();return r.active&&r.active.state==='activated'&&!r.installing}")
   assert page.evaluate("localStorage.getItem('protected-account-draft')")=='keep'
   assert page.evaluate("async()=>!!await(await caches.open('ql-off-pdf-fixture-user')).match('https://ql-offline.invalid/fixture.pdf')")
   context.set_offline(True);page.close();page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(url+'index.html',wait_until='domcontentloaded')
   page.wait_for_timeout(1000)
   page.wait_for_function('window.qlLoadPdfJs&&window.qlOfflineViewPdf',timeout=5000)
   assert page.evaluate('async()=>(await qlLoadPdfJs()).version')=='6.4.299'
   page.evaluate('''async bytes=>{state.user={id:'fixture-user'};const cache=await caches.open('ql-off-pdf-fixture-user');await cache.put(`https://ql-offline.invalid/${LIBRARY_ID}/fixture-pdf.pdf`,new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf'}}));await qlOfflineViewPdf({id:'fixture-pdf',title:'Cold offline PDF'})}''',pdf)
   page.wait_for_function('document.querySelectorAll("#qlOffPdf canvas").length>0')
   assert page.locator('#qlOffPdf .pg > *').count()==3
   # Cold auxiliary-data reads use the cached bundle, with the browser entirely offline.
   assert page.evaluate("async()=>{const r=await fetch('vendor/pdfjs-6.4.299/cmaps/78-EUC-H.bcmap');return r.ok&&(await r.arrayBuffer()).byteLength>100}")
   assert page.evaluate("async()=>new Promise((resolve,reject)=>{const r=indexedDB.open('protected-quiz-data',1);r.onsuccess=()=>{const q=r.result.transaction('saved').objectStore('saved').get('quiz');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)}})")=='saved quiz'
   assert not errors,errors
   print(('Successful upgrade' if not failure else 'Failed '+failure+' update + successful retry')+': cold offline app/PDF/module/worker/CMap and saved data preserved',flush=True)
   context.close()
  browser.close()
finally:server.shutdown();server.server_close()
