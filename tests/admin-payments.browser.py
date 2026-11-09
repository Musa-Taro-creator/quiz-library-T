"""Actual Admin UI with slow/error/out-of-order RPCs; production requests blocked."""
from pathlib import Path
import ast,json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
tree=ast.parse((ROOT/'tests/admin-message-drafts.browser.py').read_text())
base=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='stub' for t in n.targets))
stub=base+r'''
window.pt={calls:[],pending:[],hold:{},fail:{},clock:0,user:{id:'admin-mock',email:'admin@example.test'},codes:{},receipts:[]};
const realNow=Date.now;Date.now=()=>realNow()+pt.clock;
const code=(code,extra={})=>({code,plan_id:'pro',days:30,max_uses:1,uses:0,expires_at:null,cancelled:false,note:'',used_by:[],...extra});
pt.codes['admin-mock']=[code('ACTIVE'),code('USED',{uses:1}),code('EXPIRED',{expires_at:'2000-01-01T00:00:00Z'}),code('CANCELLED',{cancelled:true})];pt.codes['admin-b']=[code('PRIVATE-B')];
pt.receipts=[{id:'receipt-a',status:'waiting',name:'Student',email:'student@example.test',plan_id:'pro',period:'month',amount:5,created_at:new Date().toISOString()}];
const originalClient=supabase.createClient;
supabase.createClient=(...args)=>{const c=originalClient(...args),prior=c.rpc;c.auth.getSession=async()=>({data:{session:pt.user?{user:pt.user}:null}});c.auth.signOut=async()=>{pt.user=null;return {error:null}};
 c.rpc=async(name,args={})=>{
  if(!['ql_admin_codes','ql_admin_payments','ql_admin_create_codes','ql_admin_cancel_code','ql_admin_decide_payment','ql_admin_plans'].includes(name))return prior(name,args);
  const uid=pt.user?.id;pt.calls.push({name,args:structuredClone(args),uid});
  let reply;if(pt.fail[name]){pt.fail[name]--;reply={data:null,error:{message:'Simulated request failure'}}}else{
   let data;if(name==='ql_admin_plans')data=[fakePlan,{id:'pro',name:'Pro',limits:{},features:{},visibility:'public',color:'#6366f1'}];
   if(name==='ql_admin_codes')data=pt.codes[uid]||[];
   if(name==='ql_admin_payments')data=pt.receipts.filter(x=>x.status===args.p_status);
   if(name==='ql_admin_create_codes'){data=Array.from({length:args.p_count},(_,i)=>code((args.p_custom||'GENERATED')+'-'+i,{plan_id:args.p_plan,days:args.p_days,max_uses:args.p_max_uses,note:args.p_note}));pt.codes[uid].push(...data)}
   if(name==='ql_admin_cancel_code'){pt.codes[uid].find(x=>x.code===args.p_code).cancelled=true;data=true}
   if(name==='ql_admin_decide_payment'){const row=pt.receipts.find(x=>x.id===args.p_id);row.status=args.p_approve?'approved':'rejected';row.admin_note=args.p_note;data=true}
   reply={data:structuredClone(data),error:null};
  }
  if(pt.hold[name])return new Promise(resolve=>pt.pending.push({name,args:structuredClone(args),uid,release:()=>resolve(reply)}));return reply;
 };return c};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.lastCopied=text}});
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 def boot():
  c=browser.new_context(viewport={'width':1280,'height':900},service_workers='block');c.add_init_script(stub);page=c.new_page();page.set_default_timeout(10000);errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept('Reason for rejection') if d.type=='prompt' else d.accept())
  def route(r):
   u=r.request.url
   if u.startswith('http://127.0.0.1:8812/'):
    name=u.split('8812/',1)[1].split('?',1)[0];file=ROOT/name
    if file.is_file():r.fulfill(status=200,content_type='text/html' if name.endswith('.html') else 'application/octet-stream',body=file.read_bytes())
    else:r.fulfill(status=404,body='')
   elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* simulated transport */')
   else:r.abort()
  c.route('**/*',route);page.goto('http://127.0.0.1:8812/admin.html');page.locator('.nav[data-v="pay"]').wait_for();page.wait_for_timeout(200);return c,page,errors
 def count(name):return page.evaluate('(name)=>pt.calls.filter(x=>x.name===name).length',name)
 def release(name):page.evaluate('(name)=>{const n=pt.pending.findIndex(x=>x.name===name);if(n<0)throw Error("No pending "+name);pt.pending.splice(n,1)[0].release()}',name)
 c,page,errors=boot()
 page.locator('.nav[data-v="pay"]').click();page.locator('[data-t="codes"]').wait_for()
 page.evaluate("pt.hold.ql_admin_codes=true")
 page.locator('[data-t="codes"]').click();assert page.locator('[data-t="codes"]').evaluate('e=>e.classList.contains("on")');assert 'Loading activation codes' in page.locator('#view [role="status"]').inner_text();ok('Activation codes selects immediately while its server request is still pending')
 page.locator('.nav[data-v="ctl"]').click();page.locator('#siteSw').wait_for();release('ql_admin_codes');page.wait_for_timeout(100);assert page.locator('#siteSw').is_visible();ok('Late code response cannot replace another Admin section')
 page.evaluate("pt.hold.ql_admin_codes=false");page.locator('.nav[data-v="pay"]').click();page.locator('#gGo').wait_for();assert count('ql_admin_codes')==1
 page.locator('#gNote').fill('Keep this note');page.locator('#gCustom').fill('CLASS-2026')
 for f in ['used','expired','cancelled','active']:
  page.locator(f'[data-cf="{f}"]').click();page.locator('#gGo').wait_for();assert page.locator('#gNote').input_value()=='Keep this note';assert page.locator('#gCustom').input_value()=='CLASS-2026'
 assert count('ql_admin_codes')==1;ok('Code filters and returning to a loaded tab avoid duplicate RPCs and preserve drafts')
 page.evaluate('pt.clock=16000');page.locator('[data-cf="used"]').click();page.locator('#gGo').wait_for();assert count('ql_admin_codes')==2
 page.locator('#payRefresh').click();page.locator('#gGo').wait_for();assert count('ql_admin_codes')==3;ok('Expired cache and Refresh fetch current code data')
 page.evaluate("pt.hold.ql_admin_payments=true");page.locator('[data-t="receipts"]').click();page.locator('[data-s="approved"]').click();release('ql_admin_payments');page.wait_for_timeout(100);assert page.locator('[data-s="approved"]').evaluate('e=>e.classList.contains("on")');assert 'Loading receipts' in page.locator('#view [role="status"]').inner_text();release('ql_admin_payments');page.locator('.empty',has_text='No approved payments').wait_for();ok('Out-of-order receipt responses preserve the most recently selected filter')
 page.evaluate("pt.hold.ql_admin_payments=false");page.locator('[data-t="codes"]').click();page.locator('#gGo').wait_for()
 page.evaluate("pt.fail.ql_admin_codes=1");page.locator('#payRefresh').click();page.locator('#payRetry').wait_for();assert page.locator('[data-t="receipts"]').is_enabled();page.locator('#payRetry').click();page.locator('#gGo').wait_for();ok('Failed loads keep tabs usable and can be retried')
 # Use the real code-generation controls and preserve inputs/results through navigation.
 page.locator('[data-g="plan"] [data-v="pro"]').click();page.locator('[data-custom="days"]').fill('2');page.locator('#gDaysUnit').select_option('30');page.locator('[data-g="uses"] [data-v="2"]').click();page.locator('[data-g="valid"] [data-v="30"]').click();page.locator('[data-g="count"] [data-v="5"]').click()
 page.evaluate("pt.hold.ql_admin_create_codes=true");page.locator('#gGo').click();assert page.locator('#gGo').is_disabled();page.locator('[data-g="days"] [data-v="7"]').click();page.locator('[data-cf="active"]').click();page.locator('#gGo').wait_for();assert page.locator('#gGo').is_disabled();assert count('ql_admin_create_codes')==1
 call=page.evaluate("pt.calls.find(x=>x.name==='ql_admin_create_codes').args");assert call=={'p_plan':'pro','p_days':60,'p_max_uses':2,'p_valid_days':30,'p_note':'Keep this note','p_count':5,'p_custom':'CLASS-2026'},call
 page.locator('[data-t="receipts"]').click();page.locator('[data-s="approved"].on').wait_for();release('ql_admin_create_codes');page.wait_for_timeout(100);assert page.locator('[data-t="receipts"]').evaluate('e=>e.classList.contains("on")');page.locator('[data-t="codes"]').click();page.locator('#gOut .codebox').first.wait_for();assert page.locator('#gOut .codebox').count()==5;assert '60 days' in page.locator('#gOut').inner_text();assert page.locator('#gNote').input_value()=='Keep this note'
 page.locator('[data-c2]').first.click();assert 'Pro code: CLASS-2026-0' in page.evaluate('lastCopied');assert '\nOpen My Profile' in page.evaluate('lastCopied');ok('Generation keeps its original parameters, blocks duplicate submissions and retains results without jumping back to Payments')
 page.locator('[data-cx="ACTIVE"]').click();page.locator('#gGo').wait_for();page.wait_for_function('!document.querySelector(\'[data-cx="ACTIVE"]\')');assert count('ql_admin_cancel_code')==1;assert page.locator('#gOut .codebox').count()==5;ok('Cancelling a code invalidates the list cache while keeping generated results')
 # A late response from one admin must not appear in another account.
 page.evaluate("pt.hold.ql_admin_codes=true");page.locator('#payRefresh').click();page.wait_for_function("pt.pending.some(x=>x.name==='ql_admin_codes')")
 page.evaluate("pt.user={id:'admin-b',email:'b@example.test'};me=pt.user;go('pay')");release('ql_admin_codes');page.wait_for_timeout(100);assert page.locator('#gGo').count()==0;release('ql_admin_codes');page.locator('#gGo').wait_for();assert page.locator('#gNote').input_value()=='';assert page.locator('#gCustom').input_value()=='';assert page.locator('#gOut .codebox').count()==0;assert 'PRIVATE-B' in page.locator('#view').inner_text();assert 'CLASS-2026' not in page.locator('#view').inner_text()
 page.locator('#signOut').click();page.locator('#login').wait_for(state='visible');assert page.evaluate('paymentCache===null');ok('Account changes and sign-out clear code data, drafts and outputs; stale responses stay isolated')
 assert not errors,errors;c.close()
 c,page,errors=boot();page.locator('.nav[data-v="pay"]').click();page.locator('[data-ok="receipt-a"]').click();page.wait_for_function("pt.receipts[0].status==='approved'");page.locator('.empty',has_text='No waiting payments').wait_for()
 page.locator('[data-s="approved"]').click();page.locator('.tag.ok',has_text='approved').wait_for();assert page.evaluate("pt.calls.find(x=>x.name==='ql_admin_decide_payment').args")=={'p_id':'receipt-a','p_approve':True,'p_note':''}
 page.evaluate("pt.receipts.push({...pt.receipts[0],id:'receipt-b',status:'waiting'})");page.locator('[data-s="waiting"]').click();page.locator('[data-no="receipt-b"]').click();page.locator('.empty',has_text='No waiting payments').wait_for();assert page.evaluate("pt.calls.filter(x=>x.name==='ql_admin_decide_payment').at(-1).args")=={'p_id':'receipt-b','p_approve':False,'p_note':'Reason for rejection'}
 assert not errors,errors;ok('Receipt approval and rejection retain the existing server RPCs and refresh from current data');c.close();browser.close()
 print(f'{len(checks)} Payments scenarios passed; no production calls or real payment/code mutations.')
