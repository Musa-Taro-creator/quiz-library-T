/* Rooms are loaded only when opened. Existing library services remain the
   fallback; room item identifiers always route to the room RPC. */
const old={},locations=new Map(),quizCache=new Map(),attempts=new Map();
let ctx=null,backup=null,screen=null,busy=false,polling=false,copying=false,listScroll=0,listFocus=null,listRequest=0,entryRequest=0;
const views=new Map();
const who=()=>String(state.user?.id||'');
const feat=k=>window.qlFeatureMode?.(k)||'on';
const h=v=>esc(String(v??''));
const paths={group:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87',back:'m15 18-6-6 6-6',arrow:'M5 12h14m-6-6 6 6-6 6',plus:'M12 5v14M5 12h14',close:'m6 6 12 12M6 18 18 6',pdf:'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-3 3M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l3-3',folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 3v7m-3-3h6',quiz:'M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 2h6v4H9V2Zm0 12 2 2 4-5',refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',lock:'M6 11V7a6 6 0 0 1 12 0v4M4 11h16v11H4V11Zm8 4v3',edit:'m4 16 12-12 4 4L8 20H4v-4Z',move:'M12 3v18M3 12h18m-6-6-3-3-3 3m6 12-3 3-3-3M6 9l-3 3 3 3m12-6 3 3-3 3',copy:'M9 9h12v12H9V9ZM15 6V3H3v12h3',history:'M3 3v6h6M3 9a9 9 0 1 1 0 6m9-9v6l4 2',search:'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10 17-4.3-4.3',sort:'M3 6h13M3 12h9M3 18h5M17 8v12m0 0-3-3m3 3 3-3',grid:'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',pin:'M12 17v5M9 3h6l-1 6 4 4H6l4-4-1-6Z'};
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
function roomEditable(){return !!(ctx?.can_edit&&ctx.config.permissions?.edit!==false&&ctx.room.permissions?.edit!==false)}
export function canEdit(item){return !item?._room_id||!!(ctx?.room.id===item._room_id&&roomEditable()&&item._can_edit!==false&&feat('room_edit')==='on')}
/* "Only Sokha" / "Sokha + 2" for items whose creator chose who can change them */
function lockText(x){if(!x?._edit_mode||x._edit_mode==='everyone')return '';const name=x._creator_id===who()?'you':(x._creator_name||'the creator');return x._edit_mode==='chosen'&&x._editor_count?`Only ${name} + ${x._editor_count}`:`Only ${name}`}
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
 if(window.qlCanOpenRooms?.()===false)return;
 if(!who())return toast('Sign in to use Rooms.');if(screen?.isConnected)return;
 screen=document.createElement('section');screen.id='qlRooms';document.body.append(screen);window.qlUiBack?.open('rooms',()=>!!screen?.isConnected,back);await showList();
}
async function showList(){
 if(!screen?.isConnected)return;const target=screen,request=++listRequest;
 screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Learn better, together')}<div class="rm-loading" role="status"><span></span>Loading your spaces…</div></div>`;wireTop();
 try{const data=await call('list');if(screen!==target||request!==listRequest||ctx)return;
  const rooms=data.rooms||[],owned=rooms.filter(r=>r.owner_id===who()).length;
  screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Learn better, together')}<section class="rm-welcome"><div><span class="rm-eyebrow">A PLACE FOR YOUR STUDY GROUP</span><h2>Your people.<br>Your shared library.</h2><p>Keep notes, links and quizzes together in one space.</p><div class="rm-actions"><button class="rm-button rm-primary" data-rm-create ${data.config?.enabled===false?'disabled':''}>${icon('plus')}Create Room</button><button class="rm-button" data-rm-join>${icon('group')}Join with a code</button></div></div><div class="rm-welcome-art" aria-hidden="true"><div class="rm-art-card rm-art-back">${icon('folder')}</div><div class="rm-art-card rm-art-front">${icon('group')}<span>BETTER TOGETHER</span><i></i><i></i></div><span class="rm-art-star">✦</span></div></section><div class="rm-overview"><span><b>${rooms.length}</b> ${rooms.length===1?'room':'rooms'}</span><span><b>${owned}</b> created by you</span><span><b>${rooms.length-owned}</b> joined</span></div><div class="rm-section-heading"><div><h2>Your spaces</h2><p>Choose a room to continue studying.</p></div></div><div class="rm-grid rm-room-grid">${rooms.map((r,n)=>`<button class="rm-room" data-rm-open="${h(r.id)}" style="--rm-hue:${[258,190,328,32][n%4]};${coverStyle(r)}"><div class="rm-room-cover rm-cover"><span class="rm-room-symbol ${r.emoji?'rm-emoji':''}">${r.emoji?h(r.emoji):icon('group')}</span>${badge(r.status==='active'?(r.owner_id===who()?'Your room':'Member'):r.status,r.status==='active'?'':'rm-badge-warning')}<span class="rm-room-arrow">${icon('arrow')}</span></div><div class="rm-room-body"><h3>${h(r.name)}</h3><p class="rm-room-description">${h(r.description||'A shared space to learn and create together.')}</p><div class="rm-room-people"><span class="rm-avatar">${h((r.owner_name||'S').slice(0,1).toUpperCase())}</span><span>${h(r.owner_name||'Student')}<small>${r.members} ${r.members===1?'member':'members'}${r.locked?' · editing locked':''}</small></span></div><div class="rm-room-enter">Open room ${icon('arrow')}</div></div></button>`).join('')||emptyState('Your first shared space starts here','Create a room for your group, or join one with an invitation code.')}</div></div>`;
  wireTop();screen.scrollTop=listScroll;if(listFocus)focusOn(`[data-rm-open="${CSS.escape(listFocus)}"]`);
  screen.querySelector('[data-rm-create]').onclick=()=>roomForm();screen.querySelector('[data-rm-join]').onclick=()=>joinForm();screen.querySelectorAll('[data-rm-open]').forEach(b=>b.onclick=()=>enter(b.dataset.rmOpen));
 }catch(e){if(screen===target&&request===listRequest){screen.querySelector('.rm-loading').innerHTML=`${emptyState('Rooms couldn’t open',showError(e))}<button class="rm-button" data-rm-retry>Try again</button>`;screen.querySelector('[data-rm-retry]').onclick=showList}}
}
function roomModal(title,body){openModal(title,`<div class="room-dialog">${body}</div>`)}
/* Keep this module compatible with app pages already open before an update. */
function roomLoading(title,message){
 roomModal(title,`<div class="status" role="status" aria-live="polite" data-ql-opening>${h(message)}</div><div class="form-actions"><button class="btn" data-ql-opening-cancel>Cancel</button></div>`);
 const marker=document.querySelector('[data-ql-opening]'),user=who();document.querySelector('[data-ql-opening-cancel]').onclick=closeModal;
 const current=()=>marker.isConnected&&document.getElementById('modalOverlay').classList.contains('show')&&who()===user;
 return {current,close:()=>{if(current())closeModal()}};
}
function roomForm(){roomModal('Create Room','<div class="rm-dialog-intro"><span>'+icon('group')+'</span><p>Bring your study group together. You’ll manage this room and its members.</p></div><div class="form-grid rm-form"><label class="rm-field">Room name<input id="rmName" maxlength="100" placeholder="e.g. MD-Y3-S2"></label><label class="rm-field">Description<textarea id="rmDesc" maxlength="1000" placeholder="What will your group study?"></textarea></label></div><div class="status">Members have full editing access by default. You can restrict it in Room settings.</div><div class="form-actions"><button class="btn" id="rmCancel">Back to Rooms</button><button class="btn primary" id="rmSubmit">Create Room</button></div>');document.getElementById('rmCancel').onclick=closeModal;document.getElementById('rmSubmit').onclick=async e=>{e.target.disabled=true;try{const r=await call('create',null,{name:document.getElementById('rmName').value,description:document.getElementById('rmDesc').value});closeModal();await enter(r.id)}catch(e){alert(showError(e));document.getElementById('rmSubmit').disabled=false}}}
function joinForm(){roomModal('Join Room','<div class="rm-dialog-intro"><span>'+icon('link')+'</span><p>Enter the invitation code from your room owner.</p></div><div class="form-grid rm-form"><label class="rm-field">Room code<input id="rmCode" maxlength="20" autocomplete="off" placeholder="Enter the owner’s room code" spellcheck="false" autocapitalize="characters"></label></div><div class="form-actions"><button class="btn" id="rmCancel">Back to Rooms</button><button class="btn primary" id="rmSubmit">Join Room</button></div>');document.getElementById('rmCancel').onclick=closeModal;document.getElementById('rmSubmit').onclick=async e=>{e.target.disabled=true;try{const r=await call('join',null,{code:document.getElementById('rmCode').value});closeModal();await enter(r.id)}catch(e){alert(showError(e));document.getElementById('rmSubmit').disabled=false}}}
async function enter(id){
 const target=screen,request=++entryRequest;if(!ctx){listScroll=screen?.scrollTop||0;listFocus=id}
 const card=screen?.querySelector(`[data-rm-open="${CSS.escape(id)}"]`),label=card?.querySelector('.rm-room-enter'),original=label?.innerHTML;card?.setAttribute('aria-busy','true');if(label)label.textContent='Opening room…';
 try{const data=await call('open',id);if(screen!==target||!screen?.isConnected||request!==entryRequest)return;
  if(!backup)backup={user:who(),items:state.items,section:state.section,folder:state.folderId,selected:state.selected};
  ctx={...data,folder:null};state.items=data.items||[];state.items.forEach(remember);state.section='documents';state.folderId=null;state.selected=new Set();screen.scrollTop=0;
  ui.q='';ui.filter='all';ui.add=false;if(lookRoom!==id){look=null;lookRoom=null}drawRoom();loadLook(id).then(()=>{if(ctx?.room.id===id&&screen?.isConnected)drawRoom()});
 }catch(e){if(screen===target&&request===entryRequest)alert(showError(e))}finally{card?.removeAttribute('aria-busy');if(label?.isConnected)label.innerHTML=original}
}
function permitted(k){return ctx?.can_edit&&ctx.config?.permissions?.[k]!==false&&ctx.room.permissions?.[k]!==false}
/* ---- Rooms look (Part 2): cover theme, live header, "since your last visit", toolbar, filters,
   pins and colourful cards. Extra data comes from ql_room_look_v1 (supabase/rooms_look_v1.sql);
   without it the page still works and simply leaves those parts out. ---- */
