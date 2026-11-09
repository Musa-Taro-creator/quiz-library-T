"""Admin form wiring and persistence with simulated RPCs; no real accounts change."""
from pathlib import Path
import ast
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
tree=ast.parse((ROOT/'tests/admin-message-drafts.browser.py').read_text())
BASE=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='stub' for t in n.targets))
STUB=BASE+r'''
window.adminTest={student,settings:fakeSettings,calls:[],gifts:[],greeting:{},device:{custom:false,max:1,effective:1,plan:'Free',devices:[]},plans:[fakePlan,{id:'pro',name:'Pro',color:'#6366f1',price_month:5,limits:{devices:2},features:{},visibility:'public'}]};
const originalFactory=supabase.createClient;
supabase.createClient=(...args)=>{const c=originalFactory(...args),old=c.rpc;c.rpc=async(name,args={})=>{
 adminTest.calls.push({name,args:structuredClone(args)});let data;
 if(name==='ql_admin_plans')data=adminTest.plans;
 else if(name==='ql_admin_set_setting'){let row=adminTest.settings.find(r=>r.key===args.p_key);if(!row){row={key:args.p_key};fakeSettings.push(row)}row.value=structuredClone(args.p_value);data=true}
 else if(name==='ql_admin_get_greeting')data=adminTest.greeting;
 else if(name==='ql_admin_set_greeting'){adminTest.greeting={greeting:args.p_greeting,note:args.p_note,seconds:args.p_seconds,off:args.p_off};data=true}
 else if(name==='ql_admin_user_gifts')data=adminTest.gifts;
 else if(name==='ql_admin_send_gift'){adminTest.gifts.push({id:'gift-1',plan_id:args.p_plan,days:args.p_days,message:args.p_message,status:'pending',created_at:new Date().toISOString()});data=true}
 else if(name==='ql_admin_cancel_gift'){adminTest.gifts.find(g=>g.id===args.p_id).status='cancelled';data=true}
 else if(name==='ql_admin_get_device_rule')data=adminTest.device;
 else if(name==='ql_admin_set_device_limit'){adminTest.device={...adminTest.device,custom:!args.p_follow,max:args.p_max,effective:args.p_max};data=true}
 else if(name==='ql_admin_update_user'){if(args.p_action==='set_plan')adminTest.student.plan_id=args.p_plan;if(args.p_action==='suspend')student.status='suspended';data=true}
 else if(name==='ql_admin_save_plan'){const i=adminTest.plans.findIndex(p=>p.id===args.p.id);if(i>=0)adminTest.plans[i]={...adminTest.plans[i],...args.p};data=true}
 else return old(name,args);
 return {data:structuredClone(data),error:null};
 };return c};
'''
checks=[]
def ok(s):checks.append(s);print('PASS:',s,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);context=browser.new_context(viewport={'width':1024,'height':900},has_touch=True,service_workers='block');context.add_init_script(STUB);page=context.new_page();errors=[];dialogs=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
 def route(r):
  u=r.request.url
  if u.startswith('http://127.0.0.1:8825/'):
   name=u.split('8825/',1)[1].split('?',1)[0]
   if name=='admin.html':r.fulfill(status=200,content_type='text/html',body=(ROOT/name).read_bytes())
   elif (ROOT/name).is_file():r.fulfill(status=200,body=(ROOT/name).read_bytes())
   else:r.fulfill(status=404,body='Missing')
  elif r.request.resource_type=='script':r.fulfill(status=200,content_type='application/javascript',body='/* simulated admin transport */')
  else:r.abort()
 context.route('**/*',route);page.goto('http://127.0.0.1:8825/admin.html');page.locator('#view h1',has_text='Dashboard').wait_for()
 def manage():
  page.evaluate("go('users')");page.locator('[data-u="student-1"]').click();page.locator('#mSet').wait_for()
 manage();page.locator('#mPlan').select_option('pro');page.locator('#mLen').select_option('90');page.locator('#mSet').click();page.wait_for_function("adminTest.student.plan_id==='pro'");page.locator('#mSet').wait_for(state='detached');assert page.evaluate("adminTest.calls.filter(c=>c.name==='ql_admin_update_user').at(-1).args.p_days")==90;ok('User plan changes submit the selected plan and duration and refresh Users')
 manage();page.locator('#pgT').fill('Good luck, {name}!');page.locator('#pgN').fill('For your exam');page.locator('#pgS').fill('8');page.locator('#pgSave').click();page.wait_for_function("adminTest.greeting.seconds===8");page.locator('.ovl .x').click();manage();assert page.locator('#pgT').input_value()=='Good luck, {name}!';ok('Personal greetings save and reload')
 page.locator('[data-dv="unl"]').click();page.wait_for_function('adminTest.device.custom&&adminTest.device.effective===null');assert 'unlimited devices' in page.locator('#dvNow').inner_text();page.locator('[data-dv="plan"]').click();page.wait_for_function('!adminTest.device.custom');ok('Per-user device limits support Unlimited and Follow plan')
 page.locator('#gPlan').select_option('pro');page.locator('#gMsg').fill('Exam gift');page.locator('#gSend').click();page.locator('[data-gx="gift-1"]').wait_for();assert page.evaluate('adminTest.gifts[0].message')=='Exam gift';page.locator('[data-gx="gift-1"]').click();page.wait_for_function("adminTest.gifts[0].status==='cancelled'");ok('Gift plans send and cancel with the selected message');page.locator('.ovl .x').click()
 page.evaluate("go('plans')");page.locator('[data-edit="pro"]').click();page.locator('#pName').fill('Pro Plus');page.locator('#pSave').click();page.wait_for_function("adminTest.plans.find(x=>x.id==='pro').name==='Pro Plus'");page.locator('#pName').wait_for(state='detached');ok('Plan editing saves and refreshes the plan list')
 page.evaluate("go('ctl')");page.locator('#siteSw').click();page.wait_for_function("adminTest.settings.find(x=>x.key==='site').value.open===false");page.locator('#siteSw').click();page.wait_for_function("adminTest.settings.find(x=>x.key==='site').value.open===true");ok('Website Open/Closed control persists both states')
 for mode in ['off','plan','lock','on']:
  page.locator(f'[data-k="nav_rooms"] [data-m="{mode}"]').click();page.wait_for_function('(m)=>adminTest.settings.find(x=>x.key==="features").value.nav_rooms===m',arg=mode)
 ok('Website feature controls save Everyone, By plan, Lock and Hidden')
 page.evaluate("go('news')");page.locator('#aText').fill('Exam materials are ready');page.locator('#aSw').click();page.locator('#aSave').click();page.wait_for_function("adminTest.settings.find(x=>x.key==='announcement').value.active");page.evaluate("go('news')");page.locator('#aText').wait_for();assert page.locator('#aText').input_value()=='Exam materials are ready';ok('Announcements save and reload')
 page.evaluate("go('settings')");page.locator('#ctEm').fill('support@example.test');page.locator('#ctNote').fill('Contact us for help');page.locator('#ctSave').click();page.wait_for_function("adminTest.settings.find(x=>x.key==='site').value.contact?.email==='support@example.test'")
 page.locator('#sBank').fill('Test Bank');page.locator('#sName').fill('Test Account');page.locator('#sNum').fill('123456');page.locator('#sSave').click();page.wait_for_function("adminTest.settings.find(x=>x.key==='payment').value.bank==='Test Bank'");page.evaluate("go('settings')");page.locator('#sBank').wait_for();assert page.locator('#sBank').input_value()=='Test Bank';assert page.locator('#ctEm').input_value()=='support@example.test';ok('Contact and payment settings save and reload')
 assert not errors,errors;assert len(dialogs)==2,dialogs;context.close();browser.close()
print(f'{len(checks)} Admin form checks passed; no real accounts, plans or payment settings changed.')
