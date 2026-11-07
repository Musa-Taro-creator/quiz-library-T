
window.audit={scenario:'',calls:[],writes:[],attempts:[],normalAttempts:[]};
const pix='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>';
window.auditQuiz={id:'audit-quiz',kind:'quiz',title:'Share parity audit',parent_id:null,_student_personalized:true,
 quiz_settings:{question_count:5,layout:'vertical',show_answer_immediately:false,show_answers:true,pass_percent:50,time_limit_minutes:5,shuffle_mode:'off'},
 questions:[
 {id:'audit-q1',type:'mcq',prompt:'First choice?',options:[{text:'First'},{text:'Second'}],correct_answer:0,points:1,session_labels:['Section A'],session_label:'Section A',question_position:0,explanation:'First is correct',image:pix},
 {id:'audit-q2',type:'true_false',prompt:'False is correct?',correct_answer:false,points:1,session_labels:['Section A'],session_label:'Section A',question_position:1,explanation:'False is correct'},
 {id:'audit-q3',type:'short_answer',prompt:'Capital?',correct_answer:['Paris'],points:1,session_labels:['Section B'],session_label:'Section B',question_position:2,explanation:'Paris'},
 {id:'audit-q4',type:'mcq',prompt:'Choose both?',options:[{text:'One'},{text:'Two'},{text:'Three'}],correct_answer:[0,2],allow_multiple:true,points:1,session_labels:['Section B'],session_label:'Section B',question_position:3},
 {id:'audit-q5',type:'mcq',prompt:'Unassigned question?',options:[{text:'One'},{text:'Two'}],correct_answer:1,points:1,session_labels:[],question_position:4}
 ]};
auditQuiz._student_questions=auditQuiz.questions;
window.auditRpc=async(name,args={})=>{
 audit.calls.push({name,args});let data=null;
 const restricted=audit.scenario==='limited';
 const free={id:'free',name:'Free',is_default:true,features:{quiz_autoadv:false,quiz_shuffle:false,quiz_summary:false}};
 const max={id:'max',name:'Max',features:{quiz_autoadv:true,quiz_shuffle:true,quiz_summary:true}};
 if(name==='ql_public_config')data={plans:[free,max],settings:{site:{open:true},features:restricted?{quiz_autoadv:'plan',quiz_shuffle:'plan',quiz_summary:'plan'}:{}},server_time:new Date().toISOString()};
 if(name==='ql_my_plan')data={plan:max,subscription:{status:'active'},usage:{},is_admin:false};
 if(name==='ql_device_check'||name==='ql_device_signin')data={signed_in:true,limit:null,count:1};
 if(name==='ql_get_external_quiz_share')data={quiz_title:auditQuiz.title,identity_mode:audit.scenario==='named'?'name':'guest',payload:{settings:auditQuiz.quiz_settings,questions:auditQuiz.questions.map(q=>{const x={...q};delete x.correct_answer;delete x.explanation;return x})}};
 if(name==='ql_grade_external_quiz_question'){
  const q=auditQuiz.questions.find(q=>q.id===args.p_question_id);
  const r=__quizTest.qzGradeAll([q],{[q.id]:args.p_given_answer});
  data={...r.detail[0],points:q.points};
 }
 if(name==='ql_submit_external_quiz_attempt'){
  const map=Object.fromEntries(args.p_answers.map(a=>[a.question_id,a.given_answer]));
  const r=__quizTest.qzGradeAll(auditQuiz.questions.filter(q=>Object.hasOwn(map,q.id)),map);
  const row={id:'external-attempt-'+audit.attempts.length,attempt_id:'external-attempt-'+audit.attempts.length,...r,passed:r.percent>=50,started_at:args.p_started_at,submitted_at:new Date().toISOString(),session_name:args.p_session_name,taker_identifier:args.p_taker_identifier,taker_name:args.p_taker_name};
  audit.attempts.push(row);data=row;
 }
 if(name==='ql_list_external_quiz_attempts_for_participant')data=audit.attempts.filter(a=>a.taker_identifier===args.p_taker_identifier);
 if(name==='ql_dash_list')data={posts:[{id:'audit-post',kind:'quiz',title:auditQuiz.title,status:'approved'}],mine:[]};
 if(name==='ql_dash_open')data={payload:{root_ref:auditQuiz.id,nodes:[{ref:auditQuiz.id,kind:'quiz',title:auditQuiz.title,quiz_link:location.origin+'/?quiz_share=audit-token'}]}};
 if(name==='ql_my_gifts'||name==='ql_received_item_share_count'||name==='ql_list_received_quiz_shares')data=[];
 return {data,error:null};
};
window.auditClient={rpc:auditRpc,auth:{signOut:async()=>({error:null}),getSession:async()=>({data:{session:null}})},from(){const q=new Proxy({}, {get:(_,p)=>p==='then'?(yes,no)=>Promise.resolve({data:[],error:null}).then(yes,no):()=>q});return q},channel(){const c={on(){return c},subscribe(){return c}};return c},removeChannel:async()=>{}};