const THEMES={violet:['#7c5cf0','#5d66e9','#22b8c9'],ocean:['#0ea5e9','#2563eb','#14b8a6'],sunset:['#f97316','#ec4899','#f59e0b'],forest:['#16a34a','#0d9488','#65a30d'],rose:['#f43f5e','#a855f7','#ec4899'],midnight:['#1e293b','#4338ca','#0f766e']};
const EMOJIS=['🫀','🧠','🦴','🫁','🩺','💊','🧬','🔬','📚','📝','🎓','⭐','🔥','🚀','💡','🌱','🏥','⚕️','🧪','🎯'];
const themeOf=r=>THEMES[r?.theme]?r.theme:'violet';
const coverStyle=r=>{const [a,b,c]=THEMES[themeOf(r)];return `--rm-c1:${a};--rm-c2:${b};--rm-c3:${c}`};
const KIND_LABEL={folder:'FOLDER',quiz:'QUIZ',pdf:'PDF',link:'LINK'};
const BIG={
 folder:'<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="rmGf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd76a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><path d="M5 12a4 4 0 0 1 4-4h9l4 4h17a4 4 0 0 1 4 4v3H5z" fill="#d97706"/><rect x="9" y="14" width="30" height="10" rx="2" fill="#fff" opacity=".9"/><path d="M5 18h38v18a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="url(#rmGf)"/><path d="M5 22h38" stroke="#fff" stroke-opacity=".45" stroke-width="1.5"/></svg>',
 quiz:'<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="rmGq" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><rect x="8" y="6" width="32" height="38" rx="6" fill="url(#rmGq)"/><rect x="16" y="3" width="16" height="8" rx="3" fill="#4c1d95"/><rect x="13" y="15" width="22" height="25" rx="3" fill="#fff"/><path d="m17 22 2.5 2.5L24 20M17 32l2.5 2.5L24 30" stroke="#7c3aed" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 22h6M26 32h6" stroke="#c4b5fd" stroke-width="2.4" stroke-linecap="round"/></svg>',
 pdf:'<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M11 4h18l10 10v28a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" fill="#fff" stroke="#fda4af" stroke-width="1.5"/><path d="M29 4v8a2 2 0 0 0 2 2h8" fill="#fecdd3"/><path d="M14 20h14M14 25h18" stroke="#fecdd3" stroke-width="2" stroke-linecap="round"/><rect x="5" y="29" width="30" height="12" rx="4" fill="#e11d48"/><text x="20" y="38.3" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="8.5" font-weight="800" fill="#fff">PDF</text></svg>',
 link:'<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="rmGl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#047857"/></linearGradient></defs><circle cx="24" cy="24" r="19" fill="url(#rmGl)"/><path d="M5 24h38M24 5c6 6 6 32 0 38M24 5c-6 6-6 32 0 38" stroke="#fff" stroke-opacity=".35" stroke-width="1.5" fill="none"/><rect x="21" y="25" width="22" height="16" rx="5" fill="#fff"/><path d="M28 33h8m-3-3 3 3-3 3" stroke="#059669" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
let look=null,lookRoom=null;
const ui={q:'',sort:'newest',filter:'all',view:(()=>{try{return localStorage.getItem('ql_rm_view')==='list'?'list':'grid'}catch{return 'grid'}})(),add:false};
const meta=x=>(lookRoom===ctx?.room.id&&look?.items?.[x.id])||{};
const initial=n=>h(String(n||'S').trim().slice(0,1).toUpperCase()||'S');
const AV_COLORS=['#8b5cf6','#14b8a6','#f59e0b','#ec4899','#3b82f6','#ef4444','#10b981','#6366f1'];
const avColor=n=>AV_COLORS[[...String(n||'')].reduce((s,c)=>s+c.charCodeAt(0),0)%AV_COLORS.length];
function ago(d){if(!d)return '';const t=new Date(d).getTime();if(!t)return '';const m=Math.round((Date.now()-t)/60000);if(m<1)return 'just now';if(m<60)return m+(m===1?' minute ago':' minutes ago');const hr=Math.round(m/60);if(hr<24)return hr+(hr===1?' hour ago':' hours ago');const dy=Math.round(hr/24);if(dy===1)return 'yesterday';if(dy<30)return dy+' days ago';try{return new Date(d).toLocaleDateString([], {day:'numeric',month:'short',year:'numeric'})}catch{return ''}}
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
const hostOf=u=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch{return ''}};
async function loadLook(rid){try{const d=await service.client.rpc('ql_room_look_v1',{p_action:'summary',p_room:rid,p_data:{}});if(d.error)throw d.error;if(ctx?.room.id!==rid)return;look=d.data;lookRoom=rid}catch{if(ctx?.room.id===rid){look=null;lookRoom=null}}}
function lookCall(action,data){const rid=ctx?.room.id;return service.client.rpc('ql_room_look_v1',{p_action:action,p_room:rid,p_data:data||{}}).then(r=>{if(r.error)throw r.error;return r.data})}
function markOpened(x){if(!x?._room_id||!look||lookRoom!==ctx?.room.id)return;const m=look.items[x.id];if(m){m.opened_at=new Date().toISOString();m.is_new=false}look.new_items=(look.new_items||[]).filter(n=>n.id!==x.id);lookCall('opened',{id:x.id}).catch(()=>{})}
function openRoomItem(x){if(!x)return;if(x.kind==='folder')return goFolder(x.id,'[data-rm-heading]');markOpened(x);if(x.kind==='quiz')window.__quizTest.openQuizLanding(x);else openItem(x)}
function childCounts(id){const c={folder:0,quiz:0,pdf:0,link:0,all:0};for(const x of state.items)if(!x.is_trashed&&x.parent_id===id){c[x.kind]=(c[x.kind]||0)+1;c.all++}return c}
function cardBits(x){
 const m=meta(x);
 if(x.kind==='folder'){const c=childCounts(x.id);return {sub:plural(c.all,'item','items'),detail:c.all?`<div class="rm-pills">${c.quiz?`<span>${icon('quiz')}${c.quiz}</span>`:''}${c.pdf?`<span>${icon('pdf')}${c.pdf}</span>`:''}${c.link?`<span>${icon('link')}${c.link}</span>`:''}${c.folder?`<span>${icon('folder')}${c.folder}</span>`:''}</div>`:'<span class="rm-detail-muted">Empty folder</span>'}}
 if(x.kind==='quiz'){const n=Number(x.quiz_settings?.question_count)||0,best=m.best==null?null:Math.round(Number(m.best));return {sub:`${plural(n,'question','questions')}${m.takers?` · ${plural(m.takers,'classmate','classmates')} took it`:''}`,detail:best==null?'<span class="rm-detail-muted">Not taken yet</span>':`<div class="rm-prog"><span>Your best</span><i><b style="width:${Math.max(3,Math.min(100,best))}%"></b></i><strong>${best}%</strong></div>`}}
 if(x.kind==='pdf')return {sub:fmtBytes(x.file_size)||'PDF',detail:m.opened_at?`<span class="rm-detail-ok">${icon('refresh')}Opened ${h(ago(m.opened_at))}</span>`:'<span class="rm-detail-muted">Not opened yet</span>'};
 return {sub:'Opens in a new tab',detail:hostOf(x.url)?`<div class="rm-pills"><span>${icon('link')}${h(hostOf(x.url))}</span></div>`:'<span class="rm-detail-muted">Quiz link</span>'};
}
function card(x){
 const m=meta(x),bits=cardBits(x),lock=lockText(x),creator=x._creator_name||'',when=ago(m.created_at||x.created_at||x.updated_at);
 const label=(ctx.trash?'Actions for ':x.kind==='folder'?'Open folder ':'Open ')+x.title;
 const foot=`<div class="rm-foot">${creator?`<span class="rm-av" style="background:${avColor(creator)}">${initial(creator)}</span><span class="rm-by"><b>${h(x._creator_id===who()?'You':creator)}</b>${when?` · ${h(when)}`:''}</span>`:`<span class="rm-by">${h(when)}</span>`}<span class="rm-go" aria-hidden="true">${icon('arrow')}</span></div>`;
 if(ui.view==='list')return `<article class="rm-item rm-row rm-k-${h(x.kind)}" data-rm-item="${h(x.id)}" tabindex="0" role="button" aria-label="${h(label)}"><span class="rm-ico">${BIG[x.kind]||BIG.folder}</span><div class="rm-row-main"><div class="item-title">${h(x.title)}${m.is_new?'<span class="rm-new">NEW</span>':''}</div><small class="rm-note">${h(KIND_LABEL[x.kind]?.toLowerCase().replace(/^./,c=>c.toUpperCase())||'')} · ${h(bits.sub)}</small>${lock?`<span class="rm-lock-badge">${icon('lock')}${h(lock)}</span>`:''}</div>${foot}<button class="rm-more" data-rm-more="${h(x.id)}" aria-label="Actions for ${h(x.title)}">⋮</button></article>`;
 return `<article class="rm-item rm-card rm-k-${h(x.kind)}" data-rm-item="${h(x.id)}" tabindex="0" role="button" aria-label="${h(label)}"><div class="rm-band"><span class="rm-wm" aria-hidden="true">${icon(x.kind==='pdf'?'pdf':x.kind)}</span><span class="rm-tags">${m.is_new?'<span class="rm-new">● NEW</span>':''}<span class="rm-type">${KIND_LABEL[x.kind]||''}</span></span></div><button class="rm-more" data-rm-more="${h(x.id)}" aria-label="Actions for ${h(x.title)}">⋮</button><span class="rm-ico">${BIG[x.kind]||BIG.folder}</span><div class="rm-body"><div class="item-title">${h(x.title)}</div>${lock?`<span class="rm-lock-badge" title="${h(lock)} can change this item">${icon('lock')}${h(lock)}</span>`:''}<small class="rm-note">${h(bits.sub)}</small><div class="rm-detail">${bits.detail}</div></div>${foot}</article>`;
}
function visibleRows(){
 const q=ui.q.trim().toLowerCase();let rows=state.items.filter(x=>ctx.trash?x.is_trashed:!x.is_trashed&&(q?true:x.parent_id===state.folderId));
 if(q)rows=rows.filter(x=>String(x.title||'').toLowerCase().includes(q));
 if(!ctx.trash&&ui.filter!=='all')rows=rows.filter(x=>ui.filter==='new'?meta(x).is_new:x.kind===ui.filter);
 const date=x=>new Date(meta(x).created_at||x.created_at||x.updated_at||0).getTime(),order={folder:0,quiz:1,pdf:2,link:3};
 const cmp={newest:(a,b)=>date(b)-date(a),oldest:(a,b)=>date(a)-date(b),az:(a,b)=>String(a.title).localeCompare(String(b.title)),type:(a,b)=>(order[a.kind]??9)-(order[b.kind]??9)||String(a.title).localeCompare(String(b.title))}[ui.sort]||((a,b)=>0);
 return rows.sort((a,b)=>(a.kind==='folder'?0:1)-(b.kind==='folder'?0:1)||cmp(a,b));
}
function pinnedRows(){if(!look||lookRoom!==ctx.room.id||ctx.trash||ctx.folder||ui.q)return [];return state.items.filter(x=>!x.is_trashed&&meta(x).pinned_at).sort((a,b)=>new Date(meta(a).pinned_at)-new Date(meta(b).pinned_at))}
function pinCard(x){const m=meta(x),best=m.best==null?null:Math.round(Number(m.best));
 const left=x.kind==='quiz'&&best!=null?`<span class="rm-ring" style="--p:${best}"><b>${best}%</b></span>`:`<span class="rm-pin-ico rm-k-${h(x.kind)}">${BIG[x.kind]||BIG.folder}</span>`;
 const sub=x.kind==='quiz'?`${plural(Number(x.quiz_settings?.question_count)||0,'question','questions')}${best!=null?` · your best ${best}%`:''}${m.takers?` · ${plural(m.takers,'classmate','classmates')} took it`:''}`:cardBits(x).sub;
 return `<div class="rm-pin rm-k-${h(x.kind)}">${left}<div class="rm-pin-main"><b>${h(x.title)}</b><small>${h(sub)}</small></div><button class="rm-button ${x.kind==='quiz'?'rm-primary':''}" data-rm-pin-open="${h(x.id)}">${x.kind==='quiz'?(best!=null?'Continue':'Start'):'Open'}</button></div>`}
