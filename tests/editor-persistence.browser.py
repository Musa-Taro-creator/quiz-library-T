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

 page.get_by_role('button',name='Continue with Google').click();page.wait_for_timeout(300)
 page.evaluate('service.getSession=async()=>state.user?({user:state.user}):null')
 page.get_by_role('button',name='Create Quiz',exact=True).click()
 page.locator('#qzNewTitle').fill('Audit quiz')
 page.locator('#qzNewCreate').click()
 page.locator('#qzBtnAddNew').click()
 page.locator('[data-tab="bulk"]').click()
 data='1. Pick one?\nA. First\nB. Second\nAnswer: A\n\n2. True or false?\nA. True\nB. False\nAnswer: B\n\n3. Capital of France?\nAnswer: Paris'
 page.locator('#qzAqBulkArea').fill(data);page.locator('#qzAqParse').click();page.locator('#qzAddQSubmit').click()
 page.wait_for_timeout(2500)

 page.evaluate("""()=>{window.saveCalls=[];const original=service.saveQuizQuestionsPartial;service.saveQuizQuestionsPartial=async(...args)=>{saveCalls.push(JSON.parse(JSON.stringify(args)));if(saveCalls.length===1)await new Promise(resolve=>window.releaseSave=resolve);return await original(...args)}}""")
 prompt=page.locator('.qz-question-card[data-qidx="0"] .qz-prompt')
 prompt.fill('First edit submitted')
 page.wait_for_function('saveCalls.length===1')
 prompt.fill('Second edit while saving')
 page.wait_for_timeout(2100)
 page.evaluate('releaseSave()')
 page.wait_for_timeout(2500)
 result=page.evaluate("""()=>{const quiz=state.items.find(x=>x.kind==='quiz');const stored=JSON.parse(localStorage.getItem(`ql_student_workspace_${LIBRARY_ID}_${state.user.id}`)).find(r=>r.id===quiz.id);return {ui:document.querySelector('.qz-question-card[data-qidx="0"] .qz-prompt').value,stored:stored.payload._student_questions[0].prompt,draft:localStorage.getItem(`ql_quiz_draft_v2_${state.user.id}_${LIBRARY_ID}_${quiz.id}`),calls:saveCalls.length,status:document.querySelector('#qzAutosaveStatus').textContent}}""")
 print('AUTOSAVE_RACE',json.dumps(result),flush=True)
 assert result['ui']=='Second edit while saving' and result['stored']=='Second edit while saving' and result['draft'] is None and result['calls']==2

 page.locator('#qzBtnMood').click()
 page.locator('input[name="qzBehLayout"][value="vertical"]').locator('..').click()
 page.locator('#qzBehClose').click();page.wait_for_timeout(2500)
 stored=page.evaluate('state.items.find(x=>x.kind==="quiz").quiz_settings')
 assert stored['layout']=='vertical',stored
 print('Settings-only persistence passed')
 data=page.evaluate("()=>{const item=state.items.find(x=>x.kind==='quiz');return {item,qs:item._student_questions,owner:state.user.id}}")
 data['qs'][0]['prompt']='Private draft from account A'
 page.evaluate("d=>{localStorage.setItem(`ql_quiz_draft_v2_${d.owner}_${LIBRARY_ID}_${d.item.id}`,JSON.stringify({owner:d.owner,library:String(LIBRARY_ID),quiz:d.item.id,questions:d.qs,settings:d.item.quiz_settings}));localStorage.setItem('ql_quiz_draft_'+d.item.id,JSON.stringify({questions:d.qs}));state.user={id:'account-B',email:'b@example.test'};__quizTest.openQuizWorkspace({...d.item,_student_questions:[{...d.qs[0],prompt:'Server question'}]})}",data)
 page.wait_for_timeout(400)
 assert page.locator('.qz-question-card[data-qidx="0"] .qz-prompt').input_value()!='Private draft from account A'
 assert page.evaluate('localStorage.getItem("ql_quiz_draft_"+'+repr(data['item']['id'])+')') is not None
 assert not errors,errors
 print('Account-isolated drafts; legacy draft retained; no browser errors')

 b.close()
