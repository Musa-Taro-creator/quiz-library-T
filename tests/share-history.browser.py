"""Share history and saved Quiz IDs: the History / Saved IDs tabs in "Shared with me",
the saved-ID chips in the Share window, and quizzes using the same internal share.

Real index.html in Chromium with a simulated Supabase (stub from the password-recovery
test); checks the screen and the exact server calls. No network.
"""
from pathlib import Path
import re, json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
BASE = re.search(r"STUB = r'''(.*?)'''", (ROOT / 'tests/password-recovery.browser.py').read_text(), re.S).group(1)
SESSION = """sessionStorage.setItem('local-recovery-session',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',
 email:'audit@example.test',app_metadata:{provider:'email'},user_metadata:{full_name:'Local test'}},expires_at:Math.floor(Date.now()/1000)+3600}));"""
SERVER = r'''
window.srv={calls:[],contacts:[{share_id:'QL-FRIEND01',display_name:'Friend Student',share_count:2,last_shared_at:'2026-11-09T08:00:00Z',saved_at:'2026-11-01T08:00:00Z'}]};
const plans=[{id:'free',name:'Free',is_default:true,visibility:'public',sort:10,color:'#94a3b8',price_month:0,limits:{},features:{}}];
const answers={
 ql_public_config:()=>({plans,settings:{features:{},site:{open:true}},server_time:new Date().toISOString()}),
 ql_my_plan:()=>({plan:plans[0],subscription:null,usage:{quizzes:0,pdfs:0,links:0,folders:0,storage_bytes:0}}),
 ql_support_mine:()=>[],ql_support_unread:()=>0,
 ql_find_student_by_share_id:a=>[{share_id:a.p_share_id,display_name:a.p_share_id==='QL-FRIEND01'?'Friend Student':'Other Student'}],
 ql_ensure_share_profile:()=>({share_id:'QL-MINE0001',display_name:'Local test'}),
 ql_send_item_share:()=>'share-1',ql_finish_item_share:()=>true,
 ql_my_gifts:()=>[],ql_my_greeting:()=>null,ql_my_payments:()=>[],ql_received_item_share_count:()=>0,ql_received_item_shares:()=>[],
 ql_received_quiz_share_count:()=>0,ql_received_quiz_shares:()=>[],
 ql_share_contacts:()=>srv.contacts.slice(),
 ql_forget_share_contact:a=>{srv.contacts=srv.contacts.filter(c=>c.share_id!==a.p_share_id);return null},
 ql_save_share_contact:a=>{const c={share_id:a.p_share_id,display_name:'Saved Person',share_count:0,last_shared_at:null,saved_at:new Date().toISOString()};srv.contacts.unshift(c);return {share_id:c.share_id,display_name:c.display_name}},
 ql_share_history:()=>[
  {share_record_id:'h1',direction:'sent',kind:'quiz',title:'Anatomy quiz',item_count:1,person_name:'Friend Student',person_share_id:'QL-FRIEND01',status:'saved',created_at:'2026-11-09T08:00:00Z'},
  {share_record_id:'h2',direction:'received',kind:'pdf',title:'Lecture 3',item_count:1,person_name:'Kuza',person_share_id:'QL-KUZA0001',status:'pending',created_at:'2026-11-08T08:00:00Z'}]
};
const realFactory=window.supabase.createClient;
window.supabase.createClient=(...a)=>{const c=realFactory(...a),rpc=c.rpc;
 c.rpc=async(name,args)=>{srv.calls.push({name,args:JSON.parse(JSON.stringify(args||{}))});
  if(name in answers)return {data:answers[name](args||{}),error:null};return rpc(name,args)};return c};
'''
checks = []
def ok(s): checks.append(s); print('PASS:', s, flush=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for width in (1024, 390):
        context = browser.new_context(viewport={'width': width, 'height': 820}, service_workers='block')
        context.add_init_script(SESSION + BASE + SERVER)
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8832/'):
                sub = url.split('8832/', 1)[1].split('?', 1)[0]
                if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
                else: r.fulfill(status=404, body='')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
            else: r.abort()
        context.route('**/*', route)
        page = context.new_page(); page.set_default_timeout(10000); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        page.goto('http://127.0.0.1:8832/')
        page.wait_for_function('!!state.user && !!window.qlPublicCfg')
        calls = lambda name: page.evaluate('(n)=>srv.calls.filter(c=>c.name===n).map(c=>c.args)', name)
        tag = f'[{width}px] '

        # 1. a quiz uses the same internal share window, with saved-ID chips; tapping one picks that person
        page.evaluate("""()=>{const q={id:'q-share',kind:'quiz',title:'TEST quiz',parent_id:null,library_id:LIBRARY_ID,is_trashed:false,quiz_settings:{}};
          state.items.push(q);service.getQuizQuestionsAdmin=async()=>[{id:'x1',type:'true_false',prompt:'Sky is blue',correct_answer:true,question_position:0}];
          shareOne(q)}""")
        page.locator('#qlIsTo').wait_for()
        page.locator('#qlIsRecent .ql-is-chip [data-pick="QL-FRIEND01"]').wait_for()
        page.locator('[data-pick="QL-FRIEND01"]').click()
        page.wait_for_function("document.querySelector('#qlIsPerson')?.textContent.includes('Friend Student')")
        assert page.locator('#qlIsTo').input_value() == 'QL-FRIEND01'
        page.locator('#qlIsSend').click()
        page.wait_for_function("srv.calls.some(c=>c.name==='ql_send_item_share')")
        sent = calls('ql_send_item_share')[-1]
        assert sent['p_kind'] == 'quiz' and sent['p_recipient_share_id'] == 'QL-FRIEND01', sent
        assert 'Sky is blue' in json.dumps(sent['p_payload']), sent
        assert not calls('ql_send_quiz_share')
        ok(tag + 'Quiz share shows saved IDs, a tap picks the person, and the quiz goes through ql_send_item_share')

        # 2. after sending, the saved IDs are read again next time; × forgets one
        page.evaluate("qlShareInternally(state.items.find(x=>x.id==='q-share'))")
        page.locator('[data-forget="QL-FRIEND01"]').wait_for()
        assert len(calls('ql_share_contacts')) == 2, calls('ql_share_contacts')
        page.locator('[data-forget="QL-FRIEND01"]').click()
        page.wait_for_function("srv.calls.some(c=>c.name==='ql_forget_share_contact')")
        page.wait_for_function("document.querySelector('#qlIsRecent').classList.contains('hidden')")
        assert calls('ql_forget_share_contact')[-1] == {'p_share_id': 'QL-FRIEND01'}
        ok(tag + 'The × on a chip forgets that ID')
        page.evaluate("try{closeModal()}catch(e){}")

        # 3. Shared with me → History: sent and received, with status; Save ID for the sender
        page.evaluate("document.getElementById('studentSharedQuizInbox').click()")
        page.locator('.ql-sh-tabs [data-sh-tab="history"]').click()
        page.locator('#qlShHistory .ql-sh-row').nth(1).wait_for()
        text = page.locator('#qlShHistory').inner_text()
        assert 'Anatomy quiz' in text and 'Sent to Friend Student' in text and 'Saved by them' in text, text
        assert 'Lecture 3' in text and 'From Kuza' in text and 'New' in text, text
        assert page.locator('#qlShareInboxBody').is_hidden()
        page.locator('[data-sh-save="QL-KUZA0001"]').click()
        page.wait_for_function("srv.calls.some(c=>c.name==='ql_save_share_contact')")
        page.wait_for_function("!document.querySelector('[data-sh-save=\"QL-KUZA0001\"]')")
        assert calls('ql_save_share_contact')[-1] == {'p_share_id': 'QL-KUZA0001'}
        ok(tag + 'History lists sent and received shares with status; Save ID remembers the sender')

        # 4. Saved IDs tab: list, add by hand, forget
        page.locator('.ql-sh-tabs [data-sh-tab="ids"]').click()
        page.locator('#qlShIds [data-sh-forget="QL-KUZA0001"]').wait_for()
        page.locator('#qlShAddId').fill('hello'); page.locator('#qlShAddBtn').click()
        assert 'valid Quiz ID' in page.locator('#qlShAddStatus').inner_text()
        page.locator('#qlShAddId').fill(' ql-newp0001 '); page.locator('#qlShAddBtn').click()
        page.locator('#qlShIds [data-sh-forget="QL-NEWP0001"]').wait_for()
        assert calls('ql_save_share_contact')[-1] == {'p_share_id': 'QL-NEWP0001'}
        page.locator('[data-sh-forget="QL-NEWP0001"]').click()
        page.wait_for_function("!document.querySelector('[data-sh-forget=\"QL-NEWP0001\"]')")
        ok(tag + 'Saved IDs tab adds an ID by hand (checks the format) and forgets one')

        # 5. back to Inbox
        page.locator('.ql-sh-tabs [data-sh-tab="inbox"]').click()
        assert page.locator('#qlShareInboxBody').is_visible() and page.locator('#qlShSavedIds').is_hidden()
        overflow = page.evaluate("document.documentElement.scrollWidth>window.innerWidth+1")
        assert not overflow, 'page scrolls sideways'
        ok(tag + 'Inbox tab shows the inbox again; no sideways scrolling')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
