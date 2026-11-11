// tools/google-form-maker.gs run in Node with fake Google services (FormApp, DriveApp, ...). No real Google calls.
import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {test} from 'node:test';
const SRC=fs.readFileSync(new URL('../tools/google-form-maker.gs',import.meta.url),'utf8');
function google(){
 const props=new Map(),files=new Map(),folders=new Map(),forms=new Map();let seq=0;const log=[];
 const mkFolder=(name,parent)=>{const id='D'+(++seq);const f={id,name,editors:[],parent,getId:()=>id,getUrl:()=>'https://drive.google.com/drive/folders/'+id,
   createFolder:n=>mkFolder(n,id),addEditor(e){if(/bad/.test(e))throw Error('Invalid email');f.editors.push(e)}};folders.set(id,f);return f};
 const mkItem=(kind)=>{const it={kind,choices:[],points:null,title:'',fb:{}};
   it.setTitle=t=>{it.title=t;return it};it.createChoice=(text,ok)=>({text,ok});it.setChoices=c=>{if(new Set(c.map(x=>x.text)).size!==c.length||c.some(x=>!x.text))throw Error('Choices must be unique and not empty');it.choices=c;return it};
   it.setPoints=p=>{if(!Number.isInteger(p))throw Error('points must be whole');it.points=p;return it};
   it.setFeedbackForCorrect=f=>{it.fb.right=f;return it};it.setFeedbackForIncorrect=f=>{it.fb.wrong=f;return it};it.setGeneralFeedback=f=>{it.fb.general=f;return it};return it};
 const FormApp={create(title){const id='F'+(++seq);const form={id,title,items:[],quiz:false,published:false,accepting:false,responses:3,
   getId:()=>id,getItems:()=>form.items,setIsQuiz:v=>{form.quiz=v},setDescription:v=>{form.description=v},setProgressBar:()=>{},
   addMultipleChoiceItem:()=>{const i=mkItem('radio');form.items.push(i);return i},addCheckboxItem:()=>{const i=mkItem('checkbox');form.items.push(i);return i},addTextItem:()=>{const i=mkItem('text');form.items.push(i);return i},
   setPublished:v=>{form.published=v},setAcceptingResponses:v=>{form.accepting=v},isAcceptingResponses:()=>form.accepting,getResponses:()=>Array(form.responses),
   getTitle:()=>form.title,setTitle:t=>{form.title=t},getPublishedUrl:()=>'https://docs.google.com/forms/d/e/'+id+'/viewform',shortenFormUrl:()=>'https://forms.gle/'+id,getEditUrl:()=>'https://docs.google.com/forms/d/'+id+'/edit'};
   forms.set(id,form);files.set(id,{id,name:title,parents:['root'],trashed:false});if(google.failOn&&title.includes(google.failOn))form.addMultipleChoiceItem=()=>{throw Error('Google said no')};return form},
  openById(id){if(!forms.has(id))throw Error('No item with the given ID');return forms.get(id)},createFeedback:()=>{let t='';const b={setText:x=>{t=x;return b},build:()=>({text:t})};return b}};
 const DriveApp={getFileById(id){const f=files.get(id);if(!f)throw Error('missing');return {getId:()=>id,setTrashed:v=>{f.trashed=v},moveTo:folder=>{f.parents=[folder.getId()]},setName:n=>{f.name=n},getParents:()=>{const p=[...f.parents];return {hasNext:()=>p.length>0,next:()=>folders.get(p.shift())||{getId:()=>'root'}}}}},
  getFolderById(id){if(!folders.has(id))throw Error('missing');return folders.get(id)},getFoldersByName:n=>{const m=[...folders.values()].filter(f=>f.name===n);return {hasNext:()=>m.length>0,next:()=>m.shift()}},createFolder:n=>mkFolder(n,null)};
 const ctx={FormApp,DriveApp,Logger:{log:m=>log.push(m)},Session:{getEffectiveUser:()=>({getEmail:()=>'quizlibrary.forms@gmail.com'})},
  Utilities:{getUuid:()=>'aaaaaaaa-bbbb-cccc-dddd-'+String(++seq).padStart(12,'0')},LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)??null,setProperty:(k,v)=>props.set(k,v),deleteProperty:k=>props.delete(k)})},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:t=>({setMimeType:()=>({text:t})})}};
 vm.createContext(ctx);vm.runInContext(SRC,ctx);
 const post=body=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}}).text);
 return {ctx,props,files,folders,forms,log,post,google};
}
const plain=x=>JSON.parse(JSON.stringify(x));
const QS=[
 {type:'mcq',prompt:'Which is a heart valve?\nPick one',options:['Mitral','Femur','Mitral',''],correct:[0],points:2,explanation:'Mitral is a valve.'},
 {type:'mcq',prompt:'Pick the bones',options:['Femur','Tibia','Aorta'],correct:[0,1],multi:true,points:1.6},
 {type:'true_false',prompt:'The heart has 4 chambers',correct:true,points:1},
 {type:'short_answer',prompt:'Largest artery?',answers:['Aorta'],points:1,explanation:'Leaves the left ventricle.'},
 {type:'mcq',prompt:'No answer yet',options:['A','B'],correct:[-1]}];
