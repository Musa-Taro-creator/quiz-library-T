"""Make Google Form in the student app: toolbar button (after Create Quiz, NEW tag), Make new
(paste with Bulk Paste formats + answer key, or one of my quizzes), picture warning, forms
left today, result links, and My Google Forms (groups, search, status, menu actions, Drive).

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
 make:b=>{if(srv.fail)return {ok:false,error:srv.fail};srv.used++;const id='F'+(srv.forms.length+10);const f={id:'r'+id,title:b.title,question_count:b.questions.length,form_id:id,responder_url:'https://forms.gle/'+id,edit_url:'https://docs.google.com/forms/d/'+id+'/edit',folder_url:'https://drive.google.com/drive/folders/D1',owner_email:'quizlibrary.forms@gmail.com',editor_email:b.editor_email||null,accepting:true,created_at:new Date().toISOString()};
   const unl=srv.mode==='unlimited'||srv.mode==='admin';srv.forms.unshift(f);return {ok:true,form:f,unlimited:unl,left:(unl?srv.cap:srv.limit)-srv.used,limit:unl?null:srv.limit,editor_error:'',no_answer:b.questions.filter(q=>q.type==='mcq'&&q.correct.some(c=>c<0)).length,short_answers:b.questions.filter(q=>q.type==='short_answer').length}},
 status:()=>({ok:true,forms:{F1:{accepting:true,responses:12,title:'x'},F2:{accepting:false,responses:31,title:'x'},F3:{missing:true}}}),
 rename:b=>{const f=srv.forms.find(x=>x.id===b.id);f.title=b.title;return {ok:true,title:b.title}},
 accepting:b=>({ok:true,accepting:b.accepting}),share:b=>({ok:true,editor_email:b.email,folder_url:'https://drive.google.com/drive/folders/D1'})
};
const realFactory=window.supabase.createClient;
window.supabase.createClient=(...a)=>{const c=realFactory(...a),rpc=c.rpc;
 c.rpc=async(name,args)=>{srv.calls.push({name,args:JSON.parse(JSON.stringify(args||{}))});
  if(name in answers)return {data:answers[name](args||{}),error:null};return rpc(name,args)};
 c.functions={invoke:async(name,o)=>{srv.invokes.push({name,body:JSON.parse(JSON.stringify(o.body))});await new Promise(r=>setTimeout(r,60));return {data:fn[o.body.action](o.body),error:null}}};
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

        # 1. toolbar: right after Create Quiz, thin divider, NEW tag (tablet); "+ New" menu (all sizes)
        page.evaluate("render()")
        page.wait_for_function("document.querySelector('#newMenu [data-gform-new]')")
        order = page.evaluate("[...document.querySelectorAll('#adminQuickActions > *')].map(e=>e.dataset.quizQuick?'quiz':e.classList.contains('ql-gf-div')?'div':e.dataset.gformQuick?'gform':'other')")
        i = order.index('quiz'); assert order[i:i + 3] == ['quiz', 'div', 'gform'], order
        assert 'NEW' in page.locator('[data-gform-quick]').inner_text()
        if width > 500:
            assert page.locator('[data-gform-quick]').is_visible()
            bg = page.evaluate("getComputedStyle(document.querySelector('[data-gform-quick]')).backgroundImage")
            assert 'gradient' in bg, bg
            shot('0-toolbar')
        ok(tag + 'Toolbar: Make Google Form sits right after Create Quiz with a divider and a NEW tag; also in + New')

        # 2. Make new from pasted questions (Bulk Paste formats + answer key), picture-free text
        page.evaluate("qlOpenGoogleForm()")
        page.locator('#qlGfPaste').wait_for()
        assert 'Forms left today: 4 of 5' in page.locator('#qlGfLeft').inner_text()
        page.locator('#qlGfPaste').fill(PASTE)
        page.locator('#qlGfMake summary').click(); page.locator('#qlGfKey').fill('3 A, B')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('4 questions')")
        parsed = page.locator('#qlGfParsed').inner_text()
        assert '1 without an answer' in parsed, parsed  # Q2 true/false has no answer
        assert page.locator('#qlGfPics').is_hidden()
        page.locator('#qlGfTitle').fill('Cardio basics'); page.locator('#qlGfEmail').fill('Bona@Gmail.com')
        assert no_overflow(), 'make pane overflows'
        shot('1-make-paste')
        page.locator('#qlGfMakeBtn').click()
        page.locator('.ql-gf-ok').wait_for()
        body = invokes()[-1]['body']
        assert body['action'] == 'make' and body['title'] == 'Cardio basics' and body['editor_email'] == 'bona@gmail.com', body
        qs = body['questions']
        assert [q['type'] for q in qs] == ['mcq', 'true_false', 'mcq', 'short_answer'], qs
        assert qs[0]['options'] == ['Mitral', 'Aortic', 'Tricuspid'] and qs[0]['correct'] == [0] and not qs[0]['multi']
        assert qs[2]['correct'] == [0, 1] and qs[2]['multi'], qs[2]
        assert qs[3]['answers'] == ['Aorta'], qs[3]
        assert 'image' not in json.dumps(qs)
        txt = page.locator('#qlGfMake').inner_text()
        assert 'Your Google Form is ready' in txt and 'bona@gmail.com' in txt and 'short-answer' in txt, txt
        assert page.locator('#qlGfLink').input_value().startswith('https://forms.gle/')
        assert page.locator('#qlGfEdit').input_value().endswith('/edit')
        page.locator('[data-gf-copy="qlGfLink"]').click()
        page.wait_for_function("document.getElementById('toast').textContent.includes('Link copied')")
        assert page.evaluate('navigator.clipboard.readText()').startswith('https://forms.gle/')
        assert page.evaluate(f"localStorage.getItem('ql_gf_email_11111111-1111-4111-8111-111111111111')") == 'bona@gmail.com'
        assert no_overflow(), 'result overflows'
        shot('2-result')
        ok(tag + 'Paste (Bulk Paste formats + answer key) makes a form: right types, answers, multi-select, Gmail; result has student + edit links with Copy')

        # 3. Use one of my quizzes: pictures counted and warned, text only sent
        page.evaluate("""()=>{state.items.push({id:'q-pic',kind:'quiz',title:'Histology slides',parent_id:null,library_id:LIBRARY_ID,is_trashed:false,quiz_settings:{}});
          service.getQuizQuestionsAdmin=async()=>[{id:'a',type:'mcq',prompt:'Which tissue?',image:'data:image/png;base64,AAA',options:[{text:'Epithelium',image:'data:x'},{text:'Muscle',image:null}],correct_answer:0,points:2,question_position:0},
            {id:'b',type:'true_false',prompt:'',image:'data:image/png;base64,BBB',correct_answer:false,points:1,question_position:1}]}""")
        page.locator('#qlGfAnother').click()
        page.locator('[data-gf-src="quiz"]').click()
        page.locator('#qlGfQuiz').select_option('q-pic')
        page.wait_for_function("document.getElementById('qlGfParsed').textContent.includes('2 questions')")
        assert page.locator('#qlGfTitle').input_value() == 'Histology slides'
        assert "3 pictures won't be included" in page.locator('#qlGfPics').inner_text()
        assert 'Forms left today: 3 of 5' in page.locator('#qlGfLeft').inner_text()
        shot('3-make-quiz')
        page.locator('#qlGfMakeBtn').click(); page.locator('.ql-gf-ok').wait_for()
        qs = invokes()[-1]['body']['questions']
        assert qs[0]['options'] == ['Epithelium', 'Muscle'] and qs[0]['points'] == 2 and qs[1]['prompt'].startswith('(Picture question') and qs[1]['correct'] is False, qs
        assert 'data:' not in json.dumps(qs)
        ok(tag + 'One of my quizzes: title filled in, pictures counted and not sent, picture-only question gets a note')

        # 4. My Google Forms: groups, status, search, menu actions, Drive bar
        page.locator('#qlGfSeeAll').click()
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===5")
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
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===2")
        page.locator('#qlGfSearch').fill('')
        page.wait_for_function("document.querySelectorAll('#qlGfItems .ql-gf-card').length===5")
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
        page.locator('#qlGfPaste').wait_for(); page.locator('#qlGfPaste').fill(PASTE)
        page.wait_for_function("document.getElementById('qlGfMakeBtn').disabled && document.getElementById('qlGfStatus').textContent.includes('more tomorrow')")
        page.evaluate("srv.used=1;srv.fail='Google did not answer. Please try again.';try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('#qlGfPaste').wait_for(); page.locator('#qlGfPaste').fill(PASTE); page.locator('#qlGfEmail').fill('not-an-email')
        page.wait_for_function("!document.getElementById('qlGfMakeBtn').disabled")
        page.locator('#qlGfMakeBtn').click()
        assert "doesn't look right" in page.locator('#qlGfStatus').inner_text()
        page.locator('#qlGfEmail').fill(''); page.locator('#qlGfMakeBtn').click()
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('Google did not answer')")
        assert not page.locator('#qlGfMakeBtn').is_disabled(), 'can try again'
        # per-person limits set by Admin: Unlimited (safety cap), a custom number, 0 = off
        page.evaluate("srv.fail=null;srv.mode='unlimited';srv.used=3;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('[data-gf-src="paste"]').click(); page.locator('#qlGfPaste').fill(PASTE)
        page.wait_for_function("document.getElementById('qlGfLeft').textContent.includes('Unlimited')")
        assert page.locator('.ql-gf-unl').count() == 1 and page.locator('.ql-gf-dots').count() == 0
        shot('6-unlimited')
        page.locator('#qlGfMakeBtn').click(); page.locator('.ql-gf-ok').wait_for()
        assert 'Forms left today: Unlimited' in page.locator('.ql-gf-ok').inner_text()
        page.evaluate("srv.used=100;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('#qlGfPaste').fill(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('100 Google Forms today, the safety limit') && document.getElementById('qlGfMakeBtn').disabled")
        page.evaluate("srv.mode='custom';srv.limit=12;srv.used=2;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.wait_for_function("document.getElementById('qlGfLeft')?.textContent.includes('Forms left today: 10 of 12')")
        # the plan's numbers (Admin → Plans): "3 of 10 (Pro plan)" and questions per form
        page.evaluate("srv.mode='plan';srv.planName='Pro';srv.limit=10;srv.used=7;srv.maxQ=3;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.wait_for_function("document.getElementById('qlGfLeft')?.textContent.includes('Forms left today: 3 of 10 (Pro plan)')")
        page.locator('[data-gf-src="paste"]').click(); page.locator('#qlGfPaste').fill(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('Your plan allows 3 questions per form — this list has 4') && document.getElementById('qlGfMakeBtn').disabled")
        shot('7-plan')
        page.locator('#qlGfPaste').fill(PASTE.split('\n\n4.')[0])
        page.wait_for_function("!document.getElementById('qlGfMakeBtn').disabled && document.getElementById('qlGfStatus').classList.contains('hidden')")
        page.evaluate("srv.limit=0;srv.used=0;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('#qlGfPaste').fill(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('Your plan does not include Google Forms')")
        page.evaluate("srv.mode='custom';srv.planName=null;srv.maxQ=200")
        ok(tag + 'Plan limits: "3 of 10 (Pro plan)", questions per form blocks with a clear message, plan 0 says the plan has no Google Forms')
        page.evaluate("srv.limit=0;srv.used=0;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.locator('#qlGfPaste').fill(PASTE)
        page.wait_for_function("document.getElementById('qlGfStatus').textContent.includes('turned off for your account') && document.getElementById('qlGfMakeBtn').disabled")
        page.evaluate("srv.mode='default';srv.limit=5;srv.used=1")
        ok(tag + 'Per-person limits: Unlimited shows ∞ and the safety cap, a custom number shows X of Y, 0 says it is off')
        page.evaluate("srv.fail=null;srv.setUp=false;try{closeModal()}catch(e){}"); page.evaluate("qlOpenGoogleForm()")
        page.wait_for_function("document.getElementById('qlGfMake').textContent.includes(\"isn't ready yet\")")
        page.evaluate("srv.setUp=true;try{closeModal()}catch(e){}")
        ok(tag + 'Daily limit reached, bad Gmail, Google error (can retry) and not-set-up all say what to do')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