// Dashboard RPC responses are simulated; SQL behavior is tested separately.
const originalAuditRpc=auditRpc;
window.auditDb=JSON.parse(localStorage.getItem('audit_dashboard_db')||'{"prefs":{},"attempts":[]}');
const writeAuditDb=()=>localStorage.setItem('audit_dashboard_db',JSON.stringify(auditDb));
const auditKey=args=>[state.user.id,args.p_post_id,args.p_quiz_ref].join(':');
window.auditRpc=async(name,args={})=>{
 if(!name.startsWith('ql_dash_quiz_')&&name!=='ql_dash_list'&&name!=='ql_dash_open'&&name!=='ql_dash_full')return originalAuditRpc(name,args);
 audit.calls.push({name,args});
 const key=()=>auditKey(args);
 if(name==='ql_dash_list')return {data:{posts:[{id:'audit-post',kind:'quiz',title:auditQuiz.title,status:'approved'},{id:'folder-post',kind:'folder',title:'Posted folder',status:'approved'}],mine:[]},error:null};
 if(name==='ql_dash_open')return {data:{payload:{root_ref:args.p_id==='folder-post'?'root':auditQuiz.id,nodes:[...(args.p_id==='folder-post'?[{ref:'root',kind:'folder',title:'Posted folder'},{ref:'nested',parent_ref:'root',kind:'folder',title:'Nested folder'}]:[]),{ref:auditQuiz.id,parent_ref:args.p_id==='folder-post'?'nested':null,kind:'quiz',title:auditQuiz.title,quiz_link:location.origin+'/?quiz_share=audit-token'}]}},error:null};
 if(name==='ql_dash_full')return {data:{root_ref:auditQuiz.id,nodes:[{ref:auditQuiz.id,kind:'quiz',title:auditQuiz.title,quiz_settings:structuredClone(auditQuiz.quiz_settings),questions:structuredClone(auditQuiz.questions)}]},error:null};
 if(audit.missingSql)return {data:null,error:{code:'PGRST202',message:'ql_dash_quiz_get_v1 missing'}};
 if(name==='ql_dash_quiz_get_fast_v1'){
  if(audit.noFastSql)return {data:null,error:{code:'PGRST202',message:'ql_dash_quiz_get_fast_v1 missing'}};
  return {data:{title:auditQuiz.title,revision:'fixture-v1',feedback_mode:'local',settings:{...auditQuiz.quiz_settings,...auditDb.prefs[key()]},questions:structuredClone(auditQuiz.questions)},error:null};
 }
 if(name==='ql_dash_quiz_get_v1')return {data:{title:auditQuiz.title,revision:'fixture-v1',settings:{...auditQuiz.quiz_settings,...auditDb.prefs[key()]},questions:auditQuiz.questions.map(q=>{const x={...q};delete x.correct_answer;delete x.explanation;return x})},error:null};
 if(name==='ql_dash_quiz_tools_v1'){
  auditDb.prefs[key()]={...auditDb.prefs[key()],...args.p_patch};writeAuditDb();return {data:auditDb.prefs[key()],error:null};
 }
 if(name==='ql_dash_quiz_grade_v1'){
  const q=auditQuiz.questions.find(q=>q.id===args.p_question_id),r=__quizTest.qzGradeAll([q],{[q.id]:args.p_given_answer});return {data:{...r.detail[0],points:q.points},error:null};
 }
 if(name==='ql_dash_quiz_submit_v1'){
  const prior=auditDb.attempts.find(x=>x.key===key()&&x.id===args.p_attempt_id);if(prior)return {data:prior,error:null};
  const map=Object.fromEntries(args.p_answers.map(a=>[a.question_id,a.given_answer])),qs=auditQuiz.questions.filter(q=>Object.hasOwn(map,q.id)),r=__quizTest.qzGradeAll(qs,map);
  const row={key:key(),id:args.p_attempt_id,attempt_id:args.p_attempt_id,...r,passed:r.percent>=50,user_id:state.user.id,taker_name:'Student',taker_identifier:'auth:'+state.user.id,identity_mode:'account',started_at:args.p_started_at,submitted_at:new Date().toISOString(),session_name:args.p_session_name};
  auditDb.attempts.push(row);writeAuditDb();return {data:row,error:null};
 }
 if(name==='ql_dash_quiz_history_v1')return {data:auditDb.attempts.filter(x=>x.key===key()),error:null};
 throw Error('Unexpected Dashboard RPC '+name);
};
auditClient.rpc=(...args)=>auditRpc(...args);
