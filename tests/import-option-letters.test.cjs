const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function definition(name,indent=2){
  const prefix=' '.repeat(indent);
  const start=source.search(new RegExp('^'+prefix+'function '+name+'\\(','m'));
  assert.notEqual(start,-1,`${name} exists`);
  const next=source.slice(start+prefix.length+1).search(new RegExp('^'+prefix+'function ','m'));
  assert.notEqual(next,-1,`${name} has a following function`);
  return source.slice(start,start+prefix.length+1+next);
}
const helpers=['qzLetter','qzIsLetterOptionLine','qzIsAnswerLine',
  'qzIsNumberedQuestionStart','qzLooksLikeQuestionSentence','qzSplitBulkBlocks',
  'qzParseBulkText','qzParseAnswerKey','qzNormOpt'].map(name=>definition(name)).join('\n');
function parse(text,key){
  const script=helpers+'\n'+definition('qzApplyKeyToParsed',4)+
    '\nlet bulkParsed=qzParseBulkText('+JSON.stringify(text)+');'+
    'let keyText='+JSON.stringify(key||'')+';'+
    '({applied:qzApplyKeyToParsed(),questions:bulkParsed})';
  return JSON.parse(JSON.stringify(vm.runInNewContext(script)));
}
const options='A. A suture joint.\nC. A synostosis.\nD. A gomphosis.\nE. The interosseous membrane of the forearm.';
const question='9. An example of a wide fibrous joint is ________.\n'+options;

for(const answer of ['E','E. The interosseous membrane of the forearm.','e']){
  test(`Q9 matches source answer ${answer}`,()=>{
    const q=parse(question+'\nAnswer: '+answer).questions[0];
    assert.equal(q.correct_answer,3);
    assert.equal(q._needsReview,false);
    assert.equal(q.options[3].text,'The interosseous membrane of the forearm.');
  });
}
test('source letters also match reordered options',()=>{
  const q=parse('1. Pick the correct option?\nD. Fourth\nA. First\nC. Third\nAnswer: A').questions[0];
  assert.equal(q.correct_answer,1);
  assert.equal(q._needsReview,false);
});
for(const [letter,index] of [['A',0],['C',1],['D',2],['E',3]]){
  test(`separate source key ${letter} selects index ${index}`,()=>{
    const result=parse(question,'1.'+letter);
    assert.equal(result.applied,1);
    assert.equal(result.questions[0].correct_answer,index);
    assert.equal(result.questions[0]._needsReview,false);
  });
}
for(const answer of ['B','Z']){
  test(`absent source letter ${answer} requires review`,()=>{
    assert.equal(parse(question+'\nAnswer: '+answer).questions[0]._needsReview,true);
    const result=parse(question,'1.'+answer);
    assert.equal(result.applied,0);
    assert.equal(result.questions[0]._needsReview,true);
  });
}
test('duplicate source labels cannot silently choose an answer',()=>{
  const duplicate='1. Pick one?\nA. First\nA. Second\nC. Third';
  assert.equal(parse(duplicate+'\nAnswer: A').questions[0]._needsReview,true);
  assert.equal(parse(duplicate,'1.A').applied,0);
});
test('multiple-answer key maps original letters to normalized indices',()=>{
  const q=parse(question,'1.E,A').questions[0];
  assert.deepEqual(q.correct_answer,[0,3]);
  assert.equal(q.allow_multiple,true);
  assert.equal(q._needsReview,false);
});
test('partially invalid multiple-answer key is not partially accepted',()=>{
  const result=parse(question,'1.A,B');
  assert.equal(result.applied,0);
  assert.equal(result.questions[0]._needsReview,true);
});
for(const [text,type,answer] of [
  ['1. Normal question?\nA. First\nB. Second\nC. Third\nAnswer: B','mcq',1],
  ['1. Normal question?\nA. First\nB. Second\nAnswer: Second','mcq',1],
  ['1. Normal question?\nA. First\n*B. Second','mcq',1],
  ['1. Normal question?\nA. First\nB. Second (correct)','mcq',1],
  ['1. True or false?\nA. True\nB. False\nAnswer: B','true_false',false],
  ['1. True or false?\nC. True\nE. False\nAnswer: C','true_false',true],
  ['1. True or false?\nC. True\nE. False\nAnswer: E','true_false',false],
  ['1. Capital of France?\nAnswer: Paris','short_answer',['Paris']]
]){
  test(`preserves ${type} import: ${text.split('\n').at(-1)}`,()=>{
    const q=parse(text).questions[0];
    assert.equal(q.type,type);
    assert.deepEqual(q.correct_answer,answer);
    assert.equal(q._needsReview,false);
  });
}
test('unknown True/False answer letter remains unresolved',()=>{
  const q=parse('1. True or false?\nA. True\nB. False\nAnswer: Z').questions[0];
  assert.equal(q._needsReview,true);
});
test('sequential multiple-answer keys retain their normal behavior',()=>{
  const q=parse('1. Pick two?\nA. First\nB. Second\nC. Third','1.A,C').questions[0];
  assert.deepEqual(q.correct_answer,[0,2]);
  assert.equal(q.allow_multiple,true);
});
