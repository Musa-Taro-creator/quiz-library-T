"""Shared with me + Share internally, Concept A: your Quiz ID with Copy, tab hints and count,
History grouped by date with a Sent/Received filter, Unsend (greyed once saved, hidden once
dismissed), the Undo message after Share, "Already sent" for the item, "Recently sent to …"
for the picked person, "sent today" badges on saved people, and empty states.

Real index.html in Chromium (tablet and phone width) with a simulated Supabase. No network.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
BASE = re.search(r"STUB = r'''(.*?)'''", (ROOT / 'tests/password-recovery.browser.py').read_text(), re.S).group(1)
SESSION = """sessionStorage.setItem('local-recovery-session',JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',
 email:'audit@example.test',app_metadata:{provider:'email'},user_metadata:{full_name:'Local test'}},expires_at:Math.floor(Date.now()/1000)+3600}));"""
SERVER = r'''
const ago=(d,h=0)=>{const x=new Date();x.setDate(x.getDate()-d);if(h)x.setHours(h,15,0,0);return x.toISOString()};
window.srv={calls:[],inbox:[{share_record_id:'in-1',kind:'pdf',title:'Lecture 3 – Renal',item_count:1,sender_name:'Kuza',sender_share_id:'QL-KUZA0001',created_at:ago(0)}],
 contacts:[{share_id:'QL-BONA0003',display_name:'Bona',share_count:2,last_shared_at:ago(0),saved_at:ago(9)},{share_id:'QL-CHEA0004',display_name:'Chea',share_count:1,last_shared_at:ago(20),saved_at:ago(30)}],
 hist:[
  {share_record_id:'h-wait',direction:'sent',kind:'quiz',title:'Cardio MCQ',item_count:1,person_name:'Bona',person_share_id:'QL-BONA0003',status:'pending',created_at:ago(0),source_item_id:'q-share'},
  {share_record_id:'h-in',direction:'received',kind:'pdf',title:'Lecture 3 – Renal',item_count:1,person_name:'Kuza',person_share_id:'QL-KUZA0001',status:'pending',created_at:ago(0),source_item_id:null},
  {share_record_id:'h-other',direction:'sent',kind:'pdf',title:'Physio notes',item_count:1,person_name:'Bona',person_share_id:'QL-BONA0003',status:'saved',created_at:ago(2,11),source_item_id:'p-other'},
  {share_record_id:'h-saved',direction:'sent',kind:'folder',title:'Mama 1.30cm',item_count:3,person_name:'Chea',person_share_id:'QL-CHEA0004',status:'saved',created_at:ago(3,14),source_item_id:'f-x'},
  {share_record_id:'h-dis',direction:'sent',kind:'pdf',title:'Old exam 2025',item_count:1,person_name:'Vanna',person_share_id:'QL-VANN0005',status:'dismissed',created_at:ago(20,9),source_item_id:'p-x'}]};
const plans=[{id:'free',name:'Free',is_default:true,visibility:'public',sort:10,color:'#94a3b8',price_month:0,limits:{},features:{}}];
const answers={
 ql_public_config:()=>({plans,settings:{features:{},site:{open:true}},server_time:new Date().toISOString()}),
 ql_my_plan:()=>({plan:plans[0],subscription:null,usage:{quizzes:0,pdfs:0,links:0,folders:0,storage_bytes:0}}),
 ql_support_mine:()=>[],ql_support_unread:()=>0,ql_my_gifts:()=>[],ql_my_greeting:()=>null,ql_my_payments:()=>[],
 ql_find_student_by_share_id:a=>[{share_id:a.p_share_id,display_name:a.p_share_id==='QL-BONA0003'?'Bona':'Someone'}],
 ql_ensure_share_profile:()=>({share_id:'QL-MINE0001',display_name:'Local test'}),
 ql_received_quiz_share_count:()=>0,ql_received_quiz_shares:()=>[],ql_list_received_quiz_shares:()=>[],
 ql_received_item_share_count:()=>srv.inbox.length,ql_received_item_shares:()=>srv.inbox.slice(),ql_finish_item_share:a=>{srv.inbox=srv.inbox.filter(x=>x.share_record_id!==a.p_share_record_id);return null},
 ql_send_item_share:()=>'share-new',
 ql_share_contacts:()=>srv.contacts.slice(),ql_forget_share_contact:()=>null,ql_save_share_contact:a=>({share_id:a.p_share_id,display_name:'X'}),
 ql_share_history:()=>srv.hist.map(x=>({...x})),
 ql_unsend_item_share:a=>{const r=srv.hist.find(x=>x.share_record_id===a.p_share_record_id);if(r)r.status='unsent';return 'unsent'}
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
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin='http://127.0.0.1:8833')
        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8833/'):
                sub = url.split('8833/', 1)[1].split('?', 1)[0]
                if sub in ('', 'index.html'): r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / sub).is_file(): r.fulfill(status=200, body=(ROOT / sub).read_bytes())
                else: r.fulfill(status=404, body='')
            elif r.request.resource_type == 'script': r.fulfill(status=200, content_type='application/javascript', body='')
            else: r.abort()
        context.route('**/*', route)
        page = context.new_page(); page.set_default_timeout(10000); errors = []; dialogs = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: (dialogs.append(d.message), d.accept()))
        page.goto('http://127.0.0.1:8833/')
        page.wait_for_function('!!state.user && !!window.qlPublicCfg')
        calls = lambda name: page.evaluate('(n)=>srv.calls.filter(c=>c.name===n).map(c=>c.args)', name)
        no_overflow = lambda: page.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1 && [...document.querySelectorAll('#modalBody *')].every(e=>{const r=e.getBoundingClientRect(),m=document.querySelector('#modalBody').getBoundingClientRect();return r.width===0||r.right<=m.right+1})")
        tag = f'[{width}px] '

        # 1. header: your Quiz ID + Copy, tab count and one-line hint; Inbox card
        page.evaluate("document.getElementById('studentSharedQuizInbox').click()")
        page.wait_for_function("document.getElementById('qlShMyId')?.textContent==='QL-MINE0001'")
        page.wait_for_function("document.querySelector('#qlShareInboxBody .ql-is-inbox-row')")
        page.wait_for_function("document.getElementById('qlShTabCount')?.textContent==='1' && !document.getElementById('qlShTabCount').classList.contains('hidden')")
        assert 'Things people sent you' in page.locator('#qlShHint').inner_text()
        card = page.locator('#qlShareInboxBody .ql-is-inbox-row').inner_text()
        assert 'Lecture 3' in card and 'Kuza' in card and 'New' in card, card
        page.locator('#qlShCopyId').click()
        page.wait_for_function("document.getElementById('toast').textContent.includes('QL-MINE0001')")
        assert page.evaluate('navigator.clipboard.readText()') == 'QL-MINE0001'
        assert no_overflow(), 'Inbox overflows'
        ok(tag + 'Your Quiz ID shows and copies; Inbox tab has the count and a one-line hint; inbox card shows sender and New')

        # 2. History: date groups, filter, statuses; Unsend only while Waiting
        page.locator('[data-sh-tab="history"]').click()
        page.locator('#qlShHistList .ql-sh-row').nth(3).wait_for()
        assert 'Everything you sent and received' in page.locator('#qlShHint').inner_text()
        groups = page.locator('#qlShHistList .ql-sa-gh').all_inner_texts()
        assert [g.lower() for g in groups] == ['today', 'this week', 'older'], groups
        row = lambda i: page.locator(f'[data-sh-row="{i}"]')
        assert row('h-wait').locator('[data-sh-unsend]').count() == 1 and 'Waiting' in row('h-wait').inner_text()
        locked = row('h-saved').locator('.ql-sa-locked')
        assert locked.count() == 1 and locked.is_disabled() and "can't unsend" in locked.inner_text()
        assert row('h-dis').locator('[data-sh-unsend],.ql-sa-locked').count() == 0
        assert row('h-in').locator('[data-sh-unsend]').count() == 0
        page.locator('[data-sh-filter="sent"]').click()
        page.wait_for_function("document.querySelectorAll('#qlShHistList .ql-sh-row').length===4")
        assert page.evaluate("[...document.querySelectorAll('#qlShHistList .ql-sh-row')].every(r=>r.dataset.shDir==='sent')")
        page.locator('[data-sh-filter="received"]').click()
        page.wait_for_function("document.querySelectorAll('#qlShHistList .ql-sh-row').length===1")
        page.locator('[data-sh-filter="all"]').click()
        page.locator('[data-sh-row="h-wait"] [data-sh-unsend]').click()
        page.wait_for_function("srv.calls.some(c=>c.name==='ql_unsend_item_share')")
        assert calls('ql_unsend_item_share')[-1] == {'p_share_record_id': 'h-wait'}
        assert 'Unsend' in dialogs[-1] and 'Bona' in dialogs[-1], dialogs
        page.wait_for_function("document.querySelector('[data-sh-row=\"h-wait\"] .ql-sa-badge')?.textContent==='Unsent'")
        assert row('h-wait').locator('[data-sh-unsend]').count() == 0
        assert no_overflow(), 'History overflows'
        ok(tag + 'History: Today / This week / Older, Sent/Received filter, Unsend asks first then shows Unsent; greyed once saved; none once dismissed')
        page.evaluate("srv.hist.find(x=>x.share_record_id==='h-wait').status='pending';srv.calls=[]")

        # 3. Saved IDs tab: bigger avatar cards
        page.locator('[data-sh-tab="ids"]').click()
        page.locator('#qlShIds .ql-sa-person').nth(1).wait_for()
        assert page.locator('#qlShIds .ql-sa-person .ql-sa-av').first.bounding_box()['width'] >= 44
        assert 'Shared 2×' in page.locator('#qlShIds').inner_text()
        ok(tag + 'Saved IDs: big avatar cards with share count')
        page.evaluate("try{closeModal()}catch(e){}")

        # 4. Share internally: Already sent (this item), sent-today badge, Recently sent to …, Share with …
        page.evaluate("""()=>{const q={id:'q-share',kind:'quiz',title:'Cardio MCQ',parent_id:null,library_id:LIBRARY_ID,is_trashed:false,quiz_settings:{}};
          state.items.push(q);service.getQuizQuestionsAdmin=async()=>[{id:'x1',type:'true_false',prompt:'Sky is blue',correct_answer:true,question_position:0}];
          shareOne(q)}""")
        page.locator('#qlIsItemRecent:not(.hidden)').wait_for()
        recent = page.locator('#qlIsItemRecent').inner_text()
        assert 'Already sent' in recent.title() or 'ALREADY SENT' in recent.upper(), recent
        assert 'Bona' in recent and 'Waiting' in recent, recent
        assert page.locator('#qlIsItemRecent [data-sh-unsend]').count() == 1
        chip = page.locator('#qlIsRecent [data-chip="QL-BONA0003"]')
        chip.wait_for()
        assert 'sent today' in chip.inner_text(), chip.inner_text()
        chea = page.locator('#qlIsRecent [data-chip="QL-CHEA0004"] .ql-sa-sent').inner_text()
        assert re.fullmatch(r'sent [A-Z][a-z]{2}', chea), chea   # 3 days ago: weekday, e.g. "sent Fri"
        assert page.evaluate("srv.contacts.length") == 2
        assert not page.locator('#qlIsOr').is_hidden() and 'tap a saved person' in page.locator('#qlIsWhoHint').inner_text()
        chip.locator('[data-pick]').click()
        page.wait_for_function("document.getElementById('qlIsSendLabel')?.textContent==='Share with Bona'")
        assert 'on' in chip.get_attribute('class')
        page.locator('#qlIsToRecent:not(.hidden)').wait_for()
        to_recent = page.locator('#qlIsToRecent').inner_text()
        assert 'RECENTLY SENT TO BONA' in to_recent.upper() and 'Physio notes' in to_recent and 'Cardio MCQ' not in to_recent, to_recent  # this item is already listed above
        assert page.locator('#qlIsSend').is_visible() and page.evaluate("(()=>{const r=document.getElementById('qlIsSend').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})()"), 'Share button stays on screen'
        assert page.locator('#qlIsStep2.done').count() == 1
        assert no_overflow(), 'Share window overflows'
        ok(tag + 'Share internally: Already sent for this item, "sent today" / "sent Fri" badges, Recently sent to the picked person, button says Share with Bona')

        # 5. Share → message with Undo (8 s); Undo takes it back
        page.locator('#qlIsSend').click()
        page.locator('#qlUndoToast.show [data-undo]').wait_for()
        assert 'Quiz shared with Bona' in page.locator('#qlUndoToast').inner_text()
        page.locator('#qlUndoToast [data-undo]').click()
        page.wait_for_function("srv.calls.some(c=>c.name==='ql_unsend_item_share' && c.args.p_share_record_id==='share-new')")
        page.wait_for_function("document.querySelector('#qlUndoToast .ql-undo-msg').textContent.includes('cancelled')")
        ok(tag + 'After Share, the message has Undo; Undo unsends that exact share')
        if width == 1024:
            page.evaluate("qlShareInternally(state.items.find(x=>x.id==='q-share'))")
            page.locator('[data-pick="QL-BONA0003"]').click()
            page.wait_for_function("!document.getElementById('qlIsSend').disabled")
            page.locator('#qlIsSend').click()
            page.locator('#qlUndoToast.show').wait_for()
            page.wait_for_timeout(8600)
            assert not page.locator('#qlUndoToast').evaluate("e=>e.classList.contains('show')")
            ok(tag + 'The Undo message goes away by itself after 8 seconds')

        # 6. empty states
        page.evaluate("srv.inbox=[];srv.hist=[];try{closeModal()}catch(e){}")
        page.evaluate("document.getElementById('studentSharedQuizInbox').click()")
        page.wait_for_function("document.querySelector('#qlShareInboxBody .ql-sa-empty [data-copy-my-id]')")
        page.wait_for_function("document.querySelector('#qlShareInboxBody [data-my-id]')?.textContent==='QL-MINE0001'")
        assert 'Nothing waiting for you' in page.locator('#qlShareInboxBody').inner_text()
        page.locator('[data-sh-tab="history"]').click()
        page.wait_for_function("document.querySelector('#qlShHistList .ql-sa-empty')")
        assert 'Share internally' in page.locator('#qlShHistList').inner_text()
        ok(tag + 'Empty Inbox and History say what to do (with Copy my ID)')
        assert not errors, errors
        context.close()
    browser.close()
print(f'{len(checks)} checks passed')
