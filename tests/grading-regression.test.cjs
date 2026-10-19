const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test'),{execFileSync}=require('node:child_process');
const path=require('node:path'),root=path.join(__dirname,'..'),s=fs.readFileSync(path.join(root,'index.html'),'utf8');
function functions(source){return [source.slice(source.indexOf('  function qzGradeQuestion('),source.indexOf('  function qzGradeAll(')),source.match(/^  function gradeLocal\(q,given\).*$/m)[0]]}
test('Bug #1 grading expressions remain identical to the published baseline',()=>assert.deepEqual(functions(s),functions(execFileSync('git',['show','9f6c3af:index.html'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}))));
test('124 True/False, MCQ, multi-answer and short-answer regression assertions',()=>{
 const funcs=vm.runInNewContext(functions(s).join('\n')+'\n[qzGradeQuestion,gradeLocal]');let n=0;
 for(const fn of funcs){for(const answer of [true,false,'true','false']){
 for(const given of [true,false,'true','false']){assert.equal(fn({type:'true_false',correct_answer:answer},given),(given===true||given==='true')===(answer===true||answer==='true'));n++}
 for(const given of [undefined,null,'','invalid',0,1,[],{},'False','TRUE']){assert.equal(fn({type:'true_false',correct_answer:answer},given),false);n++}}
 for(const [q,a,ok] of [[{type:'mcq',correct_answer:1},1,true],[{type:'mcq',correct_answer:1},0,false],[{type:'mcq',correct_answer:[0,2]},[2,0],true],[{type:'mcq',correct_answer:[0,2]},[0],false],[{type:'short_answer',correct_answer:['Paris']},' paris ',true],[{type:'short_answer',correct_answer:['Paris']},'London',false]]){assert.equal(fn(q,a),ok);n++}}
 assert.equal(n,124);
});
