"""Everyday student library actions in the real UI, with local mock persistence."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [390,1024]:
  context=browser.new_context(viewport={'width':width,'height':900},has_touch=True,service_workers='block');page=context.new_page();page.set_default_timeout(10000);errors=[];dialogs=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
  def route(r):
   url=r.request.url
   if url.startswith('http://127.0.0.1:8824/'):
    name=url.split('8824/',1)[1].split('?',1)[0]
    if name in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=SOURCE)
    elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith(('.mjs','.js')) else 'application/octet-stream',body=(ROOT/name).read_bytes())
    else:r.fulfill(status=404,body='Missing')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* mock-only transport */')
   else:r.abort()
  context.route('**/*',route);page.goto('http://127.0.0.1:8824/',wait_until='domcontentloaded');page.get_by_role('button',name='Continue with Google').click();page.wait_for_function('!!state.user');page.evaluate('service.getSession=async()=>({user:state.user});void __studentWorkspace.activate()');page.wait_for_function('state.studentWorkspaceReady')
  def item(title):return page.evaluate('(t)=>state.items.find(x=>x.title===t)',title)
  def stored(id):return page.evaluate('(id)=>JSON.parse(localStorage.getItem(`ql_student_workspace_${LIBRARY_ID}_${state.user.id}`)||"[]").find(x=>x.id===id)?.payload',id)
  def folder(title):
   page.evaluate('openFolderEditor()');page.locator('#folderEditorTitle').fill(title);page.locator('#folderEditorSave').click();page.wait_for_function('(t)=>state.items.some(x=>x.title===t)',arg=title);page.wait_for_function('!document.querySelector("#modalOverlay.show")')
   # Closing the editor removes its Back entry with a delayed history.back(); wait for it,
   # or a navigation made right after can be undone by that late Back.
   page.wait_for_function('!history.state?.qlUiLayer');return item(title)
  a=folder('Course material');page.evaluate('(id)=>navigate("documents",id)',a['id']);b=folder('Week one');assert b['parent_id']==a['id'];assert stored(b['id'])['parent_id']==a['id'];ok(f'{width}px: folders and nested positions save')
  page.evaluate('openEditor("link")');page.locator('#editorTitle').fill('Reference link');page.locator('#editorUrl').fill('https://example.test/reference');page.locator('#editorSave').click();page.wait_for_function('state.items.some(x=>x.title==="Reference link")');link=item('Reference link');assert stored(link['id'])['url']=='https://example.test/reference'
  page.evaluate('(id)=>openEditor(itemById(id))',link['id']);page.locator('#editorTitle').fill('Updated reference');page.locator('#editorSave').click();page.wait_for_function('(id)=>itemById(id).title==="Updated reference"',arg=link['id']);assert stored(link['id'])['title']=='Updated reference';ok(f'{width}px: links create, edit and persist')
  page.evaluate('openUpload()');page.locator('#pdfInput').set_input_files(str(ROOT/'tests/fixtures/sample.pdf'));page.locator('#uploadStart').click();page.wait_for_function('state.items.some(x=>x.kind==="pdf"&&x.title==="sample")');pdf=item('sample');assert stored(pdf['id'])['file_size']==(ROOT/'tests/fixtures/sample.pdf').stat().st_size;assert pdf['storage_path'];page.wait_for_function('!document.querySelector("#modalOverlay.show")');ok(f'{width}px: PDF upload saves metadata and folder position')
  page.evaluate('(id)=>{void toggleFavorite(itemById(id))}',link['id']);page.wait_for_function('(id)=>isFavorite(itemById(id))',arg=link['id']);page.wait_for_function('!history.state?.qlUiLayer');page.evaluate('navigate("favorites")');page.locator(f'#content [data-id="{link["id"]}"]').wait_for(timeout=5000);assert page.locator(f'#content [data-id="{link["id"]}"]').count()==1;page.evaluate('(id)=>navigate("documents",id)',a['id']);ok(f'{width}px: Favorites show the starred item')
  page.evaluate('(id)=>openMove([id])',link['id']);page.locator('#modalBody .ql-fp-field').click();page.locator('#qlLocSheet .ql-loc-search input').fill('Week one');page.locator(f'#qlLocSheet [data-id="{b["id"]}"]').click();page.locator('#qlLocSheet .ql-loc-go').click();page.locator('#moveSave').click();page.wait_for_function('!document.querySelector("#modalOverlay.show")');assert stored(link['id'])['parent_id']==b['id'];ok(f'{width}px: Move persists the new folder')
  page.evaluate('(id)=>{void duplicateItems([id])}',b['id']);page.wait_for_function('state.items.some(x=>x.title==="Week one copy")');copy=item('Week one copy');copies=page.evaluate('(id)=>state.items.filter(x=>x.parent_id===id)',copy['id']);assert any(x['title']=='Updated reference' for x in copies);assert all(x['id']!=link['id'] for x in copies);ok(f'{width}px: folder duplication creates independent nested items')
  # Trash/Restore handle the folder first, then what is inside it: wait for the nested link too.
  page.evaluate('(id)=>{void trashItems([id])}',b['id']);page.wait_for_function('(id)=>itemById(id).is_trashed',arg=b['id']);page.wait_for_function('(id)=>itemById(id).is_trashed',arg=link['id']);assert stored(link['id'])['is_trashed'];page.wait_for_function('!history.state?.qlUiLayer');page.evaluate('navigate("trash")');page.locator(f'#content [data-id="{b["id"]}"]').wait_for(timeout=5000);assert page.locator(f'#content [data-id="{b["id"]}"]').count()==1
  page.evaluate('(id)=>{void restoreItems([id])}',b['id']);page.wait_for_function('(id)=>!itemById(id).is_trashed',arg=b['id']);page.wait_for_function('(id)=>!itemById(id).is_trashed',arg=link['id']);assert stored(link['id'])['parent_id']==b['id'];assert not stored(link['id'])['is_trashed'];ok(f'{width}px: Trash and Restore retain nested content')
  page.evaluate('(id)=>{void trashItems([id])}',copy['id']);page.wait_for_function('(id)=>itemById(id).is_trashed',arg=copy['id']);page.evaluate('(id)=>{void deletePermanent([id])}',copy['id']);page.wait_for_function('(id)=>!itemById(id)',arg=copy['id']);assert stored(copy['id']) is None;assert stored(link['id']);ok(f'{width}px: permanent deletion removes only the selected copy')
  page.evaluate('(id)=>navigate("documents",id)',a['id']);page.reload(wait_until='domcontentloaded');page.wait_for_function('!!state.user');page.evaluate('service.getSession=async()=>({user:state.user});void __studentWorkspace.activate()');page.wait_for_function('state.studentWorkspaceReady');assert item('Updated reference')['parent_id']==b['id'];assert item('sample');assert item('Week one');ok(f'{width}px: saved library survives reload')
  # Exercise the normal random-quiz UI across two independently saved quizzes.
  page.evaluate("""async()=>{for(const [id,title] of [['random-source-a','Anatomy practice'],['random-source-b','Pathology practice']]){const qs=[0,1].map(i=>({id:id+'-'+i,type:'mcq',prompt:title+' question '+i,options:[{text:'Correct'},{text:'Wrong'}],correct_answer:0,question_position:i,points:1}));const row=await service.insertItem({id,kind:'quiz',title,parent_id:null,quiz_settings:{question_count:2,layout:'vertical'}});replaceLocal(row);replaceLocal(await service.saveQuizQuestions(id,qs,{question_count:2,layout:'vertical'}))}navigate('documents');void qzOpenRandomQuizGlobal()}""")
  page.locator('#qzRandSearch').fill('Anatomy');assert page.locator('.qz-rand-quiz-row:visible').count()==1;page.locator('#qzRandSearch').fill('');assert page.locator('.qz-rand-quiz-row:visible').count()==2
  page.locator('#qzRandCountPresets [data-count="custom"]').click();page.locator('#qzRandCustomCount').fill('2');page.locator('.qz-rand-split-btn[data-mode="custom"]').click();page.locator('.qz-rand-split-input[data-id="random-source-a"]').fill('1');page.locator('.qz-rand-split-input[data-id="random-source-b"]').fill('1');page.locator('#qzRandNoLimit').check();page.locator('#qzRandName').fill('Combined practice');page.locator('#qzRandStart').click();page.locator('#qzExamShell').wait_for();ok(f'{width}px: Random Quiz search, custom count and per-quiz split start a combined quiz')
  page.locator('#qzToolsBtn').click();page.locator('#qzToolsMood').click();page.locator('input[name="qzBehLayout"][value="vertical"]').locator('..').click();page.locator('#qzBehClose').click()
  answers=page.locator('.qz-run-mcq[value="0"]');assert answers.count()==2
  for answer in answers.all():answer.locator('..').click()
  page.locator('#qzFinishBtn').click();page.locator('.qz-result-big-percent').wait_for();assert '100%' in page.locator('.qz-result-big-percent').inner_text();page.locator('#qzTopClose').click();ok(f'{width}px: combined Random Quiz answers grade correctly and Finish returns a result')
  assert not errors,errors;assert dialogs==['Delete permanently? This cannot be undone.'],dialogs;context.close()
 browser.close()
print(f'{len(checks)} library workflow checks passed; PDF storage and sign-in use local mocks.')
