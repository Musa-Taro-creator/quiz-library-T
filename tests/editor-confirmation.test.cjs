const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const body=source.slice(source.indexOf('    async function qzPersistSnapshot(){'),source.indexOf('\n    function rerenderQuestions(){'));
function editor({revision=5,count=1,editDuringSave=false}={}){
 const questions=[{id:'draft-q',prompt:'My unsaved work'}];
 const rows=Array.from({length:count},()=>({id:'server-q',prompt:'Confirmed work'}));
 Object.defineProperty(rows,'_qlRevision',{value:revision});
 let cleared=0,drafted=0;
 const ctx={questions,settings:{layout:'vertical'},curItem:{id:'quiz'},qzPendingSave:null,qzEditGeneration:1,qzBaseRevision:4,qzLastSavedSnapshot:null,qzLastSavedOrder:[],qzLastSavedSettings:'',
 uid:()=> 'operation-id',qzCleanQuestionFields:q=>({prompt:q.prompt}),replaceLocal:()=>{},qzSnapshotFromQuestions:qs=>new Map(qs.map(q=>[q.id,JSON.stringify(q)])),
 qzClearDraft:()=>cleared++,qzSaveDraftNow:()=>drafted++,logActivity:async()=>{},
 service:{saveQuizQuestions:async()=>{if(editDuringSave){ctx.qzEditGeneration++;questions[0].prompt='Newer unsaved work'}return {id:'quiz',_qlRevision:5}},getQuizQuestionsAdmin:async()=>rows}};
 return {ctx,save:vm.runInNewContext(body+'\nqzPersistSnapshot',ctx),result:()=>({cleared,drafted})};
}
test('A concurrent same-size quiz replacement during full-save confirmation retains the draft',async()=>{
 const e=editor({revision:6});await assert.rejects(e.save(),/QL_CONFLICT/);
 assert.equal(e.result().cleared,0);assert.equal(e.ctx.questions[0].id,'draft-q');assert.equal(e.ctx.qzBaseRevision,4);
});
test('A changed question count during confirmation retains the draft',async()=>{
 const e=editor({count:2});await assert.rejects(e.save(),/QL_CONFLICT/);assert.equal(e.result().cleared,0);
});
test('Only a matching confirmed generation clears the acknowledged draft',async()=>{
 const e=editor();await e.save();assert.equal(e.result().cleared,1);assert.equal(e.ctx.qzBaseRevision,5);
});
test('New edits made during full-save confirmation remain in the draft',async()=>{
 const e=editor({editDuringSave:true});await e.save();assert.equal(e.result().cleared,0);assert.equal(e.result().drafted,1);assert.equal(e.ctx.questions[0].prompt,'Newer unsaved work');
});
