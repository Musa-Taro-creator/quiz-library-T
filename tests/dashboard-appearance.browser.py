from pathlib import Path
import re,json,subprocess
from playwright.sync_api import sync_playwright
repo=Path(__file__).resolve().parents[1]
s=(repo/'index.html').read_text()
f=json.loads((repo/'tests/fixtures/dashboard-appearance.json').read_text())
script=lambda id:re.search(r'<script id="'+id+r'">([\s\S]*?)</script>',s)[1]
styles='\n'.join(re.findall(r'<style[^>]*>([\s\S]*?)</style>',s))
const_defs=s[s.index('const FOLDER_ICON_DEFS='):s.index('function shareOutSvg()')]
funcs=s[s.index('function folderIconDefinition('):s.index('function linkVisualType(')]
icon=s[s.index('function iconMarkup('):s.index('function cardMarkup(')]
# Execute the actual rendering, sharing and saving functions, with all I/O mocked.
setup=r'''
window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];
window.esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
window.documentBadgeMarkup=x=>`<span>${x.kind}</span>`;
window.calls=[];window.inserts=[];window.quizSaves=[];window.toasts=[];
window.uid=()=> 'copy-'+(inserts.length+1);window.nowIso=()=>new Date().toISOString();
window.LIBRARY_ID='mock-library';window.qlIsStudentWorkspace=()=>true;
window.state={user:{id:'mock-user'},items:[],selected:new Set()};
window.itemById=id=>state.items.find(x=>x.id===id);
window.descendants=id=>state.items.filter(x=>x.parent_id===id).flatMap(x=>[x.id,...descendants(x.id)]);
window.qlPathForFast=id=>[itemById(id)];window.fmtBytes=n=>String(n)+' bytes';
window.qlSafeUrl=u=>/^https?:\/\//.test(u||'')?u:null;
window.openModal=(title,body)=>{document.querySelector('#modal')?.remove();let m=document.createElement('div');m.id='modal';m.style.cssText='position:fixed;inset:0;z-index:200;background:white;overflow:auto';m.innerHTML=body;document.body.append(m)};
window.closeModal=()=>document.querySelector('#modal')?.remove();window.toast=t=>toasts.push(t);
window.friendlyError=e=>e.message||String(e);window.alert=t=>{throw Error(t)};window.confirm=()=>true;
window.qlUploadPath=id=>id+'.pdf';window.fetch=async()=>new Response(new Blob(['%PDF-1.4 simulated'],{type:'application/pdf'}));
window.replaceLocal=x=>state.items.push(x);window.loadAll=async()=>{};window.navigate=(...a)=>{window.navigated=a};
window.open=(...a)=>{window.opened=a};
window.service={
 client:{rpc:async(name,args)=>{calls.push({name,args});
  if(name==='ql_dash_list')return {data:window.listData};
  if(name==='ql_dash_full')return {data:window.packet};
  if(name==='ql_dash_open'){let p=structuredClone(window.packet);p.nodes.forEach(x=>{delete x.questions;delete x.quiz_settings});return {data:{payload:p}}}
  if(name==='ql_dash_post'){window.posted=args;return {data:'new-post'}};
  if(name==='ql_received_item_share_count')return {data:0};
  if(name==='ql_dash_delete_mine')return {data:null};
  throw Error('Unexpected RPC '+name)
 }},
 insertItem:async x=>{inserts.push(x);return x},
 saveQuizQuestions:async(...a)=>quizSaves.push(a),upload:async()=>{},
 signedUrl:async()=> 'https://example.test/doc.pdf',
 getQuizQuestionsAdmin:async()=>window.packet.nodes.find(x=>x.kind==='quiz').questions,
 createExternalQuizShare:async()=>({share_token:'mock-token'}),createShortShareLink:async()=>null,
 deleteMany:async()=>{},removeFiles:async()=>{}
};
'''
checks=0
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1280,'height':894});errors=[];network=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/*',lambda route:(network.append(route.request.url),route.abort()))
 page.set_content('<style>'+styles+'</style><body class="ql-skin ql-white"></body>')
 page.evaluate(setup)
 page.evaluate(const_defs+'\n'+funcs+'\n'+icon+'\n'+script('qlGlassIcons'))
 page.evaluate('(f)=>{window.listData=f.list;window.packet=f.packet}',f)
 page.evaluate(script('qlItemShare'))
 for theme in ['white','neon','ocean']:
  for width in [1280,768,390]:
   page.set_viewport_size({'width':width,'height':894})
   page.evaluate('(theme)=>document.body.className="ql-skin ql-"+theme',theme)
   page.evaluate('qlOpenDash()')
   card=page.locator('[data-post="'+f['gray']+'"]')
   assert card.locator('.folder-icon').get_attribute('style')=='--item-color:#65676B'
   assert card.locator('.folder-center-icon svg').count()==1
   assert card.locator('.ql-glass-folder-wrap').evaluate('(x)=>getComputedStyle(x).color')=='rgb(101, 103, 107)'
   for title,color,has_icon in [('legacy','#F6C64A',False),('default','#F6C64A',False),('red','#C71F27',False),('custom','#123ABC',True)]:
    row=page.locator('.qd-item').filter(has=page.locator('.item-title',has_text=re.compile('^'+title+'$')))
    assert row.locator('.folder-icon').get_attribute('style')=='--item-color:'+color
    assert bool(row.locator('.folder-center-icon svg').count())==has_icon
   for kind in ['pdf','quiz','link']:
    row=page.locator('.qd-item').filter(has=page.locator('.item-title',has_text=re.compile('^'+kind+'$')))
    assert row.locator('.ql-glass-'+kind).count()==1
   checks+=1
 # My posts uses the same saved appearance; item status, search, filtering unchanged.
 page.evaluate('(x)=>window.listData=x',f['mineList']);page.evaluate('qlOpenDash()')
 page.locator('[data-qd-tab="mine"]').click()
 assert page.locator('[data-post="'+f['gray']+'"] .folder-icon').get_attribute('style')=='--item-color:#65676B';checks+=1
 assert page.locator('[data-post="'+f['gray']+'"] .qd-tag').inner_text()=='On the Dashboard';checks+=1
 page.locator('[data-qd-kind="folder"]').click();assert page.locator('.qd-item .file-icon').count()==0;checks+=1
 page.locator('.qd-search').fill('recommendations');page.wait_for_timeout(350);assert page.locator('.qd-item').count()==1;checks+=1
 page.locator('.qd-search').fill('');page.wait_for_timeout(350)
 page.locator('[data-qd-kind=""]').click();page.locator('[data-qd-tab="all"]').click()
 # Folder opens with root children rendered in their original appearance.
 page.locator('[data-post="'+f['gray']+'"]').click()
 assert page.locator('[data-ref="child"] .folder-icon').get_attribute('style')=='--item-color:#2244FF';checks+=1
 assert page.locator('[data-ref="child"] .folder-center-icon svg').count()==1;checks+=1
 page.locator('.ql-iv-close').last.click()
 # Save as another user; copy root, child, PDF, quiz and link. No actual network/database.
 page.evaluate('(x)=>window.listData=x',f['list']);page.evaluate('qlOpenDash()')
 page.locator('[data-post="'+f['gray']+'"] [data-qd-more]').click()
 page.locator('#qlDashMenu .ql-dash-save').click();page.locator('#qlDashSaveGo').click()
 page.wait_for_function('inserts.length===5 && toasts.includes("Saved to your library")')
 ins=page.evaluate('inserts');root=next(x for x in ins if x['title']=='App recommendations')
 assert root['color']=='#65676B' and root['icon']=='book' and root['parent_id']==None;checks+=1
 child=next(x for x in ins if x['title']=='Child');assert child['color']=='#2244FF' and child['icon']=='atom' and child['parent_id']==root['id'];checks+=1
 assert all(x['ql_from_dash'] for x in ins);checks+=1
 qs=page.evaluate('quizSaves');assert qs[0][1][0]['correct_answer']==False and qs[0][2]=={'shuffle':True};checks+=1
 assert any(x.get('storage_path') for x in ins if x['kind']=='pdf');checks+=1
 assert next(x for x in ins if x['kind']=='link')['url']=='https://example.test';checks+=1
 # Older backend stays compatible: missing appearance gracefully defaults.
 old=json.loads(json.dumps(f['list']))
 for group in ['posts','mine']:
  for r in old[group]: r.pop('appearance',None)
 page.evaluate('(x)=>window.listData=x',old);page.evaluate('qlOpenDash()')
 assert page.locator('[data-post="'+f['gray']+'"] .folder-icon').get_attribute('style')=='--item-color:#F6C64A';checks+=1
 # HTML-like icon text stays escaped by the unchanged renderer.
 bad=json.loads(json.dumps(f['list']));next(r for r in bad['posts'] if r['id']==f['gray'])['appearance']={'color':'#65676B','icon':'<img src=x onerror="window.bad=true">'}
 page.evaluate('(x)=>window.listData=x',bad);page.evaluate('qlOpenDash()')
 assert page.locator('[data-post="'+f['gray']+'"] .folder-center-icon img').count()==0
 assert not page.evaluate('!!window.bad');checks+=1
 assert not errors,errors
 assert not network,network
 print(f'{checks} Chromium functional/layout scenarios passed; no browser errors or external requests.')
 b.close()
