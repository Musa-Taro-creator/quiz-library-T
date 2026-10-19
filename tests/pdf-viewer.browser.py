from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
source=(root/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=b.new_context(viewport={'width':1280,'height':900},service_workers='block')
 page=context.new_page();errors=[];network=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  u=r.request.url
  if u.startswith('http://127.0.0.1:8765/'):
   sub=u.split('8765/',1)[1].split('?',1)[0]
   if sub in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=source)
   elif (root/sub).is_file():r.fulfill(status=200,content_type='application/javascript' if sub.endswith('.mjs') else 'application/octet-stream',body=(root/sub).read_bytes())
   else:r.fulfill(status=404,body='not found')
  else:
   network.append(u)
   if r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* External library omitted in local mock exploration. */')
   else:r.abort()
 context.route('**/*',route)
 page.goto('http://127.0.0.1:8765/',wait_until='domcontentloaded')
 page.wait_for_timeout(1500)

 import base64
 page.get_by_role('button',name='Continue with Google').click();page.wait_for_timeout(200)
 pdf=base64.b64encode((root/'tests/fixtures/sample.pdf').read_bytes()).decode()
 page.evaluate("""async data=>{window.auditPdfBytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const cache=await caches.open('ql-off-pdf-'+state.user.id);await cache.put(`https://ql-offline.invalid/${LIBRARY_ID}/audit-pdf.pdf`,new Response(auditPdfBytes,{headers:{'Content-Type':'application/pdf'}}));await qlOfflineViewPdf({id:'audit-pdf',title:'Audit PDF'})}""",pdf)
 page.wait_for_function('document.querySelectorAll("#qlOffPdf canvas").length>0')
 initial=page.locator('#qlOffPdf canvas').first.get_attribute('width')
 assert page.locator('#qlOffPdf .pg > *').count()==3
 page.locator('#qlOffPdf .pg > *').last.scroll_into_view_if_needed();page.wait_for_timeout(400)
 page.locator('#qlOffPdf [data-a="in"]').click();page.wait_for_timeout(300)
 page.locator('#qlOffPdf .pg > *').first.scroll_into_view_if_needed();page.wait_for_timeout(400)
 after=page.locator('#qlOffPdf canvas').first.get_attribute('width')
 assert int(after)>int(initial)
 extracted=page.evaluate("""async()=>{const doc=await pdfjsLib.getDocument({data:auditPdfBytes.slice(),isEvalSupported:false}).promise;const text=(await (await doc.getPage(2)).getTextContent()).items.map(x=>x.str).join(' ');const pages=doc.numPages;await doc.loadingTask.destroy();return {text,pages,version:pdfjsLib.version}}""")
 assert extracted['pages']==3 and 'page 2' in extracted['text']
 page.locator('#qlOffPdf [data-a="close"]').click();assert page.locator('#qlOffPdf').count()==0
 # Delay/failure/cancellation and rapid-zoom lifecycle checks use the real viewer.
 page.evaluate("()=>{window.realPdfLoader=window.qlLoadPdfJs;window.unhandled=[];addEventListener('unhandledrejection',e=>unhandled.push(String(e.reason)));window.qlLoadPdfJs=()=>new Promise(resolve=>window.releasePdf=()=>resolve(pdfjsLib));void qlOfflineViewPdf({id:'audit-pdf',title:'Delayed PDF'})}")
 page.locator('#qlOffPdf').wait_for();assert page.locator('#qlOffPdf canvas').count()==0
 page.evaluate('releasePdf()');page.wait_for_function('document.querySelectorAll("#qlOffPdf canvas").length>0')
 for _ in range(5):page.locator('#qlOffPdf [data-a="in"]').click()
 page.locator('#qlOffPdf [data-a="close"]').click();page.wait_for_timeout(150)
 page.evaluate("()=>{void qlOfflineViewPdf({id:'audit-pdf',title:'Close while loading'})}")
 page.locator('#qlOffPdf').wait_for();page.locator('#qlOffPdf [data-a="close"]').click();page.evaluate('releasePdf()');page.wait_for_timeout(150)
 assert page.locator('#qlOffPdf').count()==0
 page.evaluate("()=>{window.qlLoadPdfJs=()=>Promise.reject(Error('Injected module failure'));void qlOfflineViewPdf({id:'audit-pdf',title:'Browser fallback'})}")
 page.locator('#qlOffPdf iframe').wait_for();assert page.locator('#qlOffPdf a').inner_text()=='Open PDF with your browser'
 blob_url=page.locator('#qlOffPdf a').get_attribute('href');assert blob_url.startswith('blob:')
 page.locator('#qlOffPdf [data-a="close"]').click();assert page.locator('#qlOffPdf').count()==0
 assert page.evaluate('unhandled')==[]
 print('Loader delay, cancellation, rapid zoom, failure fallback and cleanup passed')
 result={'passed':['Cached PDF opens in full app','3 page placeholders created','Scrolling to later page renders it','Zoom increases canvas resolution','Exact library can extract text','Close removes viewer'],'initialCanvasWidth':initial,'zoomedCanvasWidth':after,**extracted,'errors':errors}
 print('PDF_CHECK',json.dumps(result),flush=True)
 assert extracted['version']=='6.4.299'
 assert not errors,errors
 b.close()
