/* Rooms are loaded only when opened. Existing library services remain the
   fallback; room item identifiers always route to the room RPC. */
const old={},locations=new Map(),quizCache=new Map(),attempts=new Map();
let ctx=null,backup=null,screen=null,busy=false,polling=false,copying=false;
const who=()=>String(state.user?.id||'');
const h=v=>esc(String(v??''));
const keys=['insertItem','updateItem','updateMany','deleteMany','verifyOwner','saveQuizQuestions','saveQuizQuestionsPartial','getQuizQuestionsAdmin','getQuizForTaking','gradeQuizQuestion','submitQuizAttempt','listQuizAttempts','getItems'];
keys.forEach(k=>old[k]=service[k]?.bind(service));
async function call(action,room=null,data={}){
 const user=who();if(!user)throw Error('Sign in to use Rooms.');
 const {data:result,error}=await service.client.rpc('ql_room_v1',{p_action:action,p_room:room,p_data:data});
 if(who()!==user)throw Error('Account changed. Reopen Rooms.');if(error)throw error;return result;
}
const where=id=>locations.get(String(id));
function remember(row){if(row?._room_id){locations.set(String(row.id),{room:row._room_id,user:who()});if(ctx?.room.id===row._room_id)replaceLocal(row)}return row}
async function itemCall(id,action,data={}){const x=where(id);if(!x||x.user!==who())throw Error('Reopen this room in the correct account.');return await call(action,x.room,{id,...data})}
export function canEdit(item){return !item?._room_id||!!(ctx?.room.id===item._room_id&&ctx.can_edit&&ctx.config.permissions?.edit!==false&&ctx.room.permissions?.edit!==false)}
function install(){
 service.getItems=async()=>ctx&&!copying?state.items:old.getItems();
 service.insertItem=async p=>ctx&&!copying?remember(await call('insert',ctx.room.id,{id:p.id||uid(),payload:p})):old.insertItem(p);
 service.updateItem=async(id,p)=>{
  if(!where(id))return old.updateItem(id,p);
  const taking=!!document.getElementById('qzExamShell');
  if(taking&&p.quiz_settings&&Object.keys(p).every(k=>k==='quiz_settings'))return remember(await itemCall(id,'quiz_tools',{settings:p.quiz_settings}));
  return remember(await itemCall(id,'patch',{patch:p}));
 };
 service.updateMany=async(ids,p)=>{if(!ids.some(where))return old.updateMany(ids,p);const out=[];for(const id of ids)out.push(await service.updateItem(id,p));return out};
 service.deleteMany=async ids=>{if(!ids.some(where))return old.deleteMany(ids);for(const id of ids){await itemCall(id,'delete');if(ctx)state.items=state.items.filter(x=>x.id!==id)}};
 service.verifyOwner=async()=>{if(!ctx)return old.verifyOwner();if(!ctx.can_edit)throw Error('Editing is restricted for this room.');return {user:state.user,library:state.library,student:true}};
 service.getQuizQuestionsAdmin=async id=>{
  if(!where(id))return old.getQuizQuestionsAdmin(id);const row=remember(await itemCall(id,'item_get'));quizCache.set(String(id),row);
  const qs=(row._student_questions||[]).slice();Object.defineProperties(qs,{_qlRevision:{value:row._qlRevision},_qlItem:{value:row}});return qs;
 };
 service.getQuizForTaking=async id=>{
  if(!where(id))return old.getQuizForTaking(id);const row=remember(await itemCall(id,'quiz_take'));quizCache.set(String(id),row);
  return {title:row.title,settings:row.quiz_settings||{},questions:row._student_questions||[]};
 };
 service.gradeQuizQuestion=async(id,qid,given)=>{
  if(!where(id))return old.gradeQuizQuestion(id,qid,given);const q=quizCache.get(String(id))?._student_questions?.find(q=>q.id===qid);if(!q)throw Error('Question not found.');
  const g=window.__quizTest.qzGradeAll([q],{[qid]:given}).detail[0];return {...g,points:Number(q.points)||1};
 };
 service.submitQuizAttempt=async(id,name,identifier,answers,startedAt,meta)=>{
  if(!where(id))return old.submitQuizAttempt(id,name,identifier,answers,startedAt,meta);
  const row=quizCache.get(String(id)),key=JSON.stringify([who(),id,startedAt,meta?.session_name||null]);
  if(!attempts.has(key))attempts.set(key,uid());
  return itemCall(id,'quiz_submit',{attempt_id:attempts.get(key),revision:row?._qlRevision,answers,started_at:startedAt,session_name:meta?.session_name||null});
 };
 service.listQuizAttempts=async id=>where(id)?itemCall(id,'quiz_history'):old.listQuizAttempts(id);
 service.saveQuizQuestions=async(id,qs,settings,options={})=>where(id)?saveFull(id,qs,settings,options):old.saveQuizQuestions(id,qs,settings,options);
 service.saveQuizQuestionsPartial=async(id,changed,settings,options={})=>{
  if(!where(id))return old.saveQuizQuestionsPartial(id,changed,settings,options);
  const base=quizCache.get(String(id))||await itemCall(id,'item_get'),byId=new Map((base._student_questions||[]).map(q=>[q.id,q]));
  for(const q of changed){if(!byId.has(q.id))throw Error('QL_CONFLICT: A question was removed. Draft retained.');const {position,...rest}=q;byId.set(q.id,{...byId.get(q.id),...rest,question_position:position})}
  return saveFull(id,[...byId.values()].sort((a,b)=>(a.question_position||0)-(b.question_position||0)),settings,options);
 };
 const priorRoute=currentRoute;currentRoute=function(){const route=priorRoute();return ctx&&backup?{...route,section:backup.section,folderId:backup.folder}:route};
 const priorLoad=loadAll;loadAll=async(...args)=>ctx&&!copying&&backup?.user===who()?refresh():priorLoad(...args);
 const priorRender=render;render=function(){if(backup&&backup.user!==who()){backup=null;ctx=null;screen?.remove();screen=null;state.items=state.items.filter(x=>!x._room_id);window.qlUiBack?.close('rooms')}const out=priorRender.apply(this,arguments);if(ctx&&screen?.isConnected)drawRoom();return out};
}
async function saveFull(id,questions,settings,options){
 const row=quizCache.get(String(id))||await itemCall(id,'item_get');const saveId=options.saveId||uid();
 const raw=new TextEncoder().encode(JSON.stringify({questions,settings})),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),b=>b.toString(16).padStart(2,'0')).join('');
 const parts=[];let batch=[],bytes=2;for(const q of questions){const size=new TextEncoder().encode(JSON.stringify(q)).length+1;if(size>7000000)throw Error('One question is too large to save. Reduce its image size; your draft is retained.');if(batch.length&&(batch.length>=200||bytes+size>4000000)){parts.push(batch);batch=[];bytes=2}batch.push(q);bytes+=size}if(batch.length||!parts.length)parts.push(batch);
 let result=await itemCall(id,'save_begin',{save_id:saveId,revision:options.expectedRevision??row._qlRevision,fingerprint:hash,count:questions.length,parts:parts.length,settings});
 if(!result?.id){for(let n=0;n<parts.length;n++)await itemCall(id,'save_part',{save_id:saveId,part:n,questions:parts[n]});result=await itemCall(id,'save_finish',{save_id:saveId})}
 quizCache.set(String(id),{...result,_student_questions:questions});return remember(result);
}
function restore(){
 if(!backup)return;const saved=backup;backup=null;ctx=null;
 if(saved.user===who()){state.items=saved.items;state.section=saved.section;state.folderId=saved.folder;state.selected=saved.selected;render()}
 else{state.items=state.items.filter(x=>!x._room_id);state.folderId=null;render()}
}
function close(){if(busy)return;restore();screen?.remove();screen=null;window.qlUiBack?.close('rooms')}
function back(){if(busy)return;if(ctx){if(ctx.folder){ctx.folder=(itemById(ctx.folder)||{}).parent_id||null;drawRoom()}else{restore();showList()}}else close()}
const top=(title,sub,extra='')=>`<div class="rm-top"><button class="btn" data-rm-back>‹ Back</button><div><h1>${h(title)}</h1><small>${h(sub)}</small></div><span class="rm-spacer"></span>${extra}<button class="btn" data-rm-close aria-label="Close Rooms">×</button></div>`;
function wireTop(){screen.querySelector('[data-rm-back]').onclick=back;screen.querySelector('[data-rm-close]').onclick=close}
function showError(e){const m=String(e?.message||e);return /ql_room_v1|PGRST202|42883/.test(m)?'Rooms needs its one-time Supabase setup. Your personal library is available with Back.':friendlyError(e)}
export async function openRooms(){
 if(!who())return toast('Sign in to use Rooms.');if(screen?.isConnected)return;
 screen=document.createElement('section');screen.id='qlRooms';document.body.append(screen);window.qlUiBack?.open('rooms',()=>!!screen?.isConnected,back);await showList();
}
async function showList(){
 if(!screen?.isConnected)return;screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Shared libraries for classes and study groups')}<div class="rm-card">Loading…</div></div>`;wireTop();
 try{const data=await call('list');if(!screen?.isConnected||ctx)return;
  screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Join with a room code. Members can create and edit together.')}<div class="rm-actions"><button class="btn primary" data-rm-create>Create Room</button><button class="btn" data-rm-join>Join Room</button></div><div class="rm-grid">${(data.rooms||[]).map(r=>`<button class="rm-card rm-room" data-rm-open="${h(r.id)}"><strong>${h(r.name)}</strong><span>${r.members} members · ${h(r.owner_name)}</span><small>${h(r.status)}${r.locked?' · editing locked':''}</small></button>`).join('')||'<div class="rm-card">No rooms yet. Create one or ask its owner for a code.</div>'}</div></div>`;
  wireTop();screen.querySelector('[data-rm-create]').onclick=()=>roomForm();screen.querySelector('[data-rm-join]').onclick=()=>joinForm();screen.querySelectorAll('[data-rm-open]').forEach(b=>b.onclick=()=>enter(b.dataset.rmOpen));
 }catch(e){screen.querySelector('.rm-card').textContent=showError(e)}
}
function roomModal(title,body){openModal(title,`<div class="room-dialog">${body}</div>`)}
function roomForm(){roomModal('Create Room','<label>Room name<input id="rmName" maxlength="100" placeholder="e.g. MD-Y3-S2"></label><label>Description<textarea id="rmDesc" maxlength="1000"></textarea></label><div class="status">Members have full editing access by default. You can restrict it in Room settings.</div><div class="form-actions"><button class="btn" id="rmCancel">Cancel</button><button class="btn primary" id="rmSubmit">Create Room</button></div>');document.getElementById('rmCancel').onclick=closeModal;document.getElementById('rmSubmit').onclick=async e=>{e.target.disabled=true;try{const r=await call('create',null,{name:document.getElementById('rmName').value,description:document.getElementById('rmDesc').value});closeModal();await enter(r.id)}catch(e){alert(showError(e));document.getElementById('rmSubmit').disabled=false}}}
function joinForm(){roomModal('Join Room','<label>Room code<input id="rmCode" maxlength="20" autocomplete="off" placeholder="Enter the owner’s room code"></label><div class="form-actions"><button class="btn" id="rmCancel">Cancel</button><button class="btn primary" id="rmSubmit">Join Room</button></div>');document.getElementById('rmCancel').onclick=closeModal;document.getElementById('rmSubmit').onclick=async e=>{e.target.disabled=true;try{const r=await call('join',null,{code:document.getElementById('rmCode').value});closeModal();await enter(r.id)}catch(e){alert(showError(e));document.getElementById('rmSubmit').disabled=false}}}
async function enter(id){
 try{const data=await call('open',id);if(!screen?.isConnected)return;
  if(!backup)backup={user:who(),items:state.items,section:state.section,folder:state.folderId,selected:state.selected};
  ctx={...data,folder:null};state.items=data.items||[];state.items.forEach(remember);state.section='documents';state.folderId=null;state.selected=new Set();drawRoom();
 }catch(e){alert(showError(e))}
}
function permitted(k){return ctx?.can_edit&&ctx.config?.permissions?.[k]!==false&&ctx.room.permissions?.[k]!==false}
function drawRoom(){
 if(!ctx||!screen?.isConnected)return;state.folderId=ctx.folder||null;const pos=screen.scrollTop;let names=[],f=itemById(state.folderId),guard=0;while(f&&guard++<200){names.unshift(f);f=itemById(f.parent_id)}
 if(history.state?.qlUiLayer==='rooms')history.replaceState({...history.state,...currentRoute()},'',location.href);
 const rows=state.items.filter(x=>ctx.trash?x.is_trashed:!x.is_trashed&&x.parent_id===state.folderId).sort((a,b)=>(a.kind==='folder'?0:1)-(b.kind==='folder'?0:1)||String(a.title).localeCompare(String(b.title)));
 screen.innerHTML=`<div class="rm-wrap">${top(ctx.room.name,ctx.can_edit?'Shared room · everyone’s changes appear here':'Shared room · your editing access is restricted',ctx.manager?'<button class="btn" data-rm-manage>Room settings</button>':'<button class="btn" data-rm-leave>Leave Room</button>')}<div class="rm-actions"><button class="btn" data-rm-tool="pdf" ${permitted('pdf')?'':'disabled'}>Upload PDF</button><button class="btn" data-rm-tool="link" ${permitted('link')?'':'disabled'}>Add Quiz Link</button><button class="btn" data-rm-tool="folder" ${permitted('folder')?'':'disabled'}>New Folder</button><button class="btn primary" data-rm-tool="quiz" ${permitted('quiz')?'':'disabled'}>Create Quiz</button><button class="btn" data-rm-refresh>↻ Refresh</button><button class="btn" data-rm-trash>${ctx.trash?'All items':'Trash'}</button></div><div class="rm-crumbs"><button data-rm-path="">${h(ctx.room.name)}</button>${names.map(x=>`<span>›</span><button data-rm-path="${h(x.id)}">${h(x.title)}</button>`).join('')}</div><div class="rm-grid">${rows.map(x=>`<article class="rm-item" data-rm-item="${h(x.id)}" tabindex="0"><button class="rm-more" data-rm-more="${h(x.id)}" aria-label="Item actions">⋮</button>${iconMarkup(x)}<div class="item-title">${h(x.title)}</div><small class="rm-note">${h(x.kind==='quiz'?`${x.quiz_settings?.question_count||0} questions`:x.kind)}</small></article>`).join('')||'<div class="rm-card">This folder is empty.</div>'}</div></div>`;
 wireTop();screen.scrollTop=pos;
 screen.querySelector('[data-rm-manage]')?.addEventListener('click',manage);
 screen.querySelector('[data-rm-leave]')?.addEventListener('click',async()=>{if(confirm('Leave this room? Your personal library is kept.'))try{await call('leave',ctx.room.id);restore();showList()}catch(e){alert(showError(e))}});
 screen.querySelector('[data-rm-refresh]').onclick=refresh;screen.querySelector('[data-rm-trash]').onclick=()=>{ctx.trash=!ctx.trash;drawRoom()};
 screen.querySelectorAll('[data-rm-path]').forEach(b=>b.onclick=()=>{ctx.folder=b.dataset.rmPath||null;ctx.trash=false;drawRoom()});
 screen.querySelectorAll('[data-rm-tool]').forEach(b=>b.onclick=()=>{if(b.disabled)return;const k=b.dataset.rmTool;if(k==='pdf')openUpload();if(k==='link')openEditor('link');if(k==='folder')openFolderEditor();if(k==='quiz')window.__quizTest.openQuizCreateModal()});
 screen.querySelectorAll('[data-rm-item]').forEach(b=>{const run=e=>{if(e.target.closest('[data-rm-more]'))return;const x=itemById(b.dataset.rmItem);if(ctx.trash)return;if(x.kind==='folder'){ctx.folder=x.id;drawRoom();screen.scrollTop=0}else if(x.kind==='quiz')window.__quizTest.openQuizLanding(x);else openItem(x)};b.onclick=run;b.onkeydown=e=>{if(e.key==='Enter')run(e)}});
 screen.querySelectorAll('[data-rm-more]').forEach(b=>b.onclick=e=>{e.stopPropagation();itemMenu(itemById(b.dataset.rmMore))});
}
async function refresh(){if(!ctx||polling)return;polling=true;const rid=ctx.room.id;try{const data=await call('open',rid,{since:ctx.version});if(ctx?.room.id!==rid||data.unchanged)return;const trash=ctx.trash,folder=ctx.folder;ctx={...data,trash,folder};state.items=data.items||[];state.items.forEach(remember);drawRoom()}catch(e){toast(showError(e))}finally{polling=false}}
function itemMenu(x){
 const allowed=canEdit(x),trash=!!x.is_trashed,trashAllowed=permitted('trash');
 roomModal(x.title,`<div class="form-actions">${allowed?trash?`<button class="btn" data-room-action="restore" ${trashAllowed?'':'disabled'}>Restore</button><button class="btn danger-text" data-room-action="delete" ${trashAllowed?'':'disabled'}>Delete permanently</button>`:`<button class="btn" data-room-action="edit">Edit</button><button class="btn" data-room-action="move">Move</button><button class="btn" data-room-action="duplicate">Duplicate</button><button class="btn danger-text" data-room-action="trash" ${trashAllowed?'':'disabled'}>Trash</button>`:''}<button class="btn" data-room-action="copy" ${ctx.config.permissions?.save_copy===false||ctx.room.permissions?.save_copy===false?'disabled':''}>Save to My Library</button><button class="btn" data-room-action="close">Close</button></div>`);
 document.querySelectorAll('[data-room-action]').forEach(b=>b.onclick=async()=>{const a=b.dataset.roomAction;closeModal();try{if(a==='edit'){if(x.kind==='quiz')window.__quizTest.openQuizWorkspace(x);else if(x.kind==='folder')openFolderEditor(x);else openEditor(x)}if(a==='move')openMove([x.id]);if(a==='duplicate')await duplicateRoom(x);if(a==='trash'){await trashItems([x.id]);drawRoom()}if(a==='restore'){await restoreItems([x.id]);drawRoom()}if(a==='delete'&&confirm('Permanently delete this room item?')){await service.deleteMany([x.id]);await refresh()}if(a==='copy')await copyToLibrary(x)}catch(e){alert(showError(e))}});
}
async function duplicateRoom(root){
 const ids=new Map(),source=[root,...(root.kind==='folder'?descendants(root.id).map(itemById).filter(x=>x&&!x.is_trashed):[])];
 for(const x of source){
  const full=x.kind==='quiz'?await itemCall(x.id,'item_get'):x,id=uid();
  const row=await service.insertItem({...full,id,title:x.id===root.id?x.title+' copy':x.title,parent_id:ids.get(x.parent_id)||x.parent_id,created_at:nowIso(),is_trashed:false});ids.set(x.id,id);
  if(x.kind==='quiz')await service.saveQuizQuestions(id,(full._student_questions||[]).map(q=>({...q,id:uid()})),full.quiz_settings||{});
 }
 drawRoom();toast('Duplicated');
}
async function manage(){
 await refresh();const room=ctx.room,members=ctx.members||[];
 roomModal('Room settings',`<label>Room name<input id="rmEditName" value="${h(room.name)}" maxlength="100"></label><p>Invitation code: <strong class="rm-code">${h(room.invite_code)}</strong></p><div class="form-actions"><button class="btn" id="rmCopyCode">Copy code</button><button class="btn" id="rmResetCode">New code</button><button class="btn" id="rmActivity">Activity history</button></div><label><input type="checkbox" id="rmLocked" ${room.locked?'checked':''}> Lock member editing</label><label><input type="checkbox" id="rmJoin" ${room.permissions.join===false?'':'checked'}> Allow joining with the code</label><label><input type="checkbox" id="rmSaveCopy" ${room.permissions.save_copy===false?'':'checked'}> Allow saving a copy to My Library</label><div class="form-actions"><button class="btn primary" id="rmSaveSettings">Save settings</button><button class="btn" id="rmRoomStatus">${room.status==='closed'?'Reopen room':'Close room'}</button></div><h3>Members</h3>${members.map(m=>`<div class="rm-member"><strong>${h(m.name)}</strong> ${m.user_id===room.owner_id?'Owner':`<span>${m.status==='blocked'?'Blocked':m.can_edit?'Full access':'Read only'}</span><button class="btn" data-rm-member="${h(m.user_id)}" data-action="edit">${m.can_edit?'Read only':'Allow editing'}</button><button class="btn" data-rm-member="${h(m.user_id)}" data-action="block">${m.status==='blocked'?'Restore access':'Remove access'}</button>`}</div>`).join('')}<div class="form-actions"><button class="btn" id="rmManageClose">Close</button></div>`);
 const act=async(data)=>{try{await call('settings',room.id,data);closeModal();await refresh()}catch(e){alert(showError(e))}};
 document.getElementById('rmManageClose').onclick=closeModal;document.getElementById('rmCopyCode').onclick=async()=>{try{await navigator.clipboard.writeText(room.invite_code);toast('Room code copied')}catch{prompt('Copy this room code',room.invite_code)}};
 document.getElementById('rmResetCode').onclick=()=>confirm('Replace the invitation code? The old code will stop working.')&&act({reset_code:true});
 document.getElementById('rmSaveSettings').onclick=()=>act({name:document.getElementById('rmEditName').value,locked:document.getElementById('rmLocked').checked,permissions:{...room.permissions,join:document.getElementById('rmJoin').checked,save_copy:document.getElementById('rmSaveCopy').checked}});
 document.getElementById('rmRoomStatus').onclick=()=>confirm(room.status==='closed'?'Reopen this room?':'Close this room for members?')&&act({status:room.status==='closed'?'active':'closed'});
 document.querySelectorAll('[data-rm-member]').forEach(b=>b.onclick=async()=>{const m=members.find(x=>x.user_id===b.dataset.rmMember);try{await call('member',room.id,{user_id:m.user_id,...(b.dataset.action==='edit'?{can_edit:!m.can_edit}:{status:m.status==='blocked'?'active':'blocked'})});closeModal();await manage()}catch(e){alert(showError(e))}});
 document.getElementById('rmActivity').onclick=async()=>{try{const rows=await call('activity',room.id);roomModal('Room activity',rows.map(e=>`<p><b>${h(e.actor_name)}</b> · ${h(e.action.replaceAll('_',' '))}<br>${h(e.title)}<br><small>${h(new Date(e.created_at).toLocaleString())}</small></p>`).join('')||'<p>No activity yet.</p>')}catch(e){alert(showError(e))}};
}
async function copyToLibrary(x){
 if(busy||!backup)return;const roomItems=state.items,folder=state.folderId,selection=state.selected,source=ctx;busy=true;copying=true;
 let privateActive=false;const made=[],files=[],owner=who();const check=()=>{if(who()!==owner)throw Error('Account changed. Copy cancelled.')};
 try{
  await itemCall(x.id,'copy_get');const all=x.kind==='folder'?[x,...descendants(x.id).map(itemById).filter(i=>i&&!i.is_trashed)]:[x],full=[];
  for(const it of all)full.push(it.kind==='quiz'?await itemCall(it.id,'item_get'):it);
  state.items=backup.items;privateActive=true;state.folderId=null;state.selected=new Set();
  const map=new Map();for(const it of full){check();const id=uid(),copy={...it,id,parent_id:it.id===x.id?null:map.get(it.parent_id)||null,created_at:nowIso(),updated_at:nowIso(),is_trashed:false};delete copy._room_id;delete copy._qlRevision;delete copy._student_questions;
   if(it.kind==='pdf'){const {data,error}=await service.client.storage.from(BUCKET).createSignedUrl(it.storage_path,300);if(error)throw error;const response=await fetch(data.signedUrl);if(!response.ok)throw Error('Could not copy PDF.');const blob=await response.blob();check();const path=qlUploadPath(id);await service.upload(new File([blob],it.title+'.pdf',{type:'application/pdf'}),path);files.push(path);copy.storage_path=path;}
   check();const row=await old.insertItem(copy);check();replaceLocal(row);made.push(id);map.set(it.id,id);
   if(it.kind==='quiz')await old.saveQuizQuestions(id,(it._student_questions||[]).map(q=>({...q,id:uid()})),copy.quiz_settings||{});
  }
  backup.items=state.items;toast('Saved an independent copy to My Library');
 }catch(e){try{if(who()===owner){if(made.length)await old.deleteMany(made);if(files.length)await service.removeFiles(files);if(privateActive){state.items=state.items.filter(it=>!made.includes(it.id));backup.items=state.items}}}catch{}throw e}
 finally{busy=false;copying=false;if(who()===owner){state.items=roomItems;state.folderId=folder;state.selected=selection;ctx=source;drawRoom()}else{restore();close()}}
}
install();window.qlRooms={canEdit,active:()=>ctx?.room.id||null,capturePersonalRefresh:rows=>{if(ctx&&backup?.user===who()&&!copying){backup.items=rows;return true}return false},refresh,openRooms};
setInterval(()=>{if(ctx&&backup?.user!==who()){close();return}if(ctx&&document.visibilityState==='visible'&&!document.querySelector('#qzPageOverlay.show,#modalOverlay.show')&&!busy)refresh()},30000);
