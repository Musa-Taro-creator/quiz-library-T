"""Student screens that talk to the server: announcement, upgrade code, plan-limit message,
Help & Support, Share internally and Share externally.

Real index.html in Chromium with a simulated Supabase (from the password-recovery test);
each step checks the screen and the exact server call it makes. No network.
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
window.srv={calls:[]};
const plans=[{id:'free',name:'Free',is_default:true,visibility:'public',sort:10,color:'#94a3b8',price_month:0,limits:{quizzes:1},features:{}},
             {id:'pro',name:'Pro',visibility:'public',sort:20,color:'#6366f1',price_month:4,price_year:39,limits:{},features:{}}];
const answers={
 ql_public_config:()=>({plans,settings:{announcement:{active:true,id:'ann-1',text:'Exam week: good luck!',level:'info'},features:{},site:{open:true}},server_time:new Date().toISOString()}),
 ql_my_plan:()=>({plan:plans[0],subscription:null,usage:{quizzes:1,pdfs:0,links:0,folders:0,storage_bytes:0}}),
 ql_redeem_code:()=>({plan_id:'pro',ends_at:new Date(Date.now()+30*864e5).toISOString()}),
 ql_support_mine:()=>[],ql_support_unread:()=>0,ql_support_send:()=>null,
 ql_find_student_by_share_id:a=>[{share_id:a.p_share_id,display_name:'Friend Student'}],
 ql_ensure_share_profile:()=>({share_id:'QL-MINE0001',display_name:'Local test'}),
 ql_send_item_share:()=>'share-1',ql_finish_item_share:()=>true,
 ql_create_external_item_share:()=>'tok_external_1',ql_create_short_link:()=>'ABCDEFG',
 ql_my_gifts:()=>[],ql_my_greeting:()=>null,ql_my_payments:()=>[],ql_received_item_share_count:()=>0,ql_received_item_shares:()=>[]
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
    context = browser.new_context(viewport={'width': 1024, 'height': 820}, service_workers='block')
    context.add_init_script(SESSION + BASE + SERVER)
    def route(r):
        url = r.request.url
        if url.startswith('http://127.0.0.1:8831/'):
            sub = url.split('8831/', 1)[1].split('?', 1)[0]
            if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
            elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
            else: r.fulfill(status=404, body='')
        elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
        else: r.abort()
    context.route('**/*', route)
    page = context.new_page(); page.set_default_timeout(10000); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://127.0.0.1:8831/')
    page.wait_for_function('!!state.user && !!window.qlPublicCfg')
    calls = lambda name: page.evaluate('(n)=>srv.calls.filter(c=>c.name===n).map(c=>c.args)', name)

    # 1. announcement banner shows and can be closed for good
    page.locator('#qlAnn').wait_for()
    assert 'Exam week: good luck!' in page.locator('#qlAnn').inner_text()
    page.locator('#qlAnn button').click(); page.wait_for_timeout(200)
    assert page.locator('#qlAnn').count() == 0
    page.reload(); page.wait_for_function('!!state.user && !!window.qlPublicCfg'); page.wait_for_timeout(1500)
    assert page.locator('#qlAnn').count() == 0
    ok('Announcement shows, closes, and stays closed after a reload')

    # 2. plan-limit refusal from the database opens Upgrade, and a promo code can be entered there
    msg = page.evaluate("friendlyError(new Error('plan_limit:quizzes'))")
    assert 'quizzes limit' in msg, msg
    page.locator('#quCode').wait_for(); page.wait_for_timeout(800)   # let its plan refresh finish
    ok('A plan-limit refusal shows the limit message and opens Upgrade')
    page.locator('#quCode').fill('qlp-test-0001'); page.locator('#quCodeGo').click()
    page.wait_for_function("srv.calls.some(c=>c.name==='ql_redeem_code')")
    assert calls('ql_redeem_code')[-1]['p_code'].strip().upper() == 'QLP-TEST-0001', calls('ql_redeem_code')
    page.wait_for_function("srv.calls.filter(c=>c.name==='ql_my_plan').length>=3")
    ok('Enter code sends the code and refreshes the plan')
    page.evaluate("try{closeModal()}catch(e){};document.querySelectorAll('.ql-act-ov,#qlActivated').forEach(e=>e.remove())")

    # 4. Help & Support
    page.evaluate('qlOpenSupport()'); page.locator('#qlSupText').wait_for()
    page.locator('#qlSupText').fill('I cannot open my PDF'); page.locator('#qlSupSend').click()
    page.wait_for_function("srv.calls.some(c=>c.name==='ql_support_send')")
    assert calls('ql_support_send')[-1]['p_body'] == 'I cannot open my PDF', calls('ql_support_send')
    ok('Help & Support sends the message')
    page.evaluate("try{closeModal()}catch(e){}")

    # 5. Share internally (folder with a link inside)
    page.evaluate("""()=>{const f={id:'f-share',kind:'folder',title:'TEST share folder',parent_id:null,library_id:LIBRARY_ID,is_trashed:false};
      const l={id:'l-share',kind:'link',title:'TEST inner link',url:'https://example.com/x',parent_id:'f-share',library_id:LIBRARY_ID,is_trashed:false};
      state.items.push(f,l);qlShareInternally(f)}""")
    page.locator('#qlIsTo').wait_for(); page.locator('#qlIsTo').fill('QL-FRIEND01'); page.locator('#qlIsFind').click()
    page.wait_for_function("document.querySelector('#qlIsPerson')?.textContent.includes('Friend Student')")
    page.wait_for_timeout(700)   # past the 350 ms automatic search started by typing
    assert len(calls('ql_find_student_by_share_id')) == 1, calls('ql_find_student_by_share_id')
    assert page.locator('#qlIsSend').is_enabled() and 'Friend Student' in page.locator('#qlIsPerson').inner_text()
    page.locator('#qlIsSend').click()
    page.wait_for_function("srv.calls.some(c=>c.name==='ql_send_item_share')")
    sent = calls('ql_send_item_share')[-1]
    assert sent['p_recipient_share_id'] == 'QL-FRIEND01' and sent['p_kind'] == 'folder', sent
    assert 'TEST inner link' in json.dumps(sent['p_payload']), sent
    ok('Share internally finds the person once (typing + Search), keeps Send working, and sends the folder with what is inside')
    page.evaluate("try{closeModal()}catch(e){}")

    # 6. Share externally
    page.evaluate("qlShareExternally(state.items.find(x=>x.id==='f-share'))")
    page.wait_for_function("srv.calls.some(c=>c.name==='ql_create_external_item_share') || !!document.querySelector('#qlIsMake')")
    if not calls('ql_create_external_item_share'):
        page.locator('#qlIsMake').click()
        page.wait_for_function("srv.calls.some(c=>c.name==='ql_create_external_item_share')")
    page.wait_for_function("(document.querySelector('#qlIsLink')?.value||document.querySelector('#qlIsLink')?.textContent||'').length>10")
    link = page.evaluate("document.querySelector('#qlIsLink').value||document.querySelector('#qlIsLink').textContent")
    assert 'ABCDEFG' in link or 'tok_external_1' in link, link
    ok('Share externally creates a link anyone can open')

    page.evaluate("try{closeModal()}catch(e){}")

    # 7. choose an avatar in My Profile and save it to the account
    page.evaluate("navigate('profile')"); page.evaluate('__studentProfile.openAvatarPicker()')
    page.locator('[data-profile-avatar-id="polished_avatar_05"]').first.click()
    page.locator('#profileEditorSave').click()
    page.wait_for_function("authTest.user.user_metadata.ql_avatar_id==='polished_avatar_05'")
    assert page.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('ql_student_profile_')))).avatarId") == 'polished_avatar_05'
    page.wait_for_function("[...document.querySelectorAll('img')].some(i=>i.src.includes('assets/avatars/polished_avatar_05'))")
    ok('Choosing an avatar saves it to the account and shows the picture')

    assert not errors, errors
    browser.close()
print(f'{len(checks)} checks passed')
