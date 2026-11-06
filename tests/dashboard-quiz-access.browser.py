"""Real Dashboard, runner, Tools and copy handlers with simulated transport.

No live account, post, email or database is contacted. PostgreSQL RPCs are
exercised independently by dashboard-quiz-access.test.mjs.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
INIT=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()+r'''
const configRpc=auditRpc;
auditRpc=async(name,args)=>{const r=await configRpc(name,args);if(name==='ql_public_config')r.data.settings.features={quiz_autoadv:'lock',quiz_shuffle:'off',quiz_bookmark:'off',quiz_summary:'plan'};return r};
audit.inserts=[];
'''
AFTER=r'''
window.addEventListener('DOMContentLoaded',()=>{
 service.getQuizQuestionsAdmin=async()=>structuredClone(auditQuiz.questions);
 service.getQuizForTaking=async()=>({title:auditQuiz.title,settings:auditQuiz.quiz_settings,questions:auditQuiz.questions.map(q=>{const x={...q};delete x.correct_answer;delete x.explanation;return x})});
 service.updateItem=async(id,patch)=>{audit.writes.push({id,patch});const x=state.items.find(x=>x.id===id)||auditQuiz;Object.assign(x,patch);return {...x}};
});
'''
SOURCE=(ROOT/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
needle='const service=MOCK_MODE?createMockService():createSupabaseService();'
SOURCE=SOURCE.replace(needle,needle+'\nservice.client=window.auditClient;\n'+AFTER,1)
checks=[]
def ok(message):checks.append(message);print('PASS:',message,flush=True)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for width in [1200,390,1024]:
  c=b.new_context(viewport={'width':width,'height':900},service_workers='block',has_touch=width!=1200,is_mobile=width==390)
  c.add_init_script(INIT)
  page=c.new_page();page.set_default_timeout(8000);errors=[];dialogs=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
  def route(r):
   u=r.request.url
   if u.startswith('http://127.0.0.1:8793/'):
    name=u.split('8793/',1)[1].split('?',1)[0]
    if name in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=SOURCE)
    elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith('.mjs') else 'application/octet-stream',body=(ROOT/name).read_bytes())
    else:r.fulfill(status=404,body='Missing local fixture')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local transport */')
   else:r.abort()
  c.route('**/*',route)
  page.goto('http://127.0.0.1:8793/',wait_until='domcontentloaded')
  page.get_by_role('button',name='Continue with Google').click()
  page.wait_for_function('!!state.user');page.wait_for_timeout(600)
  page.evaluate('''()=>{service.getSession=async()=>state.user?{user:state.user}:null;state.items.push({...auditQuiz});window.open=(url)=>{audit.opened=url};qlOpenDash()}''')
  original_url=page.url
  page.locator('#qlDash [data-post="audit-post"]').click()
  page.locator('#qzToolsBtn').wait_for()
  assert page.locator('#qzStartBtn').count()==0
  assert page.url==original_url and not page.evaluate('audit.opened')
  assert page.locator('#qzNavGrid [data-navidx]').count()==5
  assert page.locator('.qz-run-image').count()==1
  ok(f'{width}px: posted quiz opens in the website with all five questions, image and account identity')
  page.locator('#qzVertNextSessionBtn').click();assert page.locator('#qzNavGrid [data-navidx]').count()==2
  page.locator('#qzVertPrevSessionBtn').click()
  # The admin hides/locks these for normal quizzes. Dashboard keeps them usable.
  if width==390:page.locator('#qzNavDrawerBtn').click()
  page.locator('#qzSummaryBtn').click();assert page.locator('.qz-summary-row').count()==5
  page.locator('#qzSummaryCancel').click()
  if width==390:page.locator('#qzNavScrim').click() if page.locator('#qzNavScrim').count() else page.evaluate('document.querySelector("#qzExamShell").classList.remove("qz-navdrawer-open")')
  page.locator('#qzToolsBtn').click();page.wait_for_timeout(300)
  assert page.locator('#qzToolsEdit').count()==0 and page.locator('#qzToolsApplyAll').count()==0
  assert page.locator('#qzToolsShuffle').is_visible() and not page.locator('#qzToolsShuffle').evaluate('e=>e.classList.contains("ql-locked")')
  assert not page.locator('#qzToolsAutoAdv').evaluate('e=>e.classList.contains("ql-locked")')
  ok(f'{width}px: taking tools bypass plan/lock/hidden settings; author editing and Apply All stay absent')
  page.locator('#qzTextInc').click();page.locator('[data-nav-side="left"]').click();page.locator('[data-theme="paper"]').click()
  page.wait_for_timeout(750)
  page.locator('#qzToolsMood').click()
  page.locator('input[name="qzBehLayout"][value="horizontal"]').locator('..').click()
  page.locator('input[name="qzBehFeedback"][value="instant"]').locator('..').click()
  page.locator('#qzBehClose').click();page.wait_for_timeout(300)
  page.locator('#qzBookmarkBtn').click();page.locator('#qzFlagBtn').click()
  page.locator('[data-qid="audit-q1"].qz-run-mcq[value="0"]').locator('..').click()
  page.wait_for_function('__qzLiveSnap().curIdx===1')
  assert page.evaluate('__qzLiveSnap().graded["audit-q1"].correct') is True
  ok(f'{width}px: layout, instant grading, automatic advance, bookmark and flag work')
  page.locator('#qzToolsBtn').click();page.locator('#qzToolsShuffle').click()
  page.locator('#qzShfSwitch').click();page.locator('#qzShfSwitch').click();page.locator('#qzShfClose').click()
  page.locator('#qzToolsBtn').click();page.locator('#qzToolsMood').click()
  assert page.locator('input[name="qzBehLayout"]:checked').input_value()=='horizontal'
  assert page.locator('input[name="qzBehFeedback"]:checked').input_value()=='instant'
  page.locator('input[name="qzBehLayout"][value="vertical"]').locator('..').click()
  page.locator('input[name="qzBehFeedback"][value="end"]').locator('..').click()
  page.locator('#qzBehClose').click()
  assert page.locator('.qz-run-sa').count()==1
  page.wait_for_timeout(350)
  page.evaluate('__qlSnapshotBeforeReload()');saved=page.evaluate('JSON.parse(localStorage.getItem("ql_resume_after_update_v1"))')
  assert saved['answers']['audit-q1']==0 and saved['dashboard']['postId']=='audit-post'
  if width==1200:
   page.reload(wait_until='domcontentloaded');page.locator('#qzToolsBtn').wait_for();page.wait_for_timeout(500)
   resumed=page.evaluate('__qzLiveSnap()')
   assert resumed['answers']['audit-q1']==0 and resumed['bookmarks']==['audit-q1'] and resumed['flags']==['audit-q1']
   assert resumed['attemptId']==saved['attemptId']
   assert page.locator('#qzExamShell').evaluate('e=>e.classList.contains("qz-theme-paper") && e.dataset.textsize==="1"')
   page.evaluate('service.getSession=async()=>state.user?{user:state.user}:null')
   ok('App-update Refresh restores Dashboard answers, marks, preferences and the attempt identifier')
  for qid,cls,value in [('audit-q1','mcq','0'),('audit-q2','tf','false'),('audit-q4','mcq-multi','0'),('audit-q4','mcq-multi','2'),('audit-q5','mcq','1')]:
   loc=page.locator(f'[data-qid="{qid}"].qz-run-{cls}[value="{value}"]')
   if not loc.is_checked():loc.locator('..').click()
  page.locator('[data-qid="audit-q3"].qz-run-sa').fill('Paris')
  page.locator('#qzFinishBtn').click();page.locator('#qzResultRestartTop').wait_for()
  assert '100%' in page.locator('.qz-result-big-percent').inner_text()
  assert page.locator('#qzReviewBody .qz-run-question').count()==5
  assert page.locator('#qzAttemptHistoryList').inner_text()
  assert page.evaluate('audit.writes.length')==0
  assert page.evaluate('auditDb.attempts.length')==1
  page.locator('[data-review-filter="incorrect"]').click();assert page.locator('#qzReviewBody .qz-run-question').count()==0
  page.locator('[data-review-filter="all"]').click()
  ok(f'{width}px: score, saved account history and review filters work without author writes')
  page.locator('#qzResultRestartTop').click();page.locator('#qzToolsBtn').wait_for()
  assert page.locator('#qzStartBtn').count()==0
  page.locator('#qzExamHome').click();page.wait_for_timeout(200)
  assert page.locator('#qlDash [data-post="folder-post"]').count()==1
  page.locator('#qlDash [data-post="folder-post"]').click()
  page.locator('#qlItemViewer [data-ref="nested"]').click();page.locator('#qlItemViewer [data-ref="audit-quiz"]').click()
  page.locator('#qzToolsBtn').wait_for();page.locator('#qzExamHome').click()
  assert page.locator('#qlItemViewer [data-ref="audit-quiz"]').count()==1
  page.locator('#qlItemViewer .ql-iv-close').click()
  ok(f'{width}px: restart and Back preserve Dashboard and nested-folder browsing')
  if width==1200:
   # Switch accounts: no previous student's personal Tools or results.
   owner=page.evaluate('state.user.id')
   page.evaluate('state.user={...state.user,id:"other-student"};qlTakeDashboardQuiz("audit-post","audit-quiz")')
   page.locator('#qzToolsBtn').wait_for()
   assert page.locator('#qzExamShell').evaluate('e=>!e.classList.contains("qz-theme-paper") && e.dataset.textsize==="0"')
   assert page.evaluate('auditDb.attempts.filter(a=>a.user_id===state.user.id).length')==0
   page.locator('#qzExamHome').click();page.evaluate('(id)=>state.user={...state.user,id}',owner)
   ok('Another account receives independent preferences and attempts')
   # Exercise actual Save to my library, then actual owned-copy controls.
   page.evaluate('''()=>{
    service.insertItem=async row=>{const x={...row,_student_personalized:true};audit.inserts.push(x);return x};
    service.saveQuizQuestions=async(id,questions,settings)=>{const it=state.items.find(x=>x.id===id);it._student_questions=questions;it.quiz_settings=settings};
    loadAll=async()=>{};
   }''')
   page.locator('[data-post="audit-post"] [data-qd-more]').click();page.locator('#qlDashMenu .ql-dash-save').click();page.locator('#qlDashSaveGo').click()
   page.wait_for_function('audit.inserts.length===1 && state.items.some(x=>x.ql_from_dash)')
   page.evaluate('__quizTest.openQuizLanding(state.items.find(x=>x.ql_from_dash))')
   page.locator('#qzLandTake').click();page.locator('#qzToolsBtn').click()
   page.locator('#qzToolsApplyAll').click();page.locator('#qzApplyAllOverlay.show').wait_for()
   page.evaluate('history.back()');page.wait_for_timeout(200)
   page.locator('#qzToolsBtn').click();page.locator('#qzToolsEdit').click();page.locator('#qzBtnAddNew').wait_for(state='attached')
   ok('Saving creates a separate quiz with functional Edit Quiz and Apply to All controls')
  assert not errors,errors
  assert not dialogs,dialogs
  c.close()
 # Missing migration keeps the existing opening behavior operational.
 c=b.new_context(viewport={'width':1200,'height':900},service_workers='block');c.add_init_script(INIT)
 page=c.new_page();page.set_default_timeout(8000);c.route('**/*',route)
 page.goto('http://127.0.0.1:8793/',wait_until='domcontentloaded');page.get_by_role('button',name='Continue with Google').click()
 page.wait_for_function('!!state.user');page.wait_for_timeout(600)
 page.evaluate('service.getSession=async()=>state.user?{user:state.user}:null;audit.missingSql=true;window.open=url=>audit.opened=url;qlOpenDash()')
 page.locator('#qlDash [data-post="audit-post"]').click();page.wait_for_function('!!audit.opened')
 assert page.evaluate('audit.opened').endswith('?quiz_share=audit-token')
 assert page.locator('#qzToolsBtn').count()==0
 ok('Before SQL activation, the existing Dashboard quiz opening remains available')
 c.close()
 # External links keep their own identity screen and existing plan controls.
 c=b.new_context(viewport={'width':1200,'height':900},service_workers='block');c.add_init_script(INIT)
 page=c.new_page();page.set_default_timeout(8000);c.route('**/*',route)
 page.goto('http://127.0.0.1:8793/?quiz_share=audit-token',wait_until='domcontentloaded')
 page.locator('#qzStartBtn').click();page.locator('#qzToolsBtn').click();page.wait_for_timeout(300)
 assert not page.locator('#qzToolsShuffle').is_visible()
 assert page.locator('#qzToolsAutoAdv').evaluate('e=>e.classList.contains("ql-locked")')
 assert page.evaluate('audit.calls.every(x=>!x.name.startsWith("ql_dash_quiz_"))')
 ok('External sharing retains its start screen and existing feature controls')
 c.close()
 print(f'{len(checks)} Dashboard browser scenarios passed; no live requests.',flush=True)
 b.close()
