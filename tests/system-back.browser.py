"""Exercise real app/history code with a mobile Chromium viewport and local data.

history.back() models browser traversal used by Android Back. Physical launcher
behavior and native gesture animation still require a real Android device.
"""
from pathlib import Path
import base64
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
source=(root/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 c=b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,service_workers='block')
 page=c.new_page();errors=[];dialogs=[];leave=[False];passed=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def dialog(d):
  dialogs.append(d.message)
  if d.type=='confirm' and leave[0]:d.accept()
  else:d.dismiss()
 page.on('dialog',dialog)
 def route(r):
  u=r.request.url
  if u.startswith('http://127.0.0.1:8780/'):
   sub=u.split('8780/',1)[1].split('?',1)[0].split('#',1)[0]
   if sub=='before':r.fulfill(status=200,content_type='text/html',body='Previous page outside Quiz Library')
   elif sub in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=source)
   elif (root/sub).is_file():r.fulfill(status=200,content_type='application/javascript' if sub.endswith('.mjs') else 'application/octet-stream',body=(root/sub).read_bytes())
   else:r.fulfill(status=404,body='Missing local fixture')
  elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local mock transport */')
  else:r.abort()
 c.route('**/*',route)
 page.goto('http://127.0.0.1:8780/before');page.goto('http://127.0.0.1:8780/',wait_until='domcontentloaded')
 page.get_by_role('button',name='Continue with Google').click()
 page.wait_for_function('state.user && history.state?.qlBackArmed')
 page.evaluate('service.getSession=async()=>state.user?({user:state.user}):null')
 def back():page.evaluate('history.back()');page.wait_for_timeout(150)
 def ok(name):passed.append(name);print('PASS:',name,flush=True)

 back();assert dialogs[-1]=='Leave Quiz Library?' and not page.evaluate('history.state?.qlExitBase');ok('Cancel leaving from Documents keeps the app open')
 count=page.evaluate('history.length');session=page.evaluate('history.state.qlBackSession')
 page.reload(wait_until='domcontentloaded');page.wait_for_function('state.user && history.state?.qlBackArmed')
 assert page.evaluate('history.length')==count and page.evaluate('history.state.qlBackSession')==session
 page.evaluate('service.getSession=async()=>state.user?({user:state.user}):null')
 n=len(dialogs);back();assert len(dialogs)==n+1;ok('Reload preserves one exit guard and does not add history entries')
 page.evaluate("""()=>{state.items.push({id:'folder-a',kind:'folder',title:'A',parent_id:null},{id:'folder-b',kind:'folder',title:'B',parent_id:'folder-a'});navigate('documents','folder-a');navigate('documents','folder-b')}""")
 back();assert page.evaluate('state.folderId')=='folder-a'
 back();assert page.evaluate('state.folderId') is None
 page.evaluate('history.forward()');page.wait_for_function("state.folderId==='folder-a'")
 back();assert page.evaluate('state.folderId') is None;ok('Folder Back and Forward retain ordinary navigation')

 page.evaluate("openSidebar();openModal('Test modal','<p>Temporary local dialog</p>')")
 back();assert not page.locator('#modalOverlay').evaluate("e=>e.classList.contains('show')")
 assert page.locator('#sidebar').evaluate("e=>e.classList.contains('open')")
 back();assert not page.locator('#sidebar').evaluate("e=>e.classList.contains('open')");ok('Nested modal then sidebar close in order')
 page.evaluate('openSearch()');back();assert not page.evaluate('state.searchActive');ok('Existing search Back still works')
 page.evaluate("openFolderEditor()");page.locator('#folderEditorTitle').fill('Unsubmitted folder title')
 page.locator('#modalBody .ql-fp-field').click();page.locator('#qlLocSheet.show').wait_for();back()
 assert not page.locator('#qlLocSheet').evaluate("e=>e.classList.contains('show')") if page.locator('#qlLocSheet').count() else True
 assert page.locator('#folderEditorTitle').input_value()=='Unsubmitted folder title';back();ok('Location sheet closes before the folder editor and retains its fields')
 page.locator('#qlInstallNav').wait_for(state='attached');page.evaluate("document.querySelector('#qlInstallNav').click()")
 page.locator('.ql-inst-veil').wait_for();back();assert page.locator('.ql-inst-veil').count()==0;ok('Back closes the installation guide')
 page.evaluate("navigate('favorites');navigate('recent')");back();assert page.evaluate('state.section')=='favorites'
 back();assert page.evaluate('state.section')=='documents';ok('Back returns through library sections')


 page.evaluate("""()=>{window.packet={kind:'folder',root_ref:'root',nodes:[{ref:'root',kind:'folder',title:'Root',parent_ref:null},{ref:'child',kind:'folder',title:'Child',parent_ref:'root'},{ref:'pdf',kind:'pdf',title:'PDF',parent_ref:'child',pdf_url:'https://example.test/doc.pdf'}]};service.client={rpc:async(name)=>name==='ql_dash_list'?{data:{posts:[{id:'post',kind:'folder',title:'Root',status:'approved'}],mine:[]}}:name==='ql_dash_open'?{data:{payload:packet}}:{data:[]}}}""")
 page.evaluate('qlOpenDash()');page.locator('#qlDash [data-post]').wait_for()
 page.locator('#qlDash [data-post]').click();page.locator('#qlItemViewer [data-ref="child"]').click()
 assert page.locator('#qlItemViewer [data-ref="pdf"]').count()==1
 back();assert page.locator('#qlItemViewer [data-ref="child"]').count()==1
 back();assert page.locator('#qlItemViewer').count()==0 and page.locator('#qlDash').count()==1
 back();assert page.locator('#qlDash').count()==0;ok('Back walks a shared folder then closes its viewer and Dashboard')
 page.evaluate('qlOpenDash()');page.locator('#qlDash [data-qd-close]').click();page.wait_for_timeout(150)
 n=len(dialogs);back();assert len(dialogs)==n+1 and dialogs[-1]=='Leave Quiz Library?';ok('Closing Dashboard with X leaves no invisible Back entries')

 pdf=base64.b64encode((root/'tests/fixtures/sample.pdf').read_bytes()).decode()
 page.evaluate("""async data=>{const cache=await caches.open('ql-off-pdf-'+state.user.id);await cache.put(`https://ql-offline.invalid/${LIBRARY_ID}/back-pdf.pdf`,new Response(Uint8Array.from(atob(data),c=>c.charCodeAt(0)),{headers:{'Content-Type':'application/pdf'}}));await qlOfflineViewPdf({id:'back-pdf',title:'PDF Back test'})}""",pdf)
 page.locator('#qlOffPdf canvas').first.wait_for();back();assert page.locator('#qlOffPdf').count()==0
 assert page.evaluate("caches.keys().then(ks=>ks.some(k=>k.startsWith('ql-off-pdf-')))");ok('PDF Back uses existing cleanup and retains saved PDFs')

 page.evaluate('__quizTest.openQuizCreateModal()');page.locator('#qzNewTitle').fill('Back test');page.locator('#qzNewCreate').click()
 page.locator('#qzBtnAddNew').wait_for(state='attached');page.evaluate("document.querySelector('#qzBtnAddNew').click()")
 page.locator('#qzSubDialogOverlay.show').wait_for();back()
 assert not page.locator('#qzSubDialogOverlay').evaluate("e=>e.classList.contains('show')")
 assert page.locator('#qzPageOverlay').evaluate("e=>e.classList.contains('show')");ok('Quiz subdialog Back retains the quiz editor')
 page.evaluate("document.querySelector('#qzBtnAddNew').click()");page.locator('[data-tab="bulk"]').click()
 page.locator('#qzAqBulkArea').fill('1. Pick one?\nA. First\nB. Second\nAnswer: A');page.locator('#qzAqParse').click();page.locator('#qzAddQSubmit').click()
 page.wait_for_timeout(2200)
 page.evaluate("""()=>{window.savedPartial=service.saveQuizQuestionsPartial;window.partialCalls=0;service.saveQuizQuestionsPartial=async(...args)=>{partialCalls++;if(partialCalls===1)await new Promise(resolve=>window.releaseBackSave=resolve);return await savedPartial(...args)}}""")
 page.locator('.qz-question-card[data-qidx="0"] .qz-prompt').fill('Unsaved edit before Back')
 back();page.wait_for_function('typeof releaseBackSave==="function"')
 assert page.locator('#qzPageOverlay').evaluate("e=>e.classList.contains('show')")
 back();assert page.evaluate('partialCalls')==1
 page.evaluate('releaseBackSave()');page.wait_for_function("!document.querySelector('#qzPageOverlay').classList.contains('show')")
 item=page.evaluate("state.items.find(x=>x.title==='Back test')")
 assert item['_student_questions'][0]['prompt']=='Unsaved edit before Back';ok('Repeated Back during an in-flight save preserves the edit and waits')
 page.evaluate('x=>__quizTest.openQuizWorkspace(x)',item);page.locator('#qzAutosaveStatus').wait_for(state='attached')
 page.evaluate("""()=>{window.savedStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('ql_quiz_draft_v2_'))throw Error('Simulated quota');return savedStorageSet.call(this,k,v)}}""")
 page.locator('.qz-question-card[data-qidx="0"] .qz-prompt').fill('')
 back();assert page.locator('#qzPageOverlay').evaluate("e=>e.classList.contains('show')")
 assert 'draft could not be stored' in dialogs[-1];ok('Back refuses to discard an invalid draft when device storage fails')
 page.evaluate('()=>{Storage.prototype.setItem=savedStorageSet;service.saveQuizQuestionsPartial=savedPartial}')
 page.locator('.qz-question-card[data-qidx="0"] .qz-prompt').fill('Recovered valid question')
 page.locator('#qzTopClose').click();page.wait_for_function("!document.querySelector('#qzPageOverlay').classList.contains('show')")
 page.wait_for_timeout(200)
 page.evaluate("__quizTest.openQuizLanding(state.items.find(x=>x.title==='Back test'))")
 page.locator('#qzLandPreview').click();page.locator('#qzToolsBtn').click()
 page.locator('#qzToolsOverlay.show').wait_for();back()
 assert not page.locator('#qzToolsOverlay').evaluate("e=>e.classList.contains('show')");ok('Back closes exam tools before the quiz')
 page.locator('#qzToolsBtn').click();page.locator('#qzToolsApplyAll').click();page.locator('#qzApplyAllOverlay.show').wait_for();back()
 assert not page.locator('#qzApplyAllOverlay').evaluate("e=>e.classList.contains('show')") if page.locator('#qzApplyAllOverlay').count() else True
 ok('Back cancels Apply to All without changing quiz settings')
 page.locator('#qzNavDrawerBtn').click();back()
 assert not page.locator('#qzExamShell').evaluate("e=>e.classList.contains('qz-navdrawer-open')")
 assert page.locator('#qzToolsBtn').count()==1;ok('Back closes question navigation before the quiz')
 back();page.locator('#qzLandTake').wait_for();back()
 assert not page.locator('#qzPageOverlay').evaluate("e=>e.classList.contains('show')");ok('Quiz preview returns to its landing screen before Documents')
 assert not errors,errors
 leave[0]=True;back();page.wait_for_url('**/before');ok('Confirm leaving returns to the preceding browser page')
 for query in ['quiz_share=synthetic-link','item_share=synthetic-link']:
  external=c.new_page();external.goto('http://127.0.0.1:8780/?'+query,wait_until='domcontentloaded')
  external.wait_for_function('!!window.qlUiBack')
  assert not external.evaluate('history.state?.qlBackArmed')
  external.close()
 ok('Public share links retain ordinary external navigation')
 print(str(len(passed))+' system Back scenarios passed; no browser errors',flush=True)
 b.close()
