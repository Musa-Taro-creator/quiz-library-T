"""Run the real frontend recovery handlers with simulated Supabase Auth.

No live email, passwords, accounts, or external requests are used. The stub emits
the real SDK's recovery/auth events; MOCK_MODE stays false in the application.
Set QL_RECOVERY_SOURCE_REF to an older Git ref to demonstrate the regression.
"""
from pathlib import Path
import json
import os
import subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'index.html').read_text()
if os.environ.get('QL_RECOVERY_SOURCE_REF'):
    SOURCE = subprocess.check_output(
        ['git', 'show', os.environ['QL_RECOVERY_SOURCE_REF'] + ':index.html'],
        cwd=ROOT, text=True)

STUB = r'''
window.authTest={session:JSON.parse(sessionStorage.getItem('local-recovery-session')||'null'),
  callbacks:[],calls:[],delay:0,otherDevice:false,forceLogout:false,failUpdate:false,
  failSignOut:false,password:'Old-password-123!'};
const library={id:'2953b6bf-e205-4924-ba7b-df87d48de03a',
  owner_id:'22222222-2222-4222-8222-222222222222',name:'Local recovery test',
  is_public:true,student_access_private:false};
const user={id:'11111111-1111-4111-8111-111111111111',email:'audit@example.test',
  user_metadata:{full_name:'Local test'}};
authTest.user=user;
const persist=()=>sessionStorage.setItem('local-recovery-session',JSON.stringify(authTest.session));
const emit=async(event)=>{authTest.calls.push({event});
  for(const cb of authTest.callbacks)await cb(event,authTest.session)};
const auth={
  onAuthStateChange(cb){authTest.callbacks.push(cb);return {data:{subscription:{unsubscribe(){}}}}},
  async getSession(){return {data:{session:authTest.session},error:null}},
  async getUser(){return {data:{user:authTest.session?.user||null},error:null}},
  async refreshSession(){return this.getSession()},
  async resetPasswordForEmail(email,{redirectTo}){
    authTest.calls.push({method:'send-reset',email,redirectTo});return {data:{},error:null}},
  async verifyOtp({email,token,type}){
    authTest.calls.push({method:'verify',type,email});
    if(token!=='123456')return {data:{},error:{message:'Invalid or expired OTP'}};
    authTest.session={user,expires_at:Math.floor(Date.now()/1000)+3600};persist();
    await emit(type==='recovery'?'PASSWORD_RECOVERY':'SIGNED_IN');
    if(authTest.delay)await new Promise(r=>setTimeout(r,authTest.delay));
    return {data:{user,session:authTest.session},error:null};
  },
  async updateUser({password}){
    authTest.calls.push({method:'update-password'});
    if(!authTest.session)return {error:{message:'Auth session missing'}};
    if(authTest.failUpdate)return {error:{message:'Simulated password save failure'}};
    authTest.password=password;await emit('USER_UPDATED');return {data:{user},error:null};
  },
  async signOut(options){
    authTest.calls.push({method:'signout',scope:options?.scope||'global'});
    if(authTest.failSignOut)return {error:{message:'Simulated sign-out failure'}};
    authTest.session=null;persist();await emit('SIGNED_OUT');return {error:null};
  },
  async signInWithPassword({password}){
    authTest.calls.push({method:'login'});
    if(password!==authTest.password)return {error:{message:'Invalid login credentials'}};
    authTest.session={user,expires_at:Math.floor(Date.now()/1000)+3600};persist();
    await emit('SIGNED_IN');return {data:{user,session:authTest.session},error:null};
  },
  async signUp(){authTest.calls.push({method:'signup'});
    return {data:{user:{...user,identities:[{id:'local-identity'}]},session:null},error:null}},
  async resend(){return {data:{},error:null}}
};
function from(table){let single=false;const q=new Proxy({}, {get(_,prop){
  if(prop==='then')return (resolve,reject)=>Promise.resolve({
    data:table==='libraries'?(single?library:[library]):(single?null:[]),error:null}).then(resolve,reject);
  return ()=>{if(prop==='single'||prop==='maybeSingle')single=true;return q};
}});return q}
function channel(){const c={on(){return c},subscribe(){return c},unsubscribe(){}};return c}
async function rpc(name){
  if(name.startsWith('ql_device_'))authTest.calls.push({method:name});
  if(name==='ql_device_check')return {data:{signed_in:!authTest.otherDevice&&!authTest.forceLogout,
    any:authTest.otherDevice||authTest.forceLogout,
    newest:{label:'Another simulated device',at:new Date().toISOString()}},error:null};
  if(name==='ql_device_signin'){authTest.otherDevice=false;
    return {data:{signed_in:true,limit:1,count:1},error:null}}
  return {data:null,error:null};
}
window.supabase={createClient:()=>({auth,from,rpc,channel,
  removeChannel:async()=>{},storage:{from:()=>({})}})};
'''

passed = []