function drawRoom(){
 if(!ctx||!screen?.isConnected)return;state.folderId=ctx.folder||null;const pos=screen.scrollTop;
 const searchFocus=document.activeElement?.matches?.('[data-rm-search]')?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
 let names=[],f=itemById(state.folderId),guard=0;while(f&&guard++<200){names.unshift(f);f=itemById(f.parent_id)}
 if(history.state?.qlUiLayer==='rooms')history.replaceState({...history.state,...currentRoute()},'',location.href);
 const rows=visibleRows(),room=ctx.room,locked=!ctx.can_edit,folder=names.at(-1),title=ctx.trash?'Trash':ui.q?'Search results':folder?.title||'Room library';
 const L=lookRoom===room.id?look:null,st=L?.stats||{},emoji=L?.emoji??room.emoji??'',theme=L?{theme:L.theme}:room;
 const live=st.online>0?`<span class="rm-hchip rm-live">● ${st.online} studying now</span>`:'';
 const role=ctx.manager?(room.owner_id===who()?'👑 Room owner':'Website admin'):locked?'Read only':'Shared room';
 const tiles=L?[[st.members,'members'],[st.quizzes,'quizzes'],[Number(st.questions||0).toLocaleString(),'questions'],[st.taken_week,'taken this week']]:[[ctx.manager?ctx.members.length:'',ctx.manager?'members':''],[state.items.filter(x=>!x.is_trashed&&x.kind==='folder').length,'folders'],[state.items.filter(x=>!x.is_trashed&&x.kind==='quiz').length,'quizzes']].filter(t=>t[1]);
 const people=L?.people||[],more=Math.max(0,(st.members||0)-people.length);
 const tools=[['quiz','Create Quiz','Build questions together'],['folder','New Folder','Keep things organized'],['link','Add Quiz Link','Keep useful links'],['pdf','Upload PDF','Share your notes']];
 const anyTool=tools.some(([k])=>permitted(k));
 const kinds=['folder','quiz','pdf','link'],count=k=>state.items.filter(x=>!x.is_trashed&&(k==='new'?meta(x).is_new:x.kind===k)&&(ui.q||x.parent_id===state.folderId)).length;
 const chips=[['all','All',state.items.filter(x=>!x.is_trashed&&(ui.q||x.parent_id===state.folderId)).length],['folder','📁 Folders',count('folder')],['quiz','📝 Quizzes',count('quiz')],['pdf','📄 PDFs',count('pdf')],['link','🔗 Links',count('link')]].concat(L?[['new','✨ New for me',count('new')]]:[]);
 const news=!ctx.trash&&!ctx.folder&&!ui.q&&L?.new_items?.length?L.new_items:[];
 const pins=pinnedRows();
 screen.innerHTML=`<div class="rm-wrap">${top('Rooms','Your shared study space')}<nav class="rm-crumbs" aria-label="Room location"><button data-rm-all>Rooms</button><span>›</span><button data-rm-path="" ${!ctx.folder&&!ctx.trash?'aria-current="page"':''}>${h(room.name)}</button>${names.map((x,n)=>`<span>›</span><button data-rm-path="${h(x.id)}" ${n===names.length-1&&!ctx.trash?'aria-current="page"':''}>${h(x.title)}</button>`).join('')}${ctx.trash?'<span>›</span><span aria-current="page">Trash</span>':''}</nav>
 <section class="rm-room-hero rm-cover" style="${coverStyle(theme)}"><span class="rm-cover-glow" aria-hidden="true"></span><span class="rm-hero-symbol ${emoji?'rm-emoji':''}">${emoji?h(emoji):icon('group')}</span><div class="rm-hero-copy"><div class="rm-hero-badges"><span class="rm-hchip">${h(role)}</span>${room.locked?'<span class="rm-hchip">🔒 Editing locked</span>':''}${live}</div><h2>${h(room.name)}</h2><p>${h(room.description||'Notes, links and quizzes for your study group.')}</p><div class="rm-hstats">${tiles.map(([n,l])=>`<div class="rm-hs"><b>${h(n)}</b><span>${h(l)}</span></div>`).join('')}</div></div>
 <div class="rm-hero-controls">${people.length?`<div class="rm-avs" title="${h(people.map(p=>p.name).join(', '))}">${people.map(p=>`<span class="rm-av ${p.online?'rm-on':''}" style="background:${avColor(p.name)}">${initial(p.name)}</span>`).join('')}${more?`<span class="rm-av rm-av-more">+${more}</span>`:''}</div>`:''}${ctx.manager&&room.invite_code?`<div class="rm-code-chip"><span>Invite code</span><b>${h(room.invite_code)}</b><button class="rm-button" data-rm-copy-code>${icon('copy')}Copy</button></div>`:''}<div class="rm-hero-btns">${ctx.manager&&L?`<button class="rm-button rm-glass" data-rm-theme>🎨 Theme</button>`:''}${ctx.manager?`<button class="rm-button rm-glass" data-rm-manage>${icon('settings')}Room settings</button>`:`<button class="rm-button rm-glass" data-rm-leave>Leave Room</button>`}</div></div></section>
 ${locked?`<div class="rm-access-note">${icon('lock')}You can open resources and take quizzes. Editing is managed by the room owner.</div>`:''}
 ${news.length?`<section class="rm-whatsnew"><span class="rm-wn-ic">✨</span><div class="rm-wn-text"><b>${plural(news.length,'new thing','new things')} since your last visit</b><small>${h(ago(L.since)?'Last visit '+ago(L.since):'')}</small></div><div class="rm-wn-list">${news.slice(0,6).map(n=>`<button class="rm-wn-item" data-rm-new="${h(n.id)}"><span class="rm-av" style="background:${avColor(n.creator_name)}">${initial(n.creator_name)}</span>${h(n.title)}</button>`).join('')}</div></section>`:''}
 <div class="rm-toolbar"><div class="rm-add-wrap"><button class="rm-button rm-primary" data-rm-add aria-expanded="${ui.add}" aria-haspopup="true" ${anyTool?'':'disabled'}>${icon('plus')}<span>Add</span></button><div class="rm-add-menu" ${ui.add?'':'hidden'} role="menu">${tools.map(([k,label,sub])=>`<button class="rm-tool rm-tool-${k}" data-rm-tool="${k}" role="menuitem" ${permitted(k)?'':'disabled'}><span class="rm-tool-icon">${icon(k)}</span><span><strong>${label}</strong><small>${sub}</small></span></button>`).join('')}</div></div>
  <label class="rm-search">${icon('search')}<input type="search" data-rm-search placeholder="Search in ${h(room.name)}" value="${h(ui.q)}" aria-label="Search in this room"></label>
  <label class="rm-sort" title="Sort">${icon('sort')}<select data-rm-sort aria-label="Sort">${[['newest','Newest'],['oldest','Oldest'],['az','A–Z'],['type','Type']].map(([v,t])=>`<option value="${v}" ${ui.sort===v?'selected':''}>${t}</option>`).join('')}</select></label>
  <div class="rm-seg" role="group" aria-label="View"><button data-rm-view="grid" aria-pressed="${ui.view==='grid'}" title="Grid">${icon('grid')}</button><button data-rm-view="list" aria-pressed="${ui.view==='list'}" title="List">${icon('list')}</button></div>
  ${ctx.manager?`<button class="rm-button rm-subtle" data-rm-activity title="Room activity">${icon('history')}<span>Activity</span></button>`:''}<button class="rm-button rm-subtle" data-rm-refresh title="Refresh room">${icon('refresh')}<span>Refresh</span></button><button class="rm-button ${ctx.trash?'rm-selected':'rm-subtle'}" data-rm-trash aria-pressed="${!!ctx.trash}">${icon(ctx.trash?'folder':'trash')}<span>${ctx.trash?'Back to items':'Trash'}</span></button></div>
 ${ctx.trash?'':`<div class="rm-chips" role="group" aria-label="Show">${chips.map(([k,l,n])=>`<button data-rm-filter="${k}" aria-pressed="${ui.filter===k}">${l} <em>${n}</em></button>`).join('')}</div>`}
 ${pins.length?`<section class="rm-pins" aria-label="Pinned by the owner"><h3>📌 Pinned by the owner</h3><div class="rm-pin-grid">${pins.map(pinCard).join('')}</div></section>`:''}
 <section class="rm-library" aria-label="${h(title)}"><div class="rm-section-heading"><div><span class="rm-eyebrow">${ctx.trash?'RECENTLY REMOVED':ui.q?'IN THIS ROOM':folder?'INSIDE THIS FOLDER':'SHARED RESOURCES'}</span><h2 tabindex="-1" data-rm-heading>${h(title)}<span class="rm-count">${rows.length}</span></h2></div></div><div class="rm-grid rm-item-grid ${ui.view==='list'?'rm-list-view':''}">${rows.map(card).join('')||emptyState(ctx.trash?'Trash is empty':ui.q||ui.filter!=='all'?'Nothing matches':folder?'Room to grow':'Make this space yours',ctx.trash?'Items you remove appear here so they can be restored.':ui.q||ui.filter!=='all'?'Try another word or show All.':locked?'Your group’s resources will appear here.':'Tap Add to share a quiz, a folder, a link or a PDF.')}</div></section><p class="rm-footer-note">${icon('group')}Shared with your room. Your personal library stays separate.</p></div>`;
 wireTop();screen.scrollTop=pos;
 const $r=s=>screen.querySelector(s),$$r=s=>screen.querySelectorAll(s);
 $r('[data-rm-manage]')?.addEventListener('click',manage);
 $r('[data-rm-leave]')?.addEventListener('click',async()=>{if(confirm('Leave this room? Your personal library is kept.'))try{await call('leave',ctx.room.id);returnToList()}catch(e){alert(showError(e))}});
 $r('[data-rm-theme]')?.addEventListener('click',themeForm);
 $r('[data-rm-activity]')?.addEventListener('click',()=>showActivity(false));
 $r('[data-rm-copy-code]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(room.invite_code);toast('Room code copied')}catch{prompt('Copy this room code',room.invite_code)}});
 $r('[data-rm-refresh]').onclick=refresh;$r('[data-rm-trash]').onclick=toggleTrash;
 $$r('[data-rm-path]').forEach(b=>b.onclick=()=>{ui.q='';goFolder(b.dataset.rmPath)});
 const addBtn=$r('[data-rm-add]'),menu=$r('.rm-add-menu');
 addBtn.onclick=e=>{e.stopPropagation();ui.add=!ui.add;menu.hidden=!ui.add;addBtn.setAttribute('aria-expanded',ui.add);if(ui.add)menu.querySelector('[data-rm-tool]:not([disabled])')?.focus()};
 screen.onclick=e=>{if(ui.add&&!e.target.closest('.rm-add-wrap')){ui.add=false;menu.hidden=true;addBtn.setAttribute('aria-expanded','false')}};
 menu.onkeydown=e=>{if(e.key==='Escape'){ui.add=false;menu.hidden=true;addBtn.setAttribute('aria-expanded','false');addBtn.focus()}};
 $$r('[data-rm-tool]').forEach(b=>b.onclick=()=>{if(b.disabled)return;ui.add=false;menu.hidden=true;const k=b.dataset.rmTool;if(k==='pdf')openUpload();if(k==='link')openEditor('link');if(k==='folder')openFolderEditor();if(k==='quiz')window.__quizTest.openQuizCreateModal()});
 const search=$r('[data-rm-search]');search.oninput=()=>{ui.q=search.value;drawRoom()};
 if(searchFocus){search.focus({preventScroll:true});try{search.setSelectionRange(searchFocus[0],searchFocus[1])}catch{}}
 $r('[data-rm-sort]').onchange=e=>{ui.sort=e.target.value;drawRoom()};
 $$r('[data-rm-view]').forEach(b=>b.onclick=()=>{ui.view=b.dataset.rmView;try{localStorage.setItem('ql_rm_view',ui.view)}catch{}drawRoom()});
 $$r('[data-rm-filter]').forEach(b=>b.onclick=()=>{ui.filter=b.dataset.rmFilter;drawRoom()});
 $$r('[data-rm-new]').forEach(b=>b.onclick=()=>openRoomItem(itemById(b.dataset.rmNew)));
 $$r('[data-rm-pin-open]').forEach(b=>b.onclick=()=>openRoomItem(itemById(b.dataset.rmPinOpen)));
 $$r('[data-rm-item]').forEach(b=>{const run=e=>{if(e.target.closest('[data-rm-more]'))return;const x=itemById(b.dataset.rmItem);if(ctx.trash)return itemMenu(x);if(x.kind==='folder'){ui.q='';goFolder(x.id,'[data-rm-heading]')}else openRoomItem(x)};b.onclick=run;b.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===b){e.preventDefault();run(e)}}});
 $$r('[data-rm-more]').forEach(b=>b.onclick=e=>{e.stopPropagation();itemMenu(itemById(b.dataset.rmMore))});
}
/* Owner: cover colour + emoji (ql_room_look_v1 'theme'). */
function themeForm(){
 const room=ctx?.room;if(!room)return;let theme=themeOf(lookRoom===room.id?look:room),emoji=(lookRoom===room.id?look?.emoji:room.emoji)||'';
 const preview=()=>`<div class="rm-cover rm-theme-preview" style="${coverStyle({theme})}"><span class="rm-hero-symbol ${emoji?'rm-emoji':''}">${emoji?h(emoji):icon('group')}</span><b>${h(room.name)}</b></div>`;
 roomModal('Room theme',`<div class="rm-themeform"><div data-rm-tprev>${preview()}</div><h4>Colour</h4><div class="rm-swatches">${Object.keys(THEMES).map(k=>`<button data-rm-swatch="${k}" aria-pressed="${k===theme}" style="${coverStyle({theme:k})}" aria-label="${k}"></button>`).join('')}</div><h4>Emoji</h4><div class="rm-emojis"><button data-rm-emoji="" aria-pressed="${!emoji}" title="No emoji">${icon('group')}</button>${EMOJIS.map(e=>`<button data-rm-emoji="${e}" aria-pressed="${e===emoji}">${e}</button>`).join('')}</div><div class="form-actions"><button class="btn" id="rmThemeCancel">Cancel</button><button class="btn primary" id="rmThemeSave">Save theme</button></div></div>`);
 const box=document.querySelector('.rm-themeform'),upd=()=>{box.querySelector('[data-rm-tprev]').innerHTML=preview();box.querySelectorAll('[data-rm-swatch]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.rmSwatch===theme));box.querySelectorAll('[data-rm-emoji]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.rmEmoji===emoji))};
 box.querySelectorAll('[data-rm-swatch]').forEach(b=>b.onclick=()=>{theme=b.dataset.rmSwatch;upd()});box.querySelectorAll('[data-rm-emoji]').forEach(b=>b.onclick=()=>{emoji=b.dataset.rmEmoji;upd()});
 document.getElementById('rmThemeCancel').onclick=closeModal;
 document.getElementById('rmThemeSave').onclick=async e=>{e.target.disabled=true;try{const r=await lookCall('theme',{theme,emoji});if(look&&lookRoom===room.id){look.theme=r.theme;look.emoji=r.emoji}ctx.room={...ctx.room,theme:r.theme,emoji:r.emoji};closeModal();drawRoom();toast('Room theme saved')}catch(err){e.target.disabled=false;alert(showError(err))}};
}

