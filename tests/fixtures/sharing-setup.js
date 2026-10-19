
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
