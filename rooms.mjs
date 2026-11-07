/* Rooms are loaded only when opened. Existing library services remain the
   fallback; room item identifiers always route to the room RPC. */
const old={},locations=new Map(),quizCache=new Map(),attempts=new Map();
let ctx=null,backup=null,screen=null,busy=false,polling=false,copying=false,listScroll=0,listFocus=null,listRequest=0,entryRequest=0;
const views=new Map();
const who=()=>String(state.user?.id||'');
const h=v=>esc(String(v??''));
const paths={group:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87',back:'m15 18-6-6 6-6',arrow:'M5 12h14m-6-6 6 6-6 6',plus:'M12 5v14M5 12h14',close:'m6 6 12 12M6 18 18 6',pdf:'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-3 3M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l3-3',folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 3v7m-3-3h6',quiz:'M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 2h6v4H9V2Zm0 12 2 2 4-5',refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',lock:'M6 11V7a6 6 0 0 1 12 0v4M4 11h16v11H4V11Zm8 4v3',edit:'m4 16 12-12 4 4L8 20H4v-4Z',move:'M12 3v18M3 12h18m-6-6-3-3-3 3m6 12-3 3-3-3M6 9l-3 3 3 3m12-6 3 3-3 3',copy:'M9 9h12v12H9V9ZM15 6V3H3v12h3',history:'M3 3v6h6M3 9a9 9 0 1 1 0 6m9-9v6l4 2'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${name==='group'?'<circle cx="9" cy="7" r="4"/>':''}<path d="${paths[name]||paths.folder}"/></svg>`;
const badge=(text,cls='')=>`<span class="rm-badge ${cls}">${h(text)}</span>`;
function emptyState(title,text){return `<div class="rm-empty"><span class="rm-empty-icon">${icon('folder')}</span><h3>${h(title)}</h3><p>${h(text)}</p></div>`}
function viewKey(){return ctx?[ctx.room.id,ctx.folder||'',!!ctx.trash].join(':'):''}
function rememberView(){if(ctx&&screen)views.set(viewKey(),screen.scrollTop)}
function focusOn(selector){screen?.querySelector(selector)?.focus({preventScroll:true})}
function positionView(selector){if(screen)screen.scrollTop=views.get(viewKey())||0;if(selector)focusOn(selector)}
function goFolder(id,focus){if(!ctx)return;rememberView();ctx.folder=id||null;ctx.trash=false;drawRoom();positionView(focus)}
function toggleTrash(){rememberView();ctx.trash=!ctx.trash;drawRoom();positionView('[data-rm-trash]')}
function returnToList(){if(!ctx)return;rememberView();listFocus=ctx.room.id;restore();showList()}
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
function back(){
 if(busy)return;
 if(!ctx)return close();
 if(ctx.trash)return toggleTrash();
 if(ctx.folder){const from=ctx.folder;return goFolder(itemById(from)?.parent_id,`[data-rm-item="${CSS.escape(from)}"]`)}
 returnToList();
}
function backLabel(){if(!ctx)return 'My Library';if(ctx.trash)return 'Back to items';if(!ctx.folder)return 'All Rooms';const parent=itemById(ctx.folder)?.parent_id;return 'Back to '+(parent?itemById(parent)?.title||ctx.room.name:ctx.room.name)}
const top=(title,sub,extra='')=>`<header class="rm-top"><button class="rm-back" data-rm-back title="${h(backLabel())}">${icon('back')}<span>${h(backLabel())}</span></button><div class="rm-brand"><span class="rm-brand-icon">${icon('group')}</span><div><h1>${h(title)}</h1><p>${h(sub)}</p></div></div><div class="rm-top-actions">${extra}<button class="rm-icon-button" data-rm-close aria-label="Close Rooms and return to My Library" title="Return to My Library">${icon('close')}</button></div></header>`;
function wireTop(){screen.querySelector('[data-rm-back]').onclick=back;screen.querySelector('[data-rm-close]').onclick=close;screen.querySelectorAll('[data-rm-all]').forEach(b=>b.onclick=returnToList)}
function showError(e){const m=String(e?.message||e);return /ql_room_v1|PGRST202|42883/.test(m)?'Rooms needs its one-time Supabase setup. Your personal library is available with Back.':friendlyError(e)}
export async function openRooms(){
 if(!who())return toast('Sign in to use Rooms.');if(screen?.isConnected)return;
 screen=document.createElement('section');screen.id='qlRooms';document.body.append(screen);window.qlUiBack?.open('rooms',()=>!!screen?.isConnected,back);await showList();
}
async function showList(){
 if(!screen?.isConnected)return;const target=screen,request=++listRequest;
 screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Learn better, together')}<div class="rm-loading" role="status"><span></span>Loading your spaces…</div></div>`;wireTop();
 try{const data=await call('list');if(screen!==target||request!==listRequest||ctx)return;
  const rooms=data.rooms||[],owned=rooms.filter(r=>r.owner_id===who()).length;
  screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Learn better, together')}<section class="rm-welcome"><div><span class="rm-eyebrow">A PLACE FOR YOUR STUDY GROUP</span><h2>Your people.<br>Your shared library.</h2><p>Keep notes, links and quizzes together in one space.</p><div class="rm-actions"><button class="rm-button rm-primary" data-rm-create ${data.config?.enabled===false?'disabled':''}>${icon('plus')}Create Room</button><button class="rm-button" data-rm-join>${icon('group')}Join with a code</button></div></div><div class="rm-welcome-art" aria-hidden="true"><div class="rm-art-card rm-art-back">${icon('folder')}</div><div class="rm-art-card rm-art-front">${icon('group')}<span>BETTER TOGETHER</span><i></i><i></i></div><span class="rm-art-star">✦</span></div></section><div class="rm-overview"><span><b>${rooms.length}</b> ${rooms.length===1?'room':'rooms'}</span><span><b>${owned}</b> created by you</span><span><b>${rooms.length-owned}</b> joined</span></div><div class="rm-section-heading"><div><h2>Your spaces</h2><p>Choose a room to continue studying.</p></div></div><div class="rm-grid rm-room-grid">${rooms.map((r,n)=>`<button class="rm-room" data-rm-open="${h(r.id)}" style="--rm-hue:${[258,190,328,32][n%4]}"><div class="rm-room-cover"><span class="rm-room-symbol">${icon('group')}</span>${badge(r.status==='active'?(r.owner_id===who()?'Your room':'Member'):r.status,r.status==='active'?'':'rm-badge-warning')}<span class="rm-room-arrow">${icon('arrow')}</span></div><div class="rm-room-body"><h3>${h(r.name)}</h3><p class="rm-room-description">${h(r.description||'A shared space to learn and create together.')}</p><div class="rm-room-people"><span class="rm-avatar">${h((r.owner_name||'S').slice(0,1).toUpperCase())}</span><span>${h(r.owner_name||'Student')}<small>${r.members} ${r.members===1?'member':'members'}${r.locked?' · editing locked':''}</small></span></div><div class="rm-room-enter">Open room ${icon('arrow')}</div></div></button>`).join('')||emptyState('Your first shared space starts here','Create a room for your group, or join one with an invitation code.')}</div></div>`;
  wireTop();screen.scrollTop=listScroll;if(listFocus)focusOn(`[data-rm-open="${CSS.escape(listFocus)}"]`);
  screen.querySelector('[data-rm-create]').onclick=()=>roomForm();screen.querySelector('[data-rm-join]').onclick=()=>joinForm();screen.querySelectorAll('[data-rm-open]').forEach(b=>b.onclick=()=>enter(b.dataset.rmOpen));
 }catch(e){if(screen===target&&request===listRequest){screen.querySelector('.rm-loading').innerHTML=`${emptyState('Rooms couldn’t open',showError(e))}<button class="rm-button" data-rm-retry>Try again</button>`;screen.querySelector('[data-rm-retry]').onclick=showList}}
}
function roomModal(title,body){openModal(title,`<div class="room-dialog">${body}</div>`)}
function roomForm(){roomModal('Create Room','<div class="rm-dialog-intro"><span>'+icon('group')+'</span><p>Bring your study group together. You’ll manage this room and its members.</p></div><div class="form-grid rm-form"><label class="rm-field">Room name<input id="rmName" maxlength="100" placeholder="e.g. MD-Y3-S2"></label><label class="rm-field">Description<textarea id="rmDesc" maxlength="1000" placeholder="What will your group study?"></textarea></label></div><div class="status">Members have full editing access by default. You can restrict it in Room settings.</div><div class="form-actions"><button class="btn" id="rmCancel">Back to Rooms</button><button class="btn primary" id="rmSubmit">Create Room</button></div>');document.getElementById('rmCancel').onclick=closeModal;document.getElementById('rmSubmit').onclick=async e=>{e.target.disabled=true;try{const r=await call('create',null,{name:document.getElementById('rmName').value,description:document.getElementById('rmDesc').value});closeModal();await enter(r.id)}catch(e){alert(showError(e));document.getElementById('rmSubmit').disabled=false}}}
function joinForm(){roomModal('Join Room','<div class="rm-dialog-intro"><span>'+icon('link')+'</span><p>Enter the invitation code from your room owner.</p></div><div class="form-grid rm-form"><label class="rm-field">Room code<input id="rmCode" maxlength="20" autocomplete="off" placeholder="Enter the owner’s room code" spellcheck="false" autocapitalize="characters"></label></div><div class="form-actions"><button class="btn" id="rmCancel">Back to Rooms</button><button class="btn primary" id="rmSubmit">Join Room</button></div>');document.getElementById('rmCancel').onclick=closeModal;document.getElementById('rmSubmit').onclick=async e=>{e.target.disabled=true;try{const r=await call('join',null,{code:document.getElementById('rmCode').value});closeModal();await enter(r.id)}catch(e){alert(showError(e));document.getElementById('rmSubmit').disabled=false}}}
async function enter(id){
 const target=screen,request=++entryRequest;if(!ctx){listScroll=screen?.scrollTop||0;listFocus=id}
 try{const data=await call('open',id);if(screen!==target||!screen?.isConnected||request!==entryRequest)return;
  if(!backup)backup={user:who(),items:state.items,section:state.section,folder:state.folderId,selected:state.selected};
  ctx={...data,folder:null};state.items=data.items||[];state.items.forEach(remember);state.section='documents';state.folderId=null;state.selected=new Set();screen.scrollTop=0;drawRoom();
 }catch(e){if(screen===target&&request===entryRequest)alert(showError(e))}
}
function permitted(k){return ctx?.can_edit&&ctx.config?.permissions?.[k]!==false&&ctx.room.permissions?.[k]!==false}
function drawRoom(){
 if(!ctx||!screen?.isConnected)return;state.folderId=ctx.folder||null;const pos=screen.scrollTop;
 let names=[],f=itemById(state.folderId),guard=0;while(f&&guard++<200){names.unshift(f);f=itemById(f.parent_id)}
 if(history.state?.qlUiLayer==='rooms')history.replaceState({...history.state,...currentRoute()},'',location.href);
 const rows=state.items.filter(x=>ctx.trash?x.is_trashed:!x.is_trashed&&x.parent_id===state.folderId).sort((a,b)=>(a.kind==='folder'?0:1)-(b.kind==='folder'?0:1)||String(a.title).localeCompare(String(b.title)));
 const count=k=>state.items.filter(x=>!x.is_trashed&&x.kind===k).length;
 const room=ctx.room,locked=!ctx.can_edit,folder=names.at(-1),title=ctx.trash?'Trash':folder?.title||'Room library';
 const tools=[['pdf','Upload PDF','Share your notes'],['link','Add Quiz Link','Keep useful links'],['folder','New Folder','Keep things organized'],['quiz','Create Quiz','Build questions together']];
 screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Your shared study space')}<nav class="rm-crumbs" aria-label="Room location"><button data-rm-all>Rooms</button><span>›</span><button data-rm-path="" ${!ctx.folder&&!ctx.trash?'aria-current="page"':''}>${h(room.name)}</button>${names.map((x,n)=>`<span>›</span><button data-rm-path="${h(x.id)}" ${n===names.length-1&&!ctx.trash?'aria-current="page"':''}>${h(x.title)}</button>`).join('')}${ctx.trash?'<span>›</span><span aria-current="page">Trash</span>':''}</nav><section class="rm-room-hero"><span class="rm-hero-symbol">${icon('group')}</span><div class="rm-hero-copy"><div class="rm-hero-badges">${badge(ctx.manager?(room.owner_id===who()?'Room owner':'Website admin'):locked?'Read only':'Shared room')}${room.locked?badge('Editing locked','rm-badge-warning'):''}</div><h2>${h(room.name)}</h2><p>${h(room.description||'Notes, links and quizzes for your study group.')}</p><div class="rm-room-stats"><span>${icon('group')}${ctx.manager?`${ctx.members.length} ${ctx.members.length===1?'member':'members'}`:'Room member'}</span><span>${icon('folder')}${count('folder')} ${count('folder')===1?'folder':'folders'}</span><span>${icon('quiz')}${count('quiz')} ${count('quiz')===1?'quiz':'quizzes'}</span></div></div><div class="rm-hero-controls">${ctx.manager?`<button class="rm-button" data-rm-manage>${icon('settings')}Room settings</button>`:`<button class="rm-button rm-subtle" data-rm-leave>Leave Room</button>`}</div></section>${locked?`<div class="rm-access-note">${icon('lock')}You can open resources and take quizzes. Editing is managed by the room owner.</div>`:''}<div class="rm-tools" aria-label="Create in this room">${tools.map(([k,label,sub])=>`<button class="rm-tool rm-tool-${k}" data-rm-tool="${k}" ${permitted(k)?'':'disabled'}><span class="rm-tool-icon">${icon(k)}</span><span><strong>${label}</strong><small>${sub}</small></span>${icon('plus')}</button>`).join('')}</div><section class="rm-library" aria-label="${h(title)}"><div class="rm-section-heading"><div><span class="rm-eyebrow">${ctx.trash?'RECENTLY REMOVED':folder?'INSIDE THIS FOLDER':'SHARED RESOURCES'}</span><h2 tabindex="-1" data-rm-heading>${h(title)}<span class="rm-count">${rows.length}</span></h2></div><div class="rm-library-actions"><button class="rm-button rm-subtle" data-rm-refresh title="Refresh room">${icon('refresh')}<span>Refresh</span></button><button class="rm-button ${ctx.trash?'rm-selected':'rm-subtle'}" data-rm-trash aria-pressed="${!!ctx.trash}">${icon(ctx.trash?'folder':'trash')}<span>${ctx.trash?'Back to items':'Trash'}</span></button></div></div><div class="rm-grid rm-item-grid">${rows.map(x=>`<article class="rm-item" data-rm-item="${h(x.id)}" tabindex="0" role="button" aria-label="${h((ctx.trash?'Actions for ':x.kind==='folder'?'Open folder ':'Open ')+x.title)}"><button class="rm-more" data-rm-more="${h(x.id)}" aria-label="Actions for ${h(x.title)}">⋮</button>${iconMarkup(x)}<div class="item-title">${h(x.title)}</div><small class="rm-note">${h(x.kind==='quiz'?`${x.quiz_settings?.question_count||0} questions`:x.kind==='folder'?`${state.items.filter(c=>!c.is_trashed&&c.parent_id===x.id).length} items`:x.kind==='pdf'?fmtBytes(x.file_size):'Quiz link')}</small><span class="rm-item-open">${ctx.trash?'View actions':x.kind==='folder'?'Open folder':x.kind==='quiz'?'Open quiz':'Open resource'} ${icon('arrow')}</span></article>`).join('')||emptyState(ctx.trash?'Trash is empty':folder?'Room to grow':'Make this space yours',ctx.trash?'Items you remove appear here so they can be restored.':locked?'Your group’s resources will appear here.':'Add a PDF, a link, a folder or a quiz using the tools above.')}</div></section><p class="rm-footer-note">${icon('group')}Shared with your room. Your personal library stays separate.</p></div>`;
 wireTop();screen.scrollTop=pos;
 screen.querySelector('[data-rm-manage]')?.addEventListener('click',manage);
 screen.querySelector('[data-rm-leave]')?.addEventListener('click',async()=>{if(confirm('Leave this room? Your personal library is kept.'))try{await call('leave',ctx.room.id);returnToList()}catch(e){alert(showError(e))}});
 screen.querySelector('[data-rm-refresh]').onclick=refresh;screen.querySelector('[data-rm-trash]').onclick=toggleTrash;
 screen.querySelectorAll('[data-rm-path]').forEach(b=>b.onclick=()=>goFolder(b.dataset.rmPath));
 screen.querySelectorAll('[data-rm-tool]').forEach(b=>b.onclick=()=>{if(b.disabled)return;const k=b.dataset.rmTool;if(k==='pdf')openUpload();if(k==='link')openEditor('link');if(k==='folder')openFolderEditor();if(k==='quiz')window.__quizTest.openQuizCreateModal()});
 screen.querySelectorAll('[data-rm-item]').forEach(b=>{const run=e=>{if(e.target.closest('[data-rm-more]'))return;const x=itemById(b.dataset.rmItem);if(ctx.trash)return itemMenu(x);if(x.kind==='folder')goFolder(x.id,'[data-rm-heading]');else if(x.kind==='quiz')window.__quizTest.openQuizLanding(x);else openItem(x)};b.onclick=run;b.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===b){e.preventDefault();run(e)}}});
 screen.querySelectorAll('[data-rm-more]').forEach(b=>b.onclick=e=>{e.stopPropagation();itemMenu(itemById(b.dataset.rmMore))});
}
async function refresh(){if(!ctx||polling)return;polling=true;const rid=ctx.room.id;try{const data=await call('open',rid,{since:ctx.version});if(ctx?.room.id!==rid||data.unchanged)return;const trash=ctx.trash,folder=ctx.folder;ctx={...data,trash,folder};state.items=data.items||[];state.items.forEach(remember);drawRoom()}catch(e){toast(showError(e))}finally{polling=false}}
function itemMenu(x){
 const allowed=canEdit(x),trash=!!x.is_trashed,trashAllowed=permitted('trash');
 roomModal(x.title,`<div class="rm-item-menu">${allowed?trash?`<button class="btn" data-room-action="restore" ${trashAllowed?'':'disabled'}>${icon('refresh')}<span>Restore</span></button><button class="btn danger-text" data-room-action="delete" ${trashAllowed?'':'disabled'}>${icon('trash')}<span>Delete permanently</span></button>`:`<button class="btn" data-room-action="edit">${icon('edit')}<span>Edit</span></button><button class="btn" data-room-action="move">${icon('move')}<span>Move</span></button><button class="btn" data-room-action="duplicate">${icon('copy')}<span>Duplicate</span></button><button class="btn danger-text" data-room-action="trash" ${trashAllowed?'':'disabled'}>${icon('trash')}<span>Trash</span></button>`:''}<button class="btn" data-room-action="copy" ${ctx.config.permissions?.save_copy===false||ctx.room.permissions?.save_copy===false?'disabled':''}>${icon('folder')}<span>Save to My Library</span></button><button class="btn" data-room-action="close">${icon('back')}<span>Close</span></button></div>`);
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
 roomModal('Room settings',`<button class="rm-dialog-back" id="rmManageClose">${icon('back')}Back to room</button><section class="rm-settings-card"><h3>Your room</h3><label class="rm-field">Room name<input id="rmEditName" value="${h(room.name)}" maxlength="100"></label><div class="rm-invite"><div><strong>Invite your study group</strong><p>Share this code with people you want to join.</p></div><strong class="rm-code">${h(room.invite_code)}</strong></div><div class="form-actions"><button class="btn" id="rmCopyCode">${icon('copy')}Copy code</button><button class="btn" id="rmResetCode">New code</button></div></section><section class="rm-settings-card"><h3>Room controls</h3><label class="rm-toggle"><input type="checkbox" id="rmLocked" ${room.locked?'checked':''}><span><strong>Lock member editing</strong><small>Members can still open resources and take quizzes.</small></span></label><label class="rm-toggle"><input type="checkbox" id="rmJoin" ${room.permissions.join===false?'':'checked'}><span><strong>Allow joining with the code</strong><small>Turn off to stop new members from joining.</small></span></label><label class="rm-toggle"><input type="checkbox" id="rmSaveCopy" ${room.permissions.save_copy===false?'':'checked'}><span><strong>Allow personal library copies</strong><small>Members can save an independent copy to My Library.</small></span></label><div class="form-actions"><button class="btn primary" id="rmSaveSettings">Save settings</button></div></section><section class="rm-settings-card"><div class="rm-settings-heading"><h3>Members <span>${members.length}</span></h3><button class="btn" id="rmActivity">${icon('history')}Activity</button></div>${members.map(m=>`<div class="rm-member"><span class="rm-member-avatar">${h((m.name||'S').slice(0,1).toUpperCase())}</span><div class="rm-member-name"><strong>${h(m.name)}</strong><small>${m.user_id===room.owner_id?'Room owner':m.status==='blocked'?'Access removed':m.can_edit?'Can create and edit':'Read only'}</small></div>${m.user_id===room.owner_id?'':`<div class="rm-member-actions"><button class="btn" data-rm-member="${h(m.user_id)}" data-action="edit">${m.can_edit?'Read only':'Allow editing'}</button><button class="btn" data-rm-member="${h(m.user_id)}" data-action="block">${m.status==='blocked'?'Restore access':'Remove access'}</button></div>`}</div>`).join('')}</section><div class="rm-room-close"><p>${room.status==='closed'?'Reopen this space when your group is ready.':'Closing a room pauses access for its members.'}</p><button class="btn" id="rmRoomStatus">${room.status==='closed'?'Reopen room':'Close room'}</button></div>`);
 const act=async(data)=>{try{await call('settings',room.id,data);closeModal();await refresh()}catch(e){alert(showError(e))}};
 document.getElementById('rmManageClose').onclick=closeModal;document.getElementById('rmCopyCode').onclick=async()=>{try{await navigator.clipboard.writeText(room.invite_code);toast('Room code copied')}catch{prompt('Copy this room code',room.invite_code)}};
 document.getElementById('rmResetCode').onclick=()=>confirm('Replace the invitation code? The old code will stop working.')&&act({reset_code:true});
 document.getElementById('rmSaveSettings').onclick=()=>act({name:document.getElementById('rmEditName').value,locked:document.getElementById('rmLocked').checked,permissions:{...room.permissions,join:document.getElementById('rmJoin').checked,save_copy:document.getElementById('rmSaveCopy').checked}});
 document.getElementById('rmRoomStatus').onclick=()=>confirm(room.status==='closed'?'Reopen this room?':'Close this room for members?')&&act({status:room.status==='closed'?'active':'closed'});
 document.querySelectorAll('[data-rm-member]').forEach(b=>b.onclick=async()=>{const m=members.find(x=>x.user_id===b.dataset.rmMember);try{await call('member',room.id,{user_id:m.user_id,...(b.dataset.action==='edit'?{can_edit:!m.can_edit}:{status:m.status==='blocked'?'active':'blocked'})});closeModal();await manage()}catch(e){alert(showError(e))}});
 document.getElementById('rmActivity').onclick=async()=>{try{const rows=await call('activity',room.id);roomModal('Room activity',`<button class="rm-dialog-back" id="rmActivityBack">${icon('back')}Back to Room settings</button>`+(rows.map(e=>`<p><b>${h(e.actor_name)}</b> · ${h(e.action.replaceAll('_',' '))}<br>${h(e.title)}<br><small>${h(new Date(e.created_at).toLocaleString())}</small></p>`).join('')||'<p>No activity yet.</p>'));document.getElementById('rmActivityBack').onclick=manage}catch(e){alert(showError(e))}};
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