async function refresh(){if(!ctx||polling)return;polling=true;const rid=ctx.room.id;try{const [data]=await Promise.all([call('open',rid,{since:ctx.version}),loadLook(rid)]);if(ctx?.room.id!==rid)return;if(!data.unchanged){const trash=ctx.trash,folder=ctx.folder;ctx={...data,trash,folder};state.items=data.items||[];state.items.forEach(remember)}if(!document.activeElement?.matches?.('[data-rm-search]')||!data.unchanged)drawRoom()}catch(e){toast(showError(e))}finally{polling=false}}
function itemMenu(x){
 const roomOk=roomEditable(),itemOk=x._can_edit!==false,trash=!!x.is_trashed,trashAllowed=permitted('trash'),who2=lockText(x)||'Only the creator';
 const copyOff=ctx.config.permissions?.save_copy===false||ctx.room.permissions?.save_copy===false||x._can_copy===false;
 const lockedRow=(label,ic)=>`<button class="btn rm-locked-action" disabled>${icon('lock')}<span>${label}</span><small>${h(who2)}</small></button>`;
 const actions=!roomOk?'':!itemOk?(trash?lockedRow('Restore')+lockedRow('Delete permanently'):lockedRow('Edit')+lockedRow('Move')+lockedRow('Trash')):trash?`<button class="btn" data-room-action="restore" ${trashAllowed?'':'disabled'}>${icon('refresh')}<span>Restore</span></button><button class="btn danger-text" data-room-action="delete" ${trashAllowed?'':'disabled'}>${icon('trash')}<span>Delete permanently</span></button>`:`<button class="btn" data-room-action="edit">${icon('edit')}<span>Edit</span></button><button class="btn" data-room-action="move">${icon('move')}<span>Move</span></button><button class="btn" data-room-action="duplicate">${icon('copy')}<span>Duplicate</span></button><button class="btn danger-text" data-room-action="trash" ${trashAllowed?'':'disabled'}>${icon('trash')}<span>Trash</span></button>`;
 const pinBtn=ctx.manager&&look&&lookRoom===ctx.room.id&&!trash?`<button class="btn" data-room-action="pin">${icon('pin')}<span>${meta(x).pinned_at?'Unpin':'Pin to top'}</span></button>`:'';
 roomModal(x.title,`<div class="rm-item-menu">${actions}${pinBtn}${x._can_access?`<button class="btn" data-room-action="access">${icon('lock')}<span>Who can change this?</span></button>`:''}<button class="btn" data-room-action="copy" ${copyOff?'disabled':''} ${x._can_copy===false?'title="The creator turned off copies of this item"':''}>${icon('folder')}<span>Save to My Library</span></button><button class="btn" data-room-action="close">${icon('back')}<span>Close</span></button></div>`);
 document.querySelectorAll('[data-room-action]').forEach(b=>b.onclick=async()=>{const a=b.dataset.roomAction;closeModal();try{if(a==='edit'){if(x.kind==='quiz')window.__quizTest.openQuizWorkspace(x);else if(x.kind==='folder')openFolderEditor(x);else openEditor(x)}if(a==='move')openMove([x.id]);if(a==='duplicate')await duplicateRoom(x);if(a==='trash'){await trashItems([x.id]);drawRoom()}if(a==='restore'){await restoreItems([x.id]);drawRoom()}if(a==='delete'&&confirm('Permanently delete this room item?')){await service.deleteMany([x.id]);await refresh()}if(a==='copy')await copyToLibrary(x);if(a==='access')await accessForm(x);if(a==='pin'){await lookCall('pin',{id:x.id,pinned:!meta(x).pinned_at});await refresh();toast(meta(x).pinned_at?'Pinned to the top':'Unpinned')}}catch(e){alert(showError(e))}});
}
/* "Who can change this?" — the creator (or the room owner / website admin) chooses who can
   edit, move and trash the item, and whether others can save their own copy. */