def ok(name):
    passed.append(name)
    print('PASS:', name, flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                               args=['--no-sandbox'])

    def open_app(query=''):
        context = browser.new_context(viewport={'width':1024,'height':768},
                                      service_workers='block')
        context.add_init_script(STUB)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.dismiss())

        def route(r):
            url = r.request.url
            if url.startswith('http://127.0.0.1:8792/'):
                sub = url.split('8792/', 1)[1].split('?', 1)[0]
                if sub in ('', 'index.html'):
                    r.fulfill(status=200, content_type='text/html', body=SOURCE)
                elif (ROOT / sub).is_file():
                    mime = 'application/javascript' if sub.endswith('.mjs') else 'application/octet-stream'
                    r.fulfill(status=200, content_type=mime, body=(ROOT / sub).read_bytes())
                else:
                    r.fulfill(status=404, body='Missing local fixture')
            elif r.request.resource_type == 'script':
                r.fulfill(status=200, content_type='application/javascript',
                          body='/* external transport blocked by local auth test */')
            else:
                r.abort()

        context.route('**/*', route)
        page.goto('http://127.0.0.1:8792/' + query, wait_until='domcontentloaded')
        if not query:
            page.locator('#studentForgotPassword').wait_for()
        else:
            page.locator('#studentResetPasswordForm').wait_for()
        page.wait_for_timeout(400)
        return context, page, errors

    def begin_recovery(page):
        page.locator('#studentForgotPassword').click()
        page.locator('#studentForgotIdentifier').fill('audit@example.test')
        page.locator('#studentForgotForm button[type="submit"]').click()
        page.locator('#studentRecoveryCode').wait_for()

    def verify(page, code='123456'):
        page.locator('#studentRecoveryCode').fill(code)
        page.locator('#studentRecoveryCodeForm button[type="submit"]').click()

    def fill_password(page, password='New-password-456!', confirm=None):
        if not page.locator('.ql-strong-no').is_visible():
            page.locator('#studentNewPassword').click()
        if page.locator('.ql-strong-no').is_visible():
            page.locator('.ql-strong-no').click()
        page.locator('#studentNewPassword').fill(password)
        page.locator('#studentNewPasswordConfirm').fill(password if confirm is None else confirm)

    def save(page):
        page.locator('#studentResetPasswordForm button[type="submit"]').click()

    def calls(page, method):
        return page.evaluate('(method)=>authTest.calls.filter(x=>x.method===method)', method)

    def finish_assertions(page):
        page.locator('#studentLoginForm').wait_for()
        assert 'Password updated.' in page.locator('#studentLoginStatus').inner_text()
        assert not page.evaluate('isStudentPasswordRecovery()||!!state.user||!!authTest.session')
        assert 'student_recovery' not in page.url
        assert calls(page, 'signout')[-1]['scope'] == 'global'

    for delay in [0, 250]:
        for conflict in [False, True]:
            context, page, errors = open_app()
            page.evaluate('([d,c])=>{authTest.delay=d;authTest.otherDevice=c}', [delay, conflict])
            begin_recovery(page)
            verify(page)
            page.locator('#studentResetPasswordForm').wait_for()
            page.wait_for_timeout(1800)
            assert page.locator('#studentResetPasswordForm').is_visible()
            assert page.locator('#recoveryNewPassword').count() == 0
            assert page.locator('#qlKicked').count() == 0
            assert not calls(page, 'update-password')
            assert not calls(page, 'ql_device_check')
            fill_password(page)
            page.evaluate('render()')
            page.wait_for_timeout(150)
            assert page.locator('#studentNewPassword').input_value() == 'New-password-456!'
            save(page)
            finish_assertions(page)
            assert len(calls(page, 'update-password')) == 1
            assert not errors, errors
            ok(f'Complete recovery: response delay {delay} ms; other device {conflict}')
            context.close()

    for late_user in [False, True]:
        context, page, errors = open_app()
        page.evaluate('''()=>{
          window.originalSession=service.getSession;
          service.getSession=()=>new Promise(resolve=>window.finishAccessCheck=resolve);
          window.accessCheck=__quizTest.enforceLibraryAccess();
        }''')
        begin_recovery(page)
        if late_user:
            verify(page)
            page.locator('#studentResetPasswordForm').wait_for()
        page.evaluate('''(withUser)=>{
          service.getSession=window.originalSession;
          window.finishAccessCheck(withUser?{user:authTest.user}:null);
        }''', late_user)
        page.wait_for_timeout(150)
        selector = '#studentResetPasswordForm' if late_user else '#studentRecoveryCodeForm'
        assert page.locator(selector).is_visible()
        assert not errors, errors
        ok(f'An earlier access check cannot overwrite recovery when it returns user={late_user}')
        context.close()

    context, page, errors = open_app()
    begin_recovery(page)
    verify(page, '000000')
    page.wait_for_function("document.querySelector('#studentRecoveryCodeStatus').textContent.includes('invalid')")
    page.evaluate('render()')
    assert page.locator('#studentRecoveryCodeForm').is_visible()
    assert not calls(page, 'update-password')
    verify(page)
    fill_password(page, 'short')
    save(page)
    assert 'at least 8' in page.locator('#studentResetPasswordStatus').inner_text()
    fill_password(page, 'New-password-456!', 'Mismatch-password!')
    save(page)
    assert 'do not match' in page.locator('#studentResetPasswordStatus').inner_text()
    assert not calls(page, 'update-password')
    ok('Invalid/expired code, short password and mismatched confirmation keep the flow open')
    fill_password(page)
    page.evaluate('authTest.failUpdate=true')
    save(page)
    page.wait_for_function("document.querySelector('#studentResetPasswordStatus').textContent.includes('Simulated')")
    assert page.locator('#studentNewPassword').input_value() == 'New-password-456!'
    assert not calls(page, 'signout')
    page.evaluate('authTest.failUpdate=false')
    save(page)
    finish_assertions(page)
    assert not errors, errors
    ok('Failed password update retains the form and supports a successful retry')
    page.locator('#studentLoginIdentifier').fill('audit@example.test')
    page.locator('#studentLoginPassword').fill('Old-password-123!')
    page.locator('#studentLoginSubmit').click()
    page.wait_for_function("document.querySelector('#studentLoginStatus').textContent.includes('incorrect')")
    page.locator('#studentLoginPassword').fill('New-password-456!')
    page.locator('#studentLoginSubmit').click()
    page.wait_for_function('!!state.user')
    page.wait_for_function("authTest.calls.some(x=>x.method==='ql_device_signin')")
    assert not page.locator('#studentAccessGate').is_visible()
    ok('Normal login rejects the old password and accepts the new password')
    page.evaluate("authTest.forceLogout=true;document.dispatchEvent(new Event('visibilitychange'))")
    page.locator('#qlKicked').wait_for()
    assert not page.evaluate('!!authTest.session')
    assert not errors, errors
    ok('Device-limit sign-out still applies after normal login')
    context.close()

    context, page, errors = open_app()
    begin_recovery(page)
    verify(page)
    fill_password(page)
    page.evaluate('authTest.failSignOut=true')
    save(page)
    page.wait_for_function("document.querySelector('#studentResetPasswordStatus').textContent.includes('sign-out did not finish')")
    assert page.locator('#studentNewPassword').is_disabled()
    assert len(calls(page, 'update-password')) == 1
    page.evaluate('authTest.failSignOut=false')
    save(page)
    finish_assertions(page)
    assert len(calls(page, 'update-password')) == 1
    assert not errors, errors
    ok('Sign-out retry finishes without submitting the password update twice')
    context.close()

    context, page, errors = open_app()
    begin_recovery(page)
    verify(page)
    page.locator('#studentResetPasswordForm').wait_for()
    page.reload(wait_until='domcontentloaded')
    page.locator('#studentResetPasswordForm').wait_for()
    page.wait_for_timeout(1800)
    assert page.locator('#studentResetPasswordForm').is_visible()
    assert page.locator('#recoveryNewPassword').count() == 0
    assert page.locator('#qlKicked').count() == 0
    assert not page.evaluate('!!state.user')
    fill_password(page)
    save(page)
    finish_assertions(page)
    assert not errors, errors
    ok('Refresh preserves verified recovery intent without entering the app')
    context.close()

    context, page, errors = open_app('?student_recovery=1')
    page.evaluate("authTest.session={user:authTest.user,expires_at:Math.floor(Date.now()/1000)+3600};sessionStorage.setItem('local-recovery-session',JSON.stringify(authTest.session))")
    page.reload(wait_until='domcontentloaded')
    page.locator('#studentResetPasswordForm').wait_for()
    page.wait_for_timeout(1800)
    assert not page.evaluate('!!state.user')
    assert not calls(page, 'ql_device_check')
    fill_password(page)
    save(page)
    finish_assertions(page)
    assert not errors, errors
    ok('Recovery email URL opens the student reset screen, without the Admin dialog')
    context.close()

    context, page, errors = open_app()
    begin_recovery(page)
    page.locator('#focusStudentLogin').click()
    assert not page.evaluate('isStudentPasswordRecovery()')
    page.locator('#focusStudentRegister').click()
    page.locator('#studentRegisterName').fill('Local test')
    page.locator('#studentRegisterIdentifier').fill('audit@example.test')
    if not page.locator('.ql-strong-no').is_visible():
        page.locator('#studentRegisterPassword').click()
    page.locator('.ql-strong-no').click()
    page.locator('#studentRegisterPassword').fill('Old-password-123!')
    page.locator('#studentRegisterConfirm').fill('Old-password-123!')
    page.locator('#studentRegisterSubmit').click()
    page.locator('#studentSignupCode').fill('123456')
    page.locator('#studentSignupCodeForm button[type="submit"]').click()
    page.locator('#studentLoginForm').wait_for()
    assert 'Email verified successfully.' in page.locator('#studentLoginStatus').inner_text()
    assert not page.evaluate('isStudentPasswordRecovery()||!!state.user||!!authTest.session')
    assert not errors, errors
    ok('Cancelling forgotten-password flow and ordinary signup verification remain unchanged')
    context.close()
    browser.close()

print(f'{len(passed)} password recovery/login scenarios passed; no live requests.', flush=True)
