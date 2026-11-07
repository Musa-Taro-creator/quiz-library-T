"""Dashboard answer latency and single tap regression checks; no live I/O."""
from pathlib import Path
import json,statistics
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/'index.html').read_text().replace('const MOCK_MODE=false;','const MOCK_MODE=true;',1)
needle='const service=MOCK_MODE?createMockService():createSupabaseService();'
SOURCE=SOURCE.replace(needle,needle+'\nservice.client=window.auditClient;\n',1)
BASE=(ROOT/'tests/fixtures/dashboard-quiz-browser.js').read_text()
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 def boot(fast=True,width=1024,mode='dashboard',delay=800):
  context=browser.new_context(viewport={'width':width,'height':900},has_touch=True,is_mobile=width==390,service_workers='block')
  init=BASE+r'''
  audit.gradeStarted=0;audit.pending=0;audit.changeCount=0;
  const latencyRpc=auditRpc;
  auditRpc=async(name,args)=>{
   const grade=name==='ql_dash_quiz_grade_v1';
   if(grade){audit.gradeStarted++;audit.pending++;await new Promise(resolve=>setTimeout(resolve,audit.gradeDelay))}
   try{return await latencyRpc(name,args)}finally{if(grade)audit.pending--}
  };
  auditQuiz.quiz_settings={...auditQuiz.quiz_settings,layout:'horizontal',show_answer_immediately:true,auto_advance:{mode:'off',delay:0.3},shuffle_mode:'answers',time_limit_minutes:0};
  document.addEventListener('change',e=>{if(e.target.matches('.qz-run-mcq,.qz-run-tf,.qz-run-mcq-multi'))audit.changeCount++},true);
  '''+'\naudit.noFastSql='+json.dumps(not fast)+';audit.gradeDelay='+str(delay)+';'
  context.add_init_script(init)
  page=context.new_page();page.set_default_timeout(8000);errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  def route(r):
   u=r.request.url
   if u.startswith('http://127.0.0.1:8793/'):
    name=u.split('8793/',1)[1].split('?',1)[0]
    if name in ('','index.html'):r.fulfill(status=200,content_type='text/html',body=SOURCE)
    elif (ROOT/name).is_file():r.fulfill(status=200,content_type='application/javascript' if name.endswith('.mjs') else 'application/octet-stream',body=(ROOT/name).read_bytes())
    else:r.fulfill(status=404,body='Missing')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* local transport */')
   else:r.abort()
  context.route('**/*',route)
  page.goto('http://127.0.0.1:8793/',wait_until='domcontentloaded');page.get_by_role('button',name='Continue with Google').click()
  page.wait_for_function('!!state.user');page.wait_for_timeout(650)
  page.evaluate('service.getSession=async()=>state.user?{user:state.user}:null;state.items.push({...auditQuiz,_student_questions:auditQuiz.questions})')
  if mode=='library':
   page.evaluate('__quizTest.openQuizLanding(state.items.find(x=>x.id===auditQuiz.id))');page.locator('#qzLandTake').click()
  else:page.evaluate('qlTakeDashboardQuiz("audit-post","audit-quiz")')
  page.locator('#qzToolsBtn').wait_for()
  return context,page,errors
 def pick(page,qid,value,cls='mcq'):
  page.locator(f'.qz-run-{cls}[data-qid="{qid}"][value="{value}"]').locator('..').tap()
 def time_pick(page):
  page.evaluate(r'''()=>{
   window.answerTiming=null;
   document.addEventListener('pointerdown',function start(e){
    if(!e.target.closest('.qz-run-option'))return;
    document.removeEventListener('pointerdown',start,true);
    const t0=performance.now();
    const watch=new MutationObserver(()=>{
     if(document.querySelector('.qz-run-feedback.correct')){answerTiming=performance.now()-t0;watch.disconnect()}
    });watch.observe(document.getElementById('qzExamMain'),{subtree:true,childList:true});
   },true);
  }''')
  pick(page,'audit-q1','0');page.wait_for_function('answerTiming!==null')
  return page.evaluate('answerTiming')
 timings={}
 for mode in ['library','dashboard']:
  context,page,errors=boot(mode=mode)
  samples=[]
  for _ in range(7):
   samples.append(time_pick(page));page.locator('.qz-run-clear-btn[data-clear-qid="audit-q1"]').tap()
  timings[mode]=round(statistics.median(samples[1:]),1)
  assert page.evaluate('audit.gradeStarted')==0
  assert timings[mode]<350,(mode,timings)
  if mode=='dashboard':assert page.evaluate('audit.changeCount')==7
  assert not errors,errors;context.close()
 ok('Loaded Dashboard and own-library answers both avoid per-answer RPCs; median touch feedback ms '+json.dumps(timings))
 for width in [390,1024]:
  context,page,errors=boot(width=width)
  pick(page,'audit-q1','0');page.locator('.qz-run-feedback.correct').wait_for()
  assert page.evaluate('audit.changeCount')==1
  assert page.locator('.qz-run-mcq[value="0"]').is_disabled()
  page.locator('#qzBookmarkBtn').tap();page.locator('#qzFlagBtn').tap()
  page.locator('#qzNavNext').tap();pick(page,'audit-q2','false','tf');page.locator('.qz-run-feedback.correct').wait_for()
  page.locator('#qzNavNext').tap();page.locator('.qz-run-sa').fill(' paris ');page.locator('.qz-run-sa').blur();page.locator('.qz-run-feedback.correct').wait_for()
  page.locator('#qzNavNext').tap();pick(page,'audit-q4','0','mcq-multi');pick(page,'audit-q4','2','mcq-multi')
  page.locator('.qz-run-feedback.correct').wait_for();pick(page,'audit-q4','2','mcq-multi');page.locator('.qz-run-feedback.incorrect').wait_for()
  assert not page.locator('.qz-run-mcq-multi[value="2"]').is_checked()
  pick(page,'audit-q4','2','mcq-multi');page.locator('.qz-run-feedback.correct').wait_for()
  page.locator('#qzNavNext').tap();pick(page,'audit-q5','1')
  assert page.evaluate('audit.gradeStarted')==0
  page.locator('#qzNavNext').tap();page.locator('#qzResultRestartTop').wait_for()
  assert '100%' in page.locator('.qz-result-big-percent').inner_text()
  calls=page.evaluate('audit.calls.filter(x=>x.name==="ql_dash_quiz_submit_v1")')
  assert len(calls)==1 and not any(k in calls[0]['args'] for k in ['score','p_score','correct_answers'])
  assert page.evaluate('auditDb.attempts.length')==1
  ok(f'{width}px: single events, shuffle, False, short answers, checkbox deselection, marks and server-verified final results')
  assert not errors,errors;context.close()
 # Auto-advance starts from local feedback, independent of simulated 800ms grading latency.
 context,page,errors=boot()
 page.locator('#qzToolsBtn').tap();page.locator('#qzToolsAutoAdv').tap();page.locator('#qzAutoAdvSwitch').tap();page.locator('#qzAutoAdvClose').tap()
 time_pick(page);page.wait_for_function('__qzLiveSnap().curIdx===1',polling='raf')
 assert page.evaluate('audit.gradeStarted')==0
 ok('Auto-advance works with zero grading round trips')
 assert not errors,errors;context.close()
 # Before the small SQL addition, existing server grading continues with one request and cached feedback.
 context,page,errors=boot(fast=False,delay=300)
 pick(page,'audit-q1','0');page.wait_for_function('audit.pending===1')
 page.locator('#qzBookmarkBtn').tap();page.locator('#qzFlagBtn').tap()
 page.locator('.qz-run-feedback.correct').wait_for()
 assert page.evaluate('audit.gradeStarted')==1 and page.evaluate('audit.changeCount')==1
 page.locator('#qzBookmarkBtn').tap();page.locator('#qzFlagBtn').tap();page.locator('#qzNavNext').tap();page.locator('#qzNavBack').tap()
 page.locator('.qz-run-feedback.correct').wait_for();assert page.evaluate('audit.gradeStarted')==1
 page.locator('.qz-run-clear-btn[data-clear-qid="audit-q1"]').tap();pick(page,'audit-q1','0');page.locator('.qz-run-feedback.correct').wait_for()
 assert page.evaluate('audit.gradeStarted')==1
 ok('Old SQL remains compatible: one request per tap, cached revisits and reselects')
 assert not errors,errors;context.close()
 context,page,errors=boot(fast=False,delay=600)
 pick(page,'audit-q1','0');page.locator('.qz-run-clear-btn[data-clear-qid="audit-q1"]').tap()
 page.wait_for_function('audit.gradeStarted===1 && audit.pending===0')
 assert page.locator('.qz-run-feedback').count()==0
 assert not page.locator('.qz-run-mcq[value="0"]').is_disabled()
 assert 'audit-q1' not in page.evaluate('__qzLiveSnap().answers')
 ok('A delayed response cannot restore feedback or lock an answer after Clear selection')
 assert not errors,errors;context.close()
 browser.close()
print(f'{len(checks)} instant-feedback browser scenarios passed; no live requests.')