async function accessForm(x){
 const rid=ctx?.room.id;if(!rid)return;const loading=roomLoading('Who can change this?','Loading…');let d;
 try{d=await itemCall(x.id,'item_access_get')}catch(e){if(loading.current()){loading.close();alert(showError(e))}return}
 if(!loading.current()||ctx?.room.id!==rid)return;loading.close();
 const mine=d.creator_id===who(),creator=mine?'me':(d.creator_name||'the creator'),chosen=new Set(d.editors||[]);
 const opt=(v,title,sub,extra='')=>`<div class="rm-acc-opt ${d.mode===v?'on':''}"><label><input type="radio" name="rmAccMode" value="${v}" ${d.mode===v?'checked':''}><span><strong>${title}</strong><small>${sub}</small></span></label>${extra}</div>`;
 const people=(d.members||[]).map(m=>`<label class="rm-acc-person"><input type="checkbox" value="${h(m.user_id)}" ${chosen.has(m.user_id)?'checked':''}><span class="rm-member-avatar">${h((m.name||'S').slice(0,1).toUpperCase())}</span>${h(m.name)}</label>`).join('')||'<small class="rm-acc-none">No other members yet.</small>';
 roomModal('Who can change this?',`<div class="rm-acc"><p class="rm-acc-item">${h(x.title)} · made by ${h(mine?'you':creator)}</p><h4>Edit, move and trash</h4>
  ${opt('everyone','Everyone in the room','Your group can improve it together')}
  ${opt('creator',mine?'Only me':'Only '+h(creator),'Others can open it'+(x.kind==='quiz'?' and take the quiz':'')+', but not change it')}
  ${opt('chosen',mine?'Me and people I choose':h(creator)+' and chosen people','Pick helpers from the room',`<div class="rm-acc-people" ${d.mode==='chosen'?'':'hidden'}>${people}</div>`)}
  <h4>Others can also</h4><label class="rm-toggle"><input type="checkbox" id="rmAccCopy" ${d.allow_copy!==false?'checked':''}><span><strong>Save a copy to their library</strong><small>They get their own separate copy</small></span></label>
  <div class="rm-acc-note">${icon('lock')}The room owner (${h(d.owner_name||'owner')}) can always change or remove items in this room.</div>
  <div class="form-actions"><button class="btn" id="rmAccCancel">Cancel</button><button class="btn primary" id="rmAccSave">Save</button></div></div>`);
 const box=document.querySelector('.rm-acc');
 box.querySelectorAll('[name="rmAccMode"]').forEach(r=>r.onchange=()=>{box.querySelectorAll('.rm-acc-opt').forEach(o=>o.classList.toggle('on',o.querySelector('[name="rmAccMode"]').checked));box.querySelector('.rm-acc-people').hidden=r.value!=='chosen'});
 document.getElementById('rmAccCancel').onclick=closeModal;
 document.getElementById('rmAccSave').onclick=async e=>{const mode=box.querySelector('[name="rmAccMode"]:checked')?.value||'everyone',editors=[...box.querySelectorAll('.rm-acc-people input:checked')].map(i=>i.value);
  if(mode==='chosen'&&!editors.length&&!confirm('No one is chosen yet. Only '+(mine?'you':creator)+' and the room owner will be able to change it. Save?'))return;
  e.target.disabled=true;try{await itemCall(x.id,'item_access',{mode,editors,allow_copy:document.getElementById('rmAccCopy').checked});closeModal();await refresh();toast('Saved who can change this')}catch(err){e.target.disabled=false;alert(showError(err))}};
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
 const rid=ctx?.room.id;if(!rid)return;const loading=roomLoading('Room settings','Loading room settings…');await refresh();if(!loading.current()||ctx?.room.id!==rid)return;loading.close();const room=ctx.room,members=ctx.members||[];
 roomModal('Room settings',`<button class="rm-dialog-back" id="rmManageClose">${icon('back')}Back to room</button><section class="rm-settings-card"><h3>Your room</h3><label class="rm-field">Room name<input id="rmEditName" value="${h(room.name)}" maxlength="100"></label><div class="rm-invite"><div><strong>Invite your study group</strong><p>Share this code with people you want to join.</p></div><strong class="rm-code">${h(room.invite_code)}</strong></div><div class="form-actions"><button class="btn" id="rmCopyCode">${icon('copy')}Copy code</button><button class="btn" id="rmResetCode">New code</button></div></section><section class="rm-settings-card"><h3>Room controls</h3><label class="rm-toggle"><input type="checkbox" id="rmLocked" ${room.locked?'checked':''}><span><strong>Lock member editing</strong><small>Members can still open resources and take quizzes.</small></span></label><label class="rm-toggle"><input type="checkbox" id="rmJoin" ${room.permissions.join===false?'':'checked'}><span><strong>Allow joining with the code</strong><small>Turn off to stop new members from joining.</small></span></label><label class="rm-toggle"><input type="checkbox" id="rmSaveCopy" ${room.permissions.save_copy===false?'':'checked'}><span><strong>Allow personal library copies</strong><small>Members can save an independent copy to My Library. Creators can still turn it off for one item.</small></span></label><h4 class="rm-settings-sub">Items in this room</h4><p class="rm-settings-hint">New items start as</p><div class="rm-acc-opt ${room.permissions.item_default==='creator'?'':'on'}"><label><input type="radio" name="rmItemDefault" value="everyone" ${room.permissions.item_default==='creator'?'':'checked'}><span><strong>Everyone can edit</strong><small>Good for study groups working together</small></span></label></div><div class="rm-acc-opt ${room.permissions.item_default==='creator'?'on':''}"><label><input type="radio" name="rmItemDefault" value="creator" ${room.permissions.item_default==='creator'?'checked':''}><span><strong>Only the creator can edit</strong><small>Good for classes and shared exams</small></span></label></div><label class="rm-toggle"><input type="checkbox" id="rmCreatorChoice" ${room.permissions.creator_choice===false?'':'checked'}><span><strong>Let creators choose for their items</strong><small>Shows "Who can change this?" in the ⋮ menu of their own items. You can always change any item.</small></span></label><div class="form-actions"><button class="btn primary" id="rmSaveSettings">Save settings</button></div></section><section class="rm-settings-card"><div class="rm-settings-heading"><h3>Members <span>${members.length}</span></h3><button class="btn" id="rmActivity">${icon('history')}Activity</button></div>${members.map(m=>`<div class="rm-member"><span class="rm-member-avatar">${h((m.name||'S').slice(0,1).toUpperCase())}</span><div class="rm-member-name"><strong>${h(m.name)}</strong><small>${m.user_id===room.owner_id?'Room owner':m.status==='blocked'?'Access removed':m.can_edit?'Can create and edit':'Read only'}</small></div>${m.user_id===room.owner_id?'':`<div class="rm-member-actions"><button class="btn" data-rm-member="${h(m.user_id)}" data-action="edit">${m.can_edit?'Read only':'Allow editing'}</button><button class="btn" data-rm-member="${h(m.user_id)}" data-action="block">${m.status==='blocked'?'Restore access':'Remove access'}</button></div>`}</div>`).join('')}</section><div class="rm-room-close"><p>${room.status==='closed'?'Reopen this space when your group is ready.':'Closing a room pauses access for its members.'}</p><button class="btn" id="rmRoomStatus">${room.status==='closed'?'Reopen room':'Close room'}</button></div>`);
 const act=async(data)=>{try{await call('settings',room.id,data);closeModal();await refresh()}catch(e){alert(showError(e))}};
 document.querySelectorAll('[name="rmItemDefault"]').forEach(r=>r.onchange=()=>document.querySelectorAll('[name="rmItemDefault"]').forEach(o=>o.closest('.rm-acc-opt').classList.toggle('on',o.checked)));
 document.getElementById('rmManageClose').onclick=closeModal;document.getElementById('rmCopyCode').onclick=async()=>{try{await navigator.clipboard.writeText(room.invite_code);toast('Room code copied')}catch{prompt('Copy this room code',room.invite_code)}};
 document.getElementById('rmResetCode').onclick=()=>confirm('Replace the invitation code? The old code will stop working.')&&act({reset_code:true});
 document.getElementById('rmSaveSettings').onclick=()=>act({name:document.getElementById('rmEditName').value,locked:document.getElementById('rmLocked').checked,permissions:{...room.permissions,join:document.getElementById('rmJoin').checked,save_copy:document.getElementById('rmSaveCopy').checked,item_default:document.querySelector('[name="rmItemDefault"]:checked')?.value==='creator'?'creator':'everyone',creator_choice:document.getElementById('rmCreatorChoice').checked}});
 document.getElementById('rmRoomStatus').onclick=()=>confirm(room.status==='closed'?'Reopen this room?':'Close this room for members?')&&act({status:room.status==='closed'?'active':'closed'});
 document.querySelectorAll('[data-rm-member]').forEach(b=>b.onclick=async()=>{const m=members.find(x=>x.user_id===b.dataset.rmMember);try{await call('member',room.id,{user_id:m.user_id,...(b.dataset.action==='edit'?{can_edit:!m.can_edit}:{status:m.status==='blocked'?'active':'blocked'})});closeModal();await manage()}catch(e){alert(showError(e))}});
 document.getElementById('rmActivity').onclick=()=>showActivity(true);
}
async function showActivity(fromSettings){
 const room=ctx?.room;if(!room)return;{const loading=roomLoading('Room activity','Loading room activity…');try{const rows=await call('activity',room.id);if(!loading.current()||ctx?.room.id!==room.id)return;loading.close();roomModal('Room activity',`<button class="rm-dialog-back" id="rmActivityBack">${icon('back')}${fromSettings?'Back to Room settings':'Back to room'}</button>`+(rows.map(e=>`<p><b>${h(e.actor_name)}</b> · ${h(({item_trashed:'moved to Trash',item_restored:'restored',item_moved:'moved',item_access_changed:'changed who can edit',item_pinned:'pinned',item_unpinned:'unpinned',room_theme_changed:'changed the room theme'})[e.action]||e.action.replaceAll('_',' '))}<br>${h(e.title)}<br><small>${h(new Date(e.created_at).toLocaleString())}</small></p>`).join('')||'<p>No activity yet.</p>'));document.getElementById('rmActivityBack').onclick=fromSettings?manage:closeModal}catch(e){if(loading.current()){loading.close();alert(showError(e))}}}
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
