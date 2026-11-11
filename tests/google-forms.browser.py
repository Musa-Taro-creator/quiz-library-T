"""Make Google Form in the student app: toolbar button (after Create Quiz, same look as its neighbours in each theme), Make new
(Paste = the quiz editor's Bulk Paste panel without Destination/Position; or one of my quizzes
with From–To and parts for long quizzes), picture warning, forms left today, a progress
percentage while the form is made, then My Google Forms opens with the new form (link, date,
days ago) and the list keeps groups, search, status, menu actions and Drive.

Real index.html in Chromium (tablet + phone width) with a simulated Supabase and a fake
Edge Function (functions.invoke). No network, no Google.
"""
from pathlib import Path
import re, json, sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
BASE = re.search(r"STUB = r'''(.*?)'''", (ROOT / 'tests/password-recovery.browser.py').read_text(), re.S).group(1)
SESSION = """sessionStorage.setItem('local-recovery-session',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',
 email:'audit@example.test',app_metadata:{provider:'email'},user_metadata:{full_name:'Local test'}},expires_at:Math.floor(Date.now()/1000)+3600}));"""
SERVER = r'''
const ago=(d,h=10)=>{const x=new Date();x.setDate(x.getDate()-d);x.setHours(h,15,0,0);return x.toISOString()};
window.srv={calls:[],invokes:[],limit:5,used:1,setUp:true,enabled:true,fail:null,mode:'default',cap:100,forms:[
 {id:'r1',title:'Anatomy – Upper limb',question_count:40,form_id:'F1',responder_url:'https://forms.gle/F1',edit_url:'https://docs.google.com/forms/d/F1/edit',folder_url:'https://drive.google.com/drive/folders/D1',owner_email:'quizlibrary.forms@gmail.com',editor_email:'bona@gmail.com',accepting:true,created_at:ago(0,9)},
 {id:'r2',title:'Cardio MCQ – Block 2',question_count:60,form_id:'F2',responder_url:'https://forms.gle/F2',edit_url:'https://docs.google.com/forms/d/F2/edit',folder_url:'https://drive.google.com/drive/folders/D1',owner_email:'quizlibrary.forms@gmail.com',editor_email:'bona@gmail.com',accepting:false,created_at:ago(3)},
 {id:'r3',title:'Old exam 2025',question_count:25,form_id:'F3',responder_url:'https://forms.gle/F3',edit_url:'https://docs.google.com/forms/d/F3/edit',folder_url:'https://drive.google.com/drive/folders/D1',owner_email:'quizlibrary.forms@gmail.com',editor_email:null,accepting:true,created_at:ago(20)}]};
const plans=[{id:'free',name:'Free',is_default:true,visibility:'public',sort:10,color:'#94a3b8',price_month:0,limits:{},features:{}}];
const answers={
 ql_public_config:()=>({plans,settings:{features:{},site:{open:true}},server_time:new Date().toISOString()}),
 ql_my_plan:()=>({plan:plans[0],subscription:null,usage:{quizzes:0,pdfs:0,links:0,folders:0,storage_bytes:0}}),
 ql_support_mine:()=>[],ql_support_unread:()=>0,ql_my_gifts:()=>[],ql_my_greeting:()=>null,ql_my_payments:()=>[],
 ql_received_item_share_count:()=>0,ql_received_quiz_share_count:()=>0,ql_ensure_share_profile:()=>({share_id:'QL-MINE0001',display_name:'Local test'}),
 ql_gform_mine:()=>{const unl=srv.mode==='unlimited'||srv.mode==='admin'||(srv.mode==='plan'&&srv.limit==null),max=unl?srv.cap:srv.limit;return {enabled:srv.enabled,set_up:srv.setUp,mode:srv.mode,unlimited:unl,cap:srv.cap,plan_name:srv.planName||null,max_questions:srv.maxQ||200,limit:unl?null:srv.limit,used_today:srv.used,left:Math.max(0,max-srv.used),forms:srv.forms.slice()}},
 ql_gform_remove:a=>{srv.forms=srv.forms.filter(f=>f.id!==a.p_id);return null}
};
const fn={
 make:b=>{if(srv.fail)return {ok:false,error:srv.fail};srv.used++;const id='F'+(srv.forms.length+10);const f={id:'r'+id,title:b.title,source:b.source,from_template:!srv.noTpl,question_count:b.questions.length,form_id:id,responder_url:'https://forms.gle/'+id,edit_url:'https://docs.google.com/forms/d/'+id+'/edit',folder_url:'https://drive.google.com/drive/folders/D1',owner_email:'quizlibrary.forms@gmail.com',editor_email:b.editor_email||null,accepting:true,created_at:new Date().toISOString()};
   const unl=srv.mode==='unlimited'||srv.mode==='admin';srv.forms.unshift(f);
   /* like the real Edge Function: chunked + more than 30 questions = only the first 30 now, the rest with "add" */
   const parts=b.chunked&&b.questions.length>30,first=parts?b.questions.slice(0,30):b.questions;
   return {ok:true,form:f,unlimited:unl,left:(unl?srv.cap:srv.limit)-srv.used,limit:unl?null:srv.limit,editor_error:'',no_answer:first.filter(q=>q.type==='mcq'&&q.correct.some(c=>c<0)).length,short_answers:first.filter(q=>q.type==='short_answer').length,
     next:parts?30:null,total:b.questions.length,part:30,from_template:!srv.noTpl}},
 add:b=>{if(srv.failAdd||(srv.failAddAt&&b.questions[0]&&String(b.questions[0].prompt).endsWith(srv.failAddAt)))return {ok:false,error:'Google said no'};return {ok:true,added:b.questions.length,question_count:b.start+b.questions.length,no_answer:0,short_answers:0,last:b.last}},
 discard:b=>{srv.forms=srv.forms.filter(f=>f.id!==b.id);return {ok:true}},
 status:()=>({ok:true,forms:{F1:{accepting:true,responses:12,title:'x'},F2:{accepting:false,responses:31,title:'x'},F3:{missing:true}}}),
 rename:b=>{const f=srv.forms.find(x=>x.id===b.id);f.title=b.title;return {ok:true,title:b.title}},
 accepting:b=>({ok:true,accepting:b.accepting}),share:b=>({ok:true,editor_email:b.email,folder_url:'https://drive.google.com/drive/folders/D1'})
};
const realFactory=window.supabase.createClient;
window.supabase.createClient=(...a)=>{const c=realFactory(...a),rpc=c.rpc;
 c.rpc=async(name,args)=>{srv.calls.push({name,args:JSON.parse(JSON.stringify(args||{}))});
  if(name in answers)return {data:answers[name](args||{}),error:null};return rpc(name,args)};
 c.functions={invoke:async(name,o)=>{srv.invokes.push({name,body:JSON.parse(JSON.stringify(o.body))});
   /* Supabase itself answering (time limit): supabase-js only says "non-2xx" and the body is not ours */
   if(srv.httpFail&&o.body.action==='make')return {data:null,error:{message:'Edge Function returned a non-2xx status code',context:new Response('{"code":"WORKER_LIMIT","message":"Wall clock limit reached"}',{status:srv.httpFail})}};await new Promise(r=>setTimeout(r,o.body.action==='make'?(srv.delay||60):60));return {data:fn[o.body.action](o.body),error:null}}};
 return c};
'''
PASTE = """1. Which valve sits between the left atrium and ventricle?
A) Mitral
B) Aortic
C) Tricuspid
Answer: A

2. The heart has four chambers.
A) True
B) False

3. Pick the bones
A) Femur
B) Tibia
C) Aorta

4. Largest artery?
Answer: Aorta
"""
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
THEMES = sys.argv[2:] or ['white']
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for theme in THEMES:
      for width, height in ((1024, 768), (390, 844)):
        context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block', device_scale_factor=(2 if SHOTS and width < 500 else 1))
        context.add_init_script(SESSION + BASE + SERVER + "try{localStorage.setItem('ql_app_skin','%s')}catch(e){}" % theme)
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin='http://127.0.0.1:8834')
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8834/'):
                sub = url.split('8834/', 1)[1].split('?', 1)[0]
                if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
                else: r.fulfill(status=404, body='')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
            else: r.abort()
        context.route('**/*', route)
        page = context.new_page(); page.set_default_timeout(10000); errors = []; dialogs = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def on_dialog(d):
            dialogs.append(d.message)
            d.accept('Cardio v2' if 'New title' in d.message else ('me@gmail.com' if 'Gmail' in d.message else None)) if d.type == 'prompt' else d.accept()
        page.on('dialog', on_dialog)
        page.goto('http://127.0.0.1:8834/')
        page.wait_for_function('!!state.user && !!window.qlPublicCfg')
        page.wait_for_timeout(5500 if SHOTS else 300)
        shot = lambda n: page.screenshot(path=f'{SHOTS}/g-{n}-{"ipad" if width > 500 else "phone"}-{theme}.png') if SHOTS else None
        invokes = lambda: page.evaluate('srv.invokes')
        no_overflow = lambda: page.evaluate("document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll('#modalBody *')].every(e=>{const r=e.getBoundingClientRect(),m=document.querySelector('#modalBody').getBoundingClientRect();return r.width===0||r.right<=m.right+1})")
        tag = f'[{width}px] '
        last_make = lambda: [c for c in invokes() if c['body']['action'] == 'make'][-1]['body']
        def bp(text):
            page.locator('#qlGfPaste').wait_for(); page.locator('#qlGfPaste').fill(text); page.locator('#qlBpParse').click()

        # 1. toolbar: right after Create Quiz, thin divider, no NEW tag, same look as the other buttons in this theme; "+ New" menu
        page.evaluate("render()")
        page.wait_for_function("document.querySelector('#newMenu [data-gform-new]')")
        order = page.evaluate("[...document.querySelectorAll('#adminQuickActions > *')].map(e=>e.dataset.quizQuick?'quiz':e.classList.contains('ql-gf-div')?'div':e.dataset.gformQuick?'gform':'other')")
        i = order.index('quiz'); assert order[i:i + 3] == ['quiz', 'div', 'gform'], order
        assert page.locator('[data-gform-quick]').inner_text().strip() == 'Make Google Form', 'no NEW tag'
        assert page.locator('#newMenu [data-gform-new]').inner_text().strip() == 'Make Google Form', 'no NEW in + New'
        # "+ New" menu: same row as the others (icon tile + label), like Create Quiz
        menu = page.evaluate("""(()=>{const g=document.querySelector('#newMenu [data-gform-new]'),q=document.querySelector('#newMenu [data-quiz-new]');
          const k=e=>{const c=getComputedStyle(e);return [c.fontSize,c.fontWeight,c.color,c.display,c.paddingLeft,c.height]};
          const t=e=>{const i=e.querySelector('.ql-mi');if(!i)return null;const c=getComputedStyle(i);return [c.width,c.height,c.borderRadius]};
          return {row:g.classList.contains('ql-mi-row'),same:JSON.stringify(k(g))===JSON.stringify(k(q)),tile:JSON.stringify(t(g))===JSON.stringify(t(q))&&!!t(g),svg:!!g.querySelector('.ql-mi svg')}})()""")
        assert menu == {'row': True, 'same': True, 'tile': True, 'svg': True}, menu
        if width > 500:
            assert page.locator('[data-gform-quick]').is_visible()
            look = page.evaluate("""(()=>{const k=e=>{const c=getComputedStyle(e);return [c.backgroundColor,c.backgroundImage,c.color,c.borderTopColor,c.borderRadius,c.boxShadow,c.height]};
              return {same:JSON.stringify(k(document.querySelector('[data-gform-quick]')))===JSON.stringify(k(document.querySelector('[data-quiz-quick]'))),
                icon:getComputedStyle(document.querySelector('[data-gform-quick] .quick-icon')).color}})()""")
            assert look['same'], 'looks like Create Quiz in the ' + theme + ' theme'
            assert look['icon'] == 'rgb(139, 92, 246)', look
            shot('0-toolbar')
        ok(tag + 'Toolbar: Make Google Form sits right after Create Quiz with a divider, no NEW tag, same look as the other buttons; also in + New')

        # 2. Make new → Paste questions = the quiz editor's Bulk Paste panel (no Destination / Position)
        page.evaluate("qlOpenGoogleForm()")
        page.locator('#qlGfPaste').wait_for()
        assert 'Forms left today: 4 of 5' in page.locator('#qlGfLeft').inner_text()
        for sel in ('#qlBpUpload', '#qlBpParse', '#qlGfKey', '[data-bp-guide="qlBpBulkGuide"]', '[data-bp-guide="qlBpKeyGuide"]', '[data-bp-guide="qlBpUploadGuide"]'):
            assert page.locator(sel).is_visible(), sel
        mk = page.locator('#qlGfSrcPaste').inner_text()
        assert 'Bulk paste questions' in mk and 'Bulk paste answer key (optional)' in mk and 'Upload file txt' in mk, mk
        assert 'Destination' not in mk and 'Position' not in mk, mk
        page.locator('[data-bp-guide="qlBpBulkGuide"]').click(); assert page.locator('#qlBpBulkGuide').is_visible(); page.locator('[data-bp-guide="qlBpBulkGuide"]').click()
        assert no_overflow(), 'empty paste pane overflows'
        shot('0b-paste-empty')
        page.locator('#qlGfPaste').fill(PASTE); page.locator('#qlGfKey').fill('3 A, B')
        assert page.locator('#qlGfMakeBtn').is_disabled() and 'Apply Answer Key' in page.locator('#qlGfParsed').inner_text()
        page.locator('#qlBpParse').click()
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('4 questions')")
        parsed = page.locator('#qlGfParsed').inner_text()
        assert '1 without an answer' in parsed, parsed  # Q2 true/false has no answer
        pv = page.locator('#qlBpPreview').inner_text()
        assert '3/4 questions ready.' in pv and 'Missing answers: 1' in pv and 'Q2' in pv and 'No question-format problems' in pv and 'Parsed Questions Preview' in pv, pv
        assert page.locator('#qlBpPreview [data-bp-item]').count() == 4
        # changing the text after the preview: Make waits for Apply again (typing it back un-does that)
        page.locator('#qlGfPaste').press('End'); page.keyboard.type('x')
        page.wait_for_function("document.querySelector('#qlBpPreview .qz-bp-stale') && document.getElementById('qlGfMakeBtn').disabled")
        page.keyboard.press('Backspace')
        page.wait_for_function("!document.querySelector('#qlBpPreview .qz-bp-stale') && !document.getElementById('qlGfMakeBtn').disabled")
        # fix the missing answer right in the preview, like in the quiz editor
        page.locator('[data-bp-tf="1"][data-val="true"]').click()
        page.wait_for_function("!document.getElementById('qlGfParsed').textContent.includes('without an answer') && document.getElementById('qlBpPreview').textContent.includes('4/4 questions ready.')")
        assert page.locator('#qlGfPics').is_hidden()
        assert 'Google Drive' in page.locator('.ql-gf-drivenote').inner_text()
        # Practice settings: Shuffle (off by default) and the View score reminder; numbers + shuffle warns
        assert page.locator('#qlGfPracOpts').is_visible() and 'View score' in page.locator('#qlGfPracOpts').inner_text()
        assert page.locator('#qlGfPShuffle').get_attribute('aria-checked') == 'false' and page.locator('#qlGfNumWarn').is_hidden()
        page.locator('#qlGfPShuffle').click(); assert page.locator('#qlGfNumWarn').is_visible()
        page.locator('#qlGfPShuffle').click(); assert page.locator('#qlGfNumWarn').is_hidden()
        page.locator('#qlGfTitle').fill('Cardio basics'); page.locator('#qlGfEmail').fill('Bona@Gmail.com')
        assert no_overflow(), 'make pane overflows'
        shot('1-make-paste')
        # progress: a percentage that goes up while Google makes the form
        page.evaluate("srv.delay=1600")
        page.locator('#qlGfMakeBtn').click()
        page.locator('#qlGfProgress').wait_for()
        assert page.locator('#qlGfMakeBtn').is_hidden() and page.locator('#qlGfSrcPaste.ql-gf-busy').count() == 1
        p1 = int(page.locator('#qlGfPct').inner_text().rstrip('%')); page.wait_for_timeout(700); p2 = int(page.locator('#qlGfPct').inner_text().rstrip('%'))
        assert 0 < p1 < p2 < 100, (p1, p2)
        stage = page.locator('#qlGfStage').inner_text()
        assert 'Adding questions' in stage or 'Checking your daily limit' in stage, stage
        assert page.locator('#qlGfProgress').get_attribute('aria-valuenow') == str(p2)
        shot('1b-progress')
        page.wait_for_function("document.getElementById('qlGfPct')?.textContent==='100%' || document.querySelector('#qlGfDone')")
        page.evaluate("srv.delay=60")
        # done: My Google Forms opens with the new form on top, highlighted, with its link
        page.locator('#qlGfDone').wait_for()
        assert page.locator('[data-gf-tab="list"].on').count() == 1
        body = last_make()
        assert body['action'] == 'make' and body['title'] == 'Cardio basics' and body['editor_email'] == 'bona@gmail.com', body
        qs = body['questions']
        assert [q['type'] for q in qs] == ['mcq', 'true_false', 'mcq', 'short_answer'], qs
        assert qs[0]['options'] == ['Mitral', 'Aortic', 'Tricuspid'] and qs[0]['correct'] == [0] and not qs[0]['multi']
        assert qs[0]['prompt'] == '1. Which valve sits between the left atrium and ventricle?' and qs[3]['prompt'] == '4. Largest artery?', 'numbered by default'
        assert body['source'] == 'paste' and not body.get('exam') and body['practice'] == {'shuffle': False}, 'a practice form'
        assert "won't see their score" not in page.locator('#qlGfDone').inner_text() if page.locator('#qlGfDone').count() else True
        assert qs[1]['correct'] is True, qs[1]
        assert qs[2]['correct'] == [0, 1] and qs[2]['multi'], qs[2]
        assert qs[3]['answers'] == ['Aorta'], qs[3]
        assert 'image' not in json.dumps(qs)
        txt = page.locator('#qlGfDone').inner_text()
        assert 'Your Google Form is ready' in txt and 'bona@gmail.com' in txt and 'short-answer' in txt and 'until you remove it' in txt, txt
        page.wait_for_function("document.querySelector('.ql-gf-card.new')")
        new = page.locator('.ql-gf-card.new')
        nt = new.inner_text()
        assert 'NEW' in nt and 'Cardio basics' in nt and 'forms.gle/' in nt and 'Made ' in nt and 'today' in nt, nt
        assert new.locator('[data-gf-act="url"]').get_attribute('href').startswith('https://forms.gle/')
        new.locator('[data-gf-act="copy"]').click()
        page.wait_for_function("document.getElementById('toast').textContent.includes('Link copied')")
        assert page.evaluate('navigator.clipboard.readText()').startswith('https://forms.gle/')
        assert page.evaluate(f"localStorage.getItem('ql_gf_email_11111111-1111-4111-8111-111111111111')") == 'bona@gmail.com'
        assert no_overflow(), 'result overflows'
        shot('2-result')
        ok(tag + 'Paste = Bulk Paste panel (upload, guides, answer key, Apply & Preview, Missing/Problem panels, fix answers in preview; no Destination/Position); progress % while making; then My Google Forms with the new form, its link, date and Copy')

        # 3. Use one of my quizzes: pictures counted and warned, text only sent
        page.evaluate("""()=>{state.items.push({id:'q-pic',kind:'quiz',title:'Histology slides',parent_id:null,library_id:LIBRARY_ID,is_trashed:false,quiz_settings:{}});
          service.getQuizQuestionsAdmin=async()=>[{id:'a',type:'mcq',prompt:'Which tissue?',image:'data:image/png;base64,AAA',options:[{text:'Epithelium',image:'data:x'},{text:'Muscle',image:null}],correct_answer:0,points:2,question_position:0},
            {id:'b',type:'true_false',prompt:'',image:'data:image/png;base64,BBB',correct_answer:false,points:1,question_position:1}]}""")
        page.locator('#qlGfAnother').click()
        page.evaluate("srv.noTpl=true")  # the practice template is missing: the student won't see the score
        page.locator('[data-gf-src="quiz"]').wait_for(); page.locator('[data-gf-src="quiz"]').click()
        page.locator('#qlGfQuiz').select_option('q-pic')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 questions')")
        assert page.locator('#qlGfTitle').input_value() == 'Histology slides'
        assert "3 pictures won't be included" in page.locator('#qlGfPics').inner_text()
        assert 'Forms left today: 3 of 5' in page.locator('#qlGfLeft').inner_text()
        shot('3-make-quiz')
        assert page.locator('[data-gf-mode="range"].on').count() == 1 and page.locator('#qlGfFrom').input_value() == '1' and page.locator('#qlGfTo').input_value() == '2', 'a short quiz starts as one whole form'
        page.locator('#qlGfMakeBtn').click(); page.locator('#qlGfDone').wait_for()
        assert "won't see their score" in page.locator('#qlGfDone').inner_text() and 'Release marks' in page.locator('#qlGfDone').inner_text()
        page.evaluate("srv.noTpl=false")
        qs = last_make()['questions']
        assert qs[0]['options'] == ['Epithelium', 'Muscle'] and qs[0]['points'] == 2 and qs[1]['prompt'].startswith('2. (Picture question') and qs[1]['correct'] is False, qs
        assert 'data:' not in json.dumps(qs)
        ok(tag + 'One of my quizzes: title filled in, pictures counted and not sent, picture-only question gets a note')

        # 3b. a quiz longer than one form: Parts (tick several, one form each) or My own range
        page.evaluate("""()=>{state.items.push({id:'q-big',kind:'quiz',title:'Big bank',parent_id:null,library_id:LIBRARY_ID,is_trashed:false,quiz_settings:{}});
          const prior=service.getQuizQuestionsAdmin;service.getQuizQuestionsAdmin=async id=>id==='q-big'?Array.from({length:450},(_,i)=>({id:'b'+i,type:'mcq',prompt:'Q'+(i+1),options:[{text:'Yes'},{text:'No'}],correct_answer:0,points:1,question_position:i})):prior(id)}""")
        page.locator('#qlGfAnother').click(); page.locator('#qlGfQuiz').wait_for()
        page.locator('[data-gf-src="quiz"]').click(); page.locator('#qlGfTitle').fill('')
        page.locator('#qlGfQuiz').select_option('q-big')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('3 forms will be made · 450 questions in total')")
        assert page.locator('#qlGfTitle').input_value() == 'Big bank' and 'each form adds its questions' in page.locator('#qlGfTitleLbl').inner_text()
        parts = [t.replace('\n', ' ') for t in page.locator('[data-gf-pt]').all_inner_texts()]
        assert parts == ['✓ Part 1 Q1–200 · 200 questions', '✓ Part 2 Q201–400 · 200 questions', '✓ Part 3 Q401–450 · 50 questions'], parts
        assert page.locator('#qlGfTitles').inner_text().count('Big bank (Q') == 3 and 'Big bank (Q401–450)' in page.locator('#qlGfTitles').inner_text()
        assert 'a form can have up to 200' in page.locator('#qlGfRange').inner_text()
        # forms left today: 2 of 5 here, so 3 ticked parts is too many
        page.wait_for_function("document.getElementById('qlGfMakeBtn').disabled && document.getElementById('qlGfStatus').textContent.includes('You can make 2 more Google Forms today — tick 2 parts or fewer')")
        assert 'Make 3 Google Forms' in page.locator('#qlGfMakeBtn').inner_text()
        page.locator('#qlGfAll').click()  # Clear all
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('Tick at least one part') && document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfAll').click()  # Select all
        page.wait_for_function("document.querySelectorAll('[data-gf-pt][aria-checked=\"true\"]').length===3")
        # My own range: From / To for one form
        page.locator('[data-gf-mode="range"]').click()
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('200 questions (1–200 of 450)')")
        assert page.locator('#qlGfTitle').input_value() == 'Big bank (Q1–200)' and page.locator('#qlGfTitles').is_hidden()
        page.locator('#qlGfTo').fill('420')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('you chose 420') && document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfFrom').fill('300'); page.locator('#qlGfTo').fill('250')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('From must not be after To') && document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfFrom').fill('401'); page.locator('#qlGfTo').fill('450')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('50 questions (401–450 of 450)') && !document.getElementById('qlGfMakeBtn').disabled")
        assert page.locator('#qlGfMakeBtn').inner_text().strip() == 'Make Google Form'
        # back to Parts: untick Part 1 → 2 forms, the button says so
        page.locator('[data-gf-mode="parts"]').click(); page.locator('#qlGfTitle').fill('Big bank')
        page.locator('[data-gf-pt="0"]').click()
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 forms will be made · 250 questions in total') && !document.getElementById('qlGfMakeBtn').disabled")
        assert 'Make 2 Google Forms' in page.locator('#qlGfMakeBtn').inner_text()
        # numbers: "Quiz numbers" keeps the quiz's own numbers (201, 202…) instead of starting at 1
        assert page.locator('#qlGfNumStart').is_visible() and page.locator('#qlGfNum').get_attribute('aria-checked') == 'true'
        page.locator('[data-gf-ns="quiz"]').click()
        titles = page.locator('#qlGfTitles').inner_text()
        assert 'Big bank (Q201–400)' in titles and 'Big bank (Q401–450)' in titles and 'Q1–200' not in titles, titles
        assert no_overflow(), 'parts overflow'
        shot('3b-parts')
        # make both, one after another, with one progress bar and a line per form
        page.evaluate("srv.delay=500")
        n0 = len(invokes())
        page.locator('#qlGfMakeBtn').click()
        page.wait_for_function("document.querySelectorAll('#qlGfProgList [data-gf-pq]').length===2")
        assert 'Form 1 of 2' in page.locator('#qlGfProgress').inner_text()
        page.wait_for_function("document.querySelector('[data-gf-pq=\"0\"]').classList.contains('ok') && document.getElementById('qlGfProgress').textContent.includes('Form 2 of 2')")
        shot('3c-making-two')
        page.locator('#qlGfDone').wait_for(); page.evaluate("srv.delay=60")
        made = [c['body'] for c in invokes()[n0:] if c['body']['action'] in ('make', 'add', 'discard')]
        assert [m['action'] for m in made] == ['make'] + ['add'] * 6 + ['make', 'add'], [m['action'] for m in made]
        assert made[0]['title'] == 'Big bank (Q201–400)' and made[0]['questions'][0]['prompt'] == '201. Q201' and len(made[0]['questions']) == 200 and made[0]['chunked'] is True
        assert made[7]['title'] == 'Big bank (Q401–450)' and len(made[7]['questions']) == 50 and made[8]['questions'][0]['prompt'] == '431. Q431' and made[8]['last'] is True
        assert 'part' not in made[0], 'the part number stays in the app'
        assert '2 Google Forms are ready' in page.locator('#qlGfDone').inner_text()
        page.wait_for_function("document.querySelectorAll('.ql-gf-card.new').length===2")
        news = page.locator('.ql-gf-card.new').all_inner_texts()
        assert any('Big bank (Q201–400)' in t for t in news) and any('Big bank (Q401–450)' in t for t in news), news
        shot('3d-two-ready')
        # the second form fails twice: the first one is kept, only the rest stays ticked, the half-made one is discarded
        page.locator('#qlGfDoneX').click(); assert page.locator('#qlGfDone').count() == 0, 'the ready banner can be closed'
        page.evaluate("srv.limit=20;srv.used=0;srv.failAddAt='Q431'")
        page.locator('[data-gf-tab="make"]').click(); page.locator('#qlGfQuiz').wait_for(); page.locator('[data-gf-src="quiz"]').click()
        page.locator('#qlGfQuiz').select_option('q-big')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('3 forms will be made')")
        page.locator('[data-gf-pt="1"]').click()
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 forms will be made')")
        page.locator('#qlGfMakeBtn').click()
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('Form 2 of 2')")
        stx = page.locator('#qlGfStatus').inner_text()
        assert "didn't work" in stx and 'Google stopped after 30 of 50 questions' in stx and 'half-made form was removed' in stx and 'in My Google Forms' in stx, stx
        tail = [c['body']['action'] for c in invokes() if c['body']['action'] in ('make', 'add', 'discard')][-4:]
        assert tail == ['make', 'add', 'add', 'discard'], tail
        assert page.locator('[data-gf-pt][aria-checked="true"]').count() == 1 and page.locator('[data-gf-pt="2"]').get_attribute('aria-checked') == 'true', 'only the part that failed stays ticked'
        assert page.locator('#qlGfMakeBtn').inner_text().strip() == 'Make Google Form' and not page.locator('#qlGfMakeBtn').is_disabled(), 'can try the rest again'
        page.evaluate("srv.failAddAt=null;srv.limit=5;srv.used=3")
        ok(tag + 'Long quiz: Parts with tick boxes (Select / Clear all, one form each, titles listed, forms-left check) or My own range; several forms made one after another with a line each; a failing form keeps the ones before it and stays ticked to try again')

        # 3e. Exam tab (before My Google Forms): student fields, exam rules, numbering; same questions as Practice
        tabs = [t.replace('\n', ' ').strip() for t in page.locator('[data-gf-tab]').all_inner_texts()]
        assert tabs == ['Practice', 'Exam', 'My Google Forms'], tabs
        assert page.locator('#qlGfExamOpts').is_hidden()
        page.locator('[data-gf-tab="exam"]').click()
        page.locator('#qlGfExamOpts').wait_for()
        assert page.locator('#qlGfPracOpts').is_hidden(), 'practice settings only in Practice'
        assert 'students give their name and ID' in page.locator('#qlGfLead').inner_text()
        flds = [t.replace('\n', ' ') for t in page.locator('.ql-gf-fld').all_inner_texts()]
        assert flds == ['✓ Full name REQUIRED', '✓ Student ID REQUIRED', '✓ Class / Group REQUIRED', 'Phone number'], flds
        assert page.locator('[data-gf-rule][aria-checked="true"]').count() == 4
        assert page.locator('#qlGfNumWarn').is_visible(), 'numbers + shuffle: warned'
        page.locator('[data-gf-rule="shuffle"]').click()
        assert page.locator('#qlGfNumWarn').is_hidden()
        page.locator('#qlGfNewField').fill('Seat number'); page.locator('#qlGfAddField').click()
        page.locator('[data-gf-fld="2"]').click()  # Class / Group off
        page.locator('[data-gf-src="paste"]').click(); bp(PASTE)
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('4 questions')")
        assert page.locator('#qlGfTitleLbl').inner_text() == 'Exam title' and 'Make exam form' in page.locator('#qlGfMakeBtn').inner_text()
        assert 'exam' in page.locator('#qlGfMakeBtn').get_attribute('class') and page.locator('#qlGfNumStart').is_hidden(), 'quiz numbers only for quizzes'
        # Practice and Exam share the questions; only the extras change
        page.locator('[data-gf-tab="make"]').click(); assert page.locator('#qlGfExamOpts').is_hidden() and page.locator('#qlGfPaste').input_value() == PASTE
        assert 'Make Google Form' in page.locator('#qlGfMakeBtn').inner_text()
        page.locator('[data-gf-tab="exam"]').click(); page.locator('#qlGfExamOpts').wait_for()
        page.locator('#qlGfTitle').fill('Cardio final exam')
        assert no_overflow(), 'exam pane overflows'
        shot('3e-exam')
        page.locator('#qlGfMakeBtn').click(); page.locator('#qlGfDone').wait_for()
        body = last_make()
        assert body['source'] == 'exam_paste' and body['title'] == 'Cardio final exam' and 'practice' not in body, body
        assert body['exam'] == {'fields': ['Full name', 'Student ID', 'Seat number'], 'one_response': True, 'collect_email': True, 'shuffle': False, 'lock': True}, body['exam']
        assert 'submit only once' in body['description'] and body['questions'][0]['prompt'].startswith('1. ')
        dn = page.locator('#qlGfDone').inner_text()
        assert 'Your exam form is ready' in dn and 'Stop accepting answers' in dn, dn
        page.wait_for_function("document.querySelector('.ql-gf-card.new')?.textContent.includes('EXAM')")
        # filter: All / Practice / Exam
        page.locator('#qlGfKinds').wait_for()
        page.locator('[data-gf-lk="exam"]').click()
        page.wait_for_function("[...document.querySelectorAll('#qlGfItems .ql-gf-card')].every(c=>c.textContent.includes('EXAM')) && document.querySelectorAll('#qlGfItems .ql-gf-card').length===1")
        page.locator('[data-gf-lk="practice"]').click()
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===8 && [...document.querySelectorAll('#qlGfItems .ql-gf-card')].every(c=>c.textContent.includes('PRACTICE'))")
        page.locator('[data-gf-lk="all"]').click()
        shot('3f-exam-list')
        # remembered on this device
        assert page.evaluate("JSON.parse(localStorage.getItem('ql_gf_exam_11111111-1111-4111-8111-111111111111')).fields.length") == 5
        ok(tag + 'Exam tab before My Google Forms: student fields (+ own), rules, numbers + shuffle warning; sends the exam settings; EXAM tag and All / Practice / Exam filter')

        # 3g. Parts: choose how many questions go in each part (typed, quick sizes, Half), checked against the max
        page.evaluate("""()=>{state.items.push({id:'q-mid',kind:'quiz',title:'Anatomopathology',parent_id:null,library_id:LIBRARY_ID,is_trashed:false,quiz_settings:{}});
          const prior=service.getQuizQuestionsAdmin;service.getQuizQuestionsAdmin=async id=>id==='q-mid'?Array.from({length:227},(_,i)=>({id:'m'+i,type:'mcq',prompt:'M'+(i+1),options:[{text:'Yes'},{text:'No'}],correct_answer:0,points:1,question_position:i})):prior(id)}""")
        page.evaluate("srv.limit=50;srv.used=0")
        page.locator('[data-gf-tab="make"]').click(); page.locator('[data-gf-src="quiz"]').wait_for(); page.locator('[data-gf-src="quiz"]').click()
        page.locator('#qlGfQuiz').wait_for(); page.locator('#qlGfTitle').fill('')
        page.locator('#qlGfQuiz').select_option('q-mid')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 forms will be made · 227 questions in total')")
        assert page.locator('#qlGfPartSize').input_value() == '200'
        chips = page.locator('#qlGfChips button').all_inner_texts()
        assert chips == ['25', '50', '100', '200', 'Half (114)'], chips
        page.locator('#qlGfPartSize').fill('50')
        page.wait_for_function("document.querySelectorAll('[data-gf-pt]').length===5 && document.getElementById('qlGfParsed').textContent.includes('5 forms will be made')")
        assert page.evaluate("document.activeElement.id") == 'qlGfPartSize', 'typing keeps the cursor in the box'
        parts = [t.replace('\n', ' ') for t in page.locator('[data-gf-pt]').all_inner_texts()]
        assert parts[0].endswith('Q1–50 · 50 questions') and parts[-1].endswith('Q201–227 · 27 questions'), parts
        assert page.locator('#qlGfChips button.on').inner_text() == '50'
        page.locator('[data-gf-pt="2"]').click(); page.locator('[data-gf-pt="4"]').click()
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('3 forms will be made · 150 questions in total')")
        titles = page.locator('#qlGfTitles').inner_text()
        assert 'Anatomopathology (Q1–50)' in titles and 'Anatomopathology (Q151–200)' in titles and 'Q101–150' not in titles, titles
        assert 'Make 3 Google Forms' in page.locator('#qlGfMakeBtn').inner_text()
        shot('3g-size')
        page.locator('#qlGfPartSize').fill('250')
        page.wait_for_function("!document.getElementById('qlGfSizeErr').classList.contains('hidden') && document.getElementById('qlGfMakeBtn').disabled")
        assert 'Type 1–200' in page.locator('#qlGfSizeErr').inner_text() and page.locator('[data-gf-pt]').count() == 0
        page.locator('#qlGfPartSize').fill('0')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('Type how many questions go in each part') && document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfChips button', has_text='Half').click()
        page.wait_for_function("document.querySelectorAll('[data-gf-pt]').length===2 && document.getElementById('qlGfSizeErr').classList.contains('hidden')")
        assert page.locator('#qlGfPartSize').input_value() == '114' and not page.locator('#qlGfMakeBtn').is_disabled()
        parts = [t.replace('\n', ' ') for t in page.locator('[data-gf-pt]').all_inner_texts()]
        assert parts[0].endswith('Q1–114 · 114 questions') and parts[1].endswith('Q115–227 · 113 questions'), parts
        assert page.evaluate("JSON.parse(localStorage.getItem('ql_gf_exam_11111111-1111-4111-8111-111111111111')).partSize") == 114, 'remembered'
        page.locator('#qlGfChips button', has_text='200').click()
        assert no_overflow(), 'size row overflows'
        page.evaluate("srv.limit=5;srv.used=3")
        ok(tag + 'Parts: Questions per part (typed or quick 25/50/100/max/Half), parts redraw while typing, too big or 0 explained, size remembered')

        # 3h. Paste questions: more than one form's worth → the same Parts / My own range as quizzes
        page.evaluate("srv.limit=50;srv.used=0")
        page.locator('[data-gf-tab="make"]').click(); page.locator('[data-gf-src="paste"]').wait_for(); page.locator('[data-gf-src="paste"]').click()
        many = '\n\n'.join(f'{i}. Pasted question {i}?\nA) Yes\nB) No\nAnswer: A' for i in range(1, 301))
        page.locator('#qlGfKey').fill(''); bp(many)
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 forms will be made · 300 questions in total')")
        assert page.locator('#qlBpPreview .qz-bp-max').count() == 0, 'no "too many" block any more'
        assert 'You pasted 300 questions — a form can have up to 200' in page.locator('#qlGfRange').inner_text()
        parts = [t.replace('\n', ' ') for t in page.locator('[data-gf-pt]').all_inner_texts()]
        assert parts[0].endswith('Q1–200 · 200 questions') and parts[1].endswith('Q201–300 · 100 questions'), parts
        page.locator('#qlGfTitle').fill('Cardio bank')
        page.locator('#qlGfPartSize').fill('100')
        page.wait_for_function("document.querySelectorAll('[data-gf-pt]').length===3 && document.getElementById('qlGfParsed').textContent.includes('3 forms will be made')")
        titles = page.locator('#qlGfTitles').inner_text()
        assert 'Cardio bank (Q1–100)' in titles and 'Cardio bank (Q201–300)' in titles, titles
        assert page.locator('#qlGfNumStart').is_visible() and 'Make 3 Google Forms' in page.locator('#qlGfMakeBtn').inner_text()
        # My own range on the pasted list: a single form, From / To checked against the max
        page.locator('[data-gf-mode="range"]').click(); page.locator('#qlGfFrom').fill('101'); page.locator('#qlGfTo').fill('150')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('50 questions (101–150 of 300)') && !document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfTo').fill('301')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('Choose questions from 1 to 300') && document.getElementById('qlGfMakeBtn').disabled")
        page.locator('[data-gf-mode="parts"]').click(); page.locator('#qlGfChips button', has_text='200').click()
        assert no_overflow(), 'paste parts overflow'
        shot('3h-paste-parts')
        page.evaluate("srv.limit=5;srv.used=3")
        ok(tag + 'Paste questions: more than one form → Parts (Questions per part, ticks, titles) or My own range, like quizzes; no "too many" block')

        # 4. My Google Forms: groups, status, search, menu actions, Drive bar
        page.locator('[data-gf-tab="list"]').click()
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===9")
        page.wait_for_function("document.getElementById('qlGfItems').textContent.includes('12 responses')")
        groups = [g.lower() for g in page.locator('#qlGfItems .ql-sa-gh').all_inner_texts()]
        assert groups == ['today', 'this week', 'older'], groups
        c2 = page.locator('[data-gf-id="r2"]').inner_text()
        assert 'Closed' in c2 and '31 responses' in c2 and '60 questions' in c2 and 'bona@gmail.com' in c2, c2
        assert 'Deleted in Google' in page.locator('[data-gf-id="r3"]').inner_text()
        assert page.locator('[data-gf-id="r1"] [data-gf-act="responses"]').get_attribute('href') == 'https://docs.google.com/forms/d/F1/edit#responses'
        assert page.locator('#qlGfOpenDrive').get_attribute('href') == 'https://drive.google.com/drive/folders/D1'
        assert no_overflow(), 'list overflows'
        shot('4-list')
        page.locator('#qlGfSearch').fill('cardio')
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===3")
        page.locator('#qlGfSearch').fill('')
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===9")
        c3 = page.locator('[data-gf-id="r3"]').inner_text()
        assert 'Made ' in c3 and '20 days ago' in c3 and 'forms.gle/F3' in c3, c3
        page.locator('[data-gf-id="r1"] [data-gf-act="menu"]').click()
        page.locator('.ql-gf-menu').wait_for()
        shot('5-menu')
        assert 'Stop accepting answers' in page.locator('.ql-gf-menu').inner_text()
        page.locator('[data-gf-m="accept"]').click()
        page.wait_for_function("srv.invokes.some(c=>c.body.action==='accepting'&&c.body.id==='r1'&&c.body.accepting===false)")
        page.wait_for_function("document.querySelector('[data-gf-id=\"r1\"]').textContent.includes('Closed')")
        page.locator('[data-gf-id="r2"] [data-gf-act="menu"]').click(); page.locator('[data-gf-m="rename"]').click()
        page.wait_for_function("document.querySelector('[data-gf-id=\"r2\"]').textContent.includes('Cardio v2')")
        page.locator('[data-gf-id="r3"] [data-gf-act="menu"]').click(); page.locator('[data-gf-m="gmail"]').click()
        page.wait_for_function("srv.invokes.some(c=>c.body.action==='share'&&c.body.email==='me@gmail.com')")
        page.wait_for_function("document.querySelector('[data-gf-id=\"r3\"]').textContent.includes('me@gmail.com')")
        page.locator('[data-gf-id="r3"] [data-gf-act="menu"]').click(); page.locator('[data-gf-m="remove"]').click()
        page.wait_for_function("!document.querySelector('[data-gf-id=\"r3\"]')")
        assert any('stays in Google Drive' in d for d in dialogs), dialogs
        ok(tag + 'My Google Forms: Today/This week/Older, Open/Closed + responses, search, Responses link, Drive bar; Stop/Rename/Add Gmail/Remove work')

        # 5. limits and errors
        page.evaluate("srv.used=5;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('[data-gf-src="paste"]').click()  # the window remembers the last source (a quiz, from step 3)
        bp(PASTE)
        page.wait_for_function("document.getElementById('qlGfMakeBtn').disabled && document.getElementById('qlGfStatus').textContent.includes('more tomorrow')")
        page.evaluate("srv.used=1;srv.fail='Google did not answer. Please try again.';try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        bp(PASTE); page.locator('#qlGfEmail').fill('not-an-email')
        page.wait_for_function("!document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfMakeBtn').click()
        assert "doesn't look right" in page.locator('#qlGfStatus').inner_text()
        page.locator('#qlGfEmail').fill(''); page.locator('#qlGfMakeBtn').click()
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('Google did not answer')")
        assert not page.locator('#qlGfMakeBtn').is_disabled(), 'can try again'
        # Supabase's own time limit: a plain sentence instead of "Edge Function returned a non-2xx status code"
        page.evaluate("srv.fail=null;srv.httpFail=546"); page.locator('#qlGfMakeBtn').click()
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('took too long')")
        assert 'non-2xx' not in page.locator('#qlGfStatus').inner_text()
        page.evaluate("srv.httpFail=0")
        # per-person limits set by Admin: Unlimited (safety cap), a custom number, 0 = off
        page.evaluate("srv.fail=null;srv.mode='unlimited';srv.used=3;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('[data-gf-src="paste"]').click(); bp(PASTE)
        page.wait_for_function("document.getElementById('qlGfLeft').textContent.includes('Unlimited')")
        assert page.locator('.ql-gf-unl').count() == 1 and page.locator('.ql-gf-dots').count() == 0
        shot('6-unlimited')
        page.locator('#qlGfMakeBtn').click(); page.locator('#qlGfDone .ql-gf-ok').wait_for()
        assert 'Forms left today: Unlimited' in page.locator('#qlGfDone .ql-gf-ok').inner_text()
        page.evaluate("srv.used=100;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        bp(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('100 Google Forms today, the safety limit') && document.getElementById('qlGfMakeBtn').disabled")
        page.evaluate("srv.mode='custom';srv.limit=12;srv.used=2;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.wait_for_function("document.getElementById('qlGfLeft')?.textContent.includes('Forms left today: 10 of 12')")
        # the plan's numbers (Admin → Plans): "3 of 10 (Pro plan)" and questions per form
        page.evaluate("srv.mode='plan';srv.planName='Pro';srv.limit=10;srv.used=7;srv.maxQ=3;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.wait_for_function("document.getElementById('qlGfLeft')?.textContent.includes('Forms left today: 3 of 10 (Pro plan)')")
        page.locator('[data-gf-src="paste"]').click(); bp(PASTE)
        # more pasted questions than the plan allows per form: Parts of the plan's size (3 + 1) instead of a block
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 forms will be made · 4 questions in total') && !document.getElementById('qlGfMakeBtn').disabled")
        assert 'You pasted 4 questions — a form can have up to 3' in page.locator('#qlGfRange').inner_text() and page.locator('#qlGfPartSize').get_attribute('max') == '3'
        page.locator('[data-gf-mode="range"]').click(); page.locator('#qlGfTo').fill('4')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('Your plan allows 3 questions per form — you chose 4') && document.getElementById('qlGfMakeBtn').disabled")
        shot('7-plan')
        bp(PASTE.split('\n\n4.')[0])
        page.wait_for_function("!document.getElementById('qlGfMakeBtn').disabled && document.getElementById('qlGfStatus').classList.contains('hidden')")
        page.evaluate("srv.limit=0;srv.used=0;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        bp(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('Your plan does not include Google Forms')")
        page.evaluate("srv.mode='custom';srv.planName=null;srv.maxQ=200")
        ok(tag + 'Plan limits: "3 of 10 (Pro plan)", questions per form blocks with a clear message, plan 0 says the plan has no Google Forms')
        page.evaluate("srv.limit=0;srv.used=0;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        bp(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('turned off for your account') && document.getElementById('qlGfMakeBtn').disabled")
        page.evaluate("srv.mode='default';srv.limit=5;srv.used=1")
        ok(tag + 'Per-person limits: Unlimited shows ∞ and the safety cap, a custom number shows X of Y, 0 says it is off')
        page.evaluate("srv.fail=null;srv.setUp=false;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.wait_for_function("document.getElementById('qlGfMake').textContent.includes(\"isn't ready yet\")")
        page.evaluate("srv.setUp=true;try{closeModal()}catch(e){}")
        ok(tag + 'Daily limit reached, bad Gmail, Google error (can retry), Supabase time limit and not-set-up all say what to do')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