test('setup makes the folder and a secret, and logs the Gmail and the secret',()=>{
 const g=google();g.ctx.setup();const secret=g.props.get('SECRET');assert.equal(secret.length,64);
 assert.ok(g.log.some(l=>l.includes(secret))&&g.log.some(l=>l.includes('quizlibrary.forms@gmail.com')));
 assert.equal([...g.folders.values()][0].name,'Quiz Library forms');assert.ok([...g.files.values()].every(f=>f.trashed),'the check form is thrown away');
 g.ctx.setup();assert.equal(g.props.get('SECRET'),secret,'running setup again keeps the secret');
});
test('Without the right secret nothing happens',()=>{
 const g=google();g.ctx.setup();
 assert.deepEqual(g.post({action:'ping'}),{ok:false,error:'Not allowed'});
 assert.deepEqual(g.post({action:'ping',secret:'x'.repeat(64)}),{ok:false,error:'Not allowed'});
 assert.equal(JSON.parse(g.ctx.doGet().text).ok,true);assert.ok(!g.ctx.doGet().text.includes('@'),'GET does not reveal the Gmail');
 assert.deepEqual(g.post({action:'ping',secret:g.props.get('SECRET')}),{ok:true,owner:'quizlibrary.forms@gmail.com',version:2});
});
test('make: a quiz with right answers, points, feedback, published, in the student folder, shared',()=>{
 const g=google();g.ctx.setup();const secret=g.props.get('SECRET');
 const r=g.post({action:'make',secret,user_id:'u-1',user_label:'Bona (QL-BONA0003)',title:'Cardio',questions:QS,editor_email:' Bona@Gmail.com '});
 assert.equal(r.ok,true,JSON.stringify(r));const form=g.forms.get(r.form_id);
 assert.deepEqual([form.quiz,form.published,form.accepting,form.items.length],[true,true,true,5]);
 const [q1,q2,q3,q4,q5]=form.items;
 assert.deepEqual([q1.kind,q1.title,q1.points],['radio','Which is a heart valve? Pick one',2]);
 assert.deepEqual(plain(q1.choices),[{text:'Mitral',ok:true},{text:'Femur',ok:false},{text:'Mitral (2)',ok:false},{text:'(blank)',ok:false}]);
 assert.equal(q1.fb.right.text,'Mitral is a valve.');
 assert.deepEqual(plain([q2.kind,q2.points,q2.choices.filter(c=>c.ok).map(c=>c.text)]),['checkbox',2,['Femur','Tibia']]);
 assert.deepEqual(plain(q3.choices),[{text:'True',ok:true},{text:'False',ok:false}]);
 assert.deepEqual([q4.kind,q4.fb.general.text],['text','Answer: Aorta\nLeaves the left ventricle.']);
 assert.deepEqual([r.no_answer,r.short_answers,r.question_count,r.owner],[1,1,5,'quizlibrary.forms@gmail.com']);
 const folder=[...g.folders.values()].find(f=>f.name==='Quiz Library - Bona (QL-BONA0003)');
 assert.ok(folder&&g.files.get(r.form_id).parents[0]===folder.id);assert.deepEqual(plain(folder.editors),['bona@gmail.com']);
 assert.deepEqual([r.editor_email,r.responder_url,r.edit_url,r.folder_url],['bona@gmail.com','https://forms.gle/'+r.form_id,'https://docs.google.com/forms/d/'+r.form_id+'/edit',folder.getUrl()]);
 const again=g.post({action:'make',secret,user_id:'u-1',user_label:'Bona (QL-BONA0003)',title:'Second',questions:QS.slice(0,1)});
 assert.equal(g.files.get(again.form_id).parents[0],folder.id,'one folder per student');assert.equal(again.editor_email,'');
});
test('make: a bad Gmail still makes the form; a Google error trashes the half-made form',()=>{
 const g=google();g.ctx.setup();const secret=g.props.get('SECRET');
 const r=g.post({action:'make',secret,user_id:'u-2',user_label:'Chea',title:'Q',questions:QS,editor_email:'bad@example.com'});
 assert.equal(r.ok,true);assert.match(r.editor_error,/Could not add bad@example.com/);
 g.google.failOn='Broken';const f=g.post({action:'make',secret,user_id:'u-2',user_label:'Chea',title:'Broken quiz',questions:QS});
 assert.deepEqual(f,{ok:false,error:'Google said no'});
 assert.ok([...g.files.values()].filter(x=>x.name==='Broken quiz').every(x=>x.trashed));
 assert.equal(g.post({action:'make',secret,user_id:'u-2',title:'Empty',questions:[]}).error,'No questions to add.');
 const many=g.post({action:'make',secret,user_id:'u-2',title:'Many',questions:Array.from({length:250},(_,i)=>({type:'true_false',prompt:'Q'+i,correct:true}))});
 assert.equal(many.question_count,200);
});
test('status, rename, open/close and share only touch forms in that student folder',()=>{
 const g=google();g.ctx.setup();const secret=g.props.get('SECRET');
 const a=g.post({action:'make',secret,user_id:'u-1',user_label:'Bona',title:'A',questions:QS});
 const b=g.post({action:'make',secret,user_id:'u-2',user_label:'Chea',title:'B',questions:QS});
 const st=g.post({action:'status',secret,form_ids:[a.form_id,'nope']});
 assert.deepEqual(st.forms[a.form_id],{accepting:true,responses:3,title:'A'});assert.deepEqual(st.forms.nope,{missing:true});
 assert.equal(g.post({action:'rename',secret,user_id:'u-1',form_id:a.form_id,title:'A2'}).title,'A2');assert.equal(g.files.get(a.form_id).name,'A2');
 assert.equal(g.post({action:'accepting',secret,user_id:'u-1',form_id:a.form_id,accepting:false}).accepting,false);assert.equal(g.forms.get(a.form_id).accepting,false);
 assert.match(g.post({action:'rename',secret,user_id:'u-1',form_id:b.form_id,title:'stolen'}).error,/not in your folder/);
 assert.equal(g.forms.get(b.form_id).title,'B');
 const sh=g.post({action:'share',secret,user_id:'u-1',user_label:'Bona',email:'bona@gmail.com'});assert.equal(sh.editor_email,'bona@gmail.com');
 assert.match(g.post({action:'share',secret,user_id:'u-1',email:'not an email'}).error,/Type a Gmail/);
});
test('Big forms in parts: make with more keeps it closed, add appends to the same form, discard trashes; only in that student folder',()=>{
 const g=google();g.ctx.setup();const secret=g.props.get('SECRET');
 assert.equal(g.post({action:'ping',secret}).version,2);
 const r=g.post({action:'make',secret,user_id:'u-1',user_label:'Bona',title:'Big',questions:QS,more:true});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.more,true);const form=g.forms.get(r.form_id);
 assert.deepEqual([form.items.length,form.accepting],[5,false],'closed to answers until the last part');
 const a=g.post({action:'add',secret,user_id:'u-1',form_id:r.form_id,questions:QS,start:5});
 assert.deepEqual([a.ok,a.added,a.question_count,a.no_answer,a.short_answers,form.accepting],[true,5,10,1,1,false]);
 const b=g.post({action:'add',secret,user_id:'u-1',form_id:r.form_id,questions:[{type:'true_false',prompt:'',correct:true}],start:10,last:true});
 assert.deepEqual([b.question_count,form.accepting,form.published],[11,true,true]);
 assert.equal(form.items[10].title,'Question 11','numbering continues across parts');
 const other=g.post({action:'make',secret,user_id:'u-2',user_label:'Chea',title:'Theirs',questions:QS});
 assert.match(g.post({action:'add',secret,user_id:'u-1',form_id:other.form_id,questions:QS}).error,/not in your folder/);
 assert.equal(g.forms.get(other.form_id).items.length,5,'nothing added to someone else\'s form');
 const full=g.post({action:'add',secret,user_id:'u-1',form_id:r.form_id,questions:Array.from({length:250},(_,i)=>({type:'true_false',prompt:'X'+i,correct:true}))});
 assert.equal(full.question_count,200,'never more than 200 questions in one form');
 assert.match(g.post({action:'discard',secret,user_id:'u-2',form_id:r.form_id}).error,/not in your folder/);assert.equal(g.files.get(r.form_id).trashed,false);
 assert.deepEqual(g.post({action:'discard',secret,user_id:'u-1',form_id:r.form_id}),{ok:true});assert.equal(g.files.get(r.form_id).trashed,true);
});
