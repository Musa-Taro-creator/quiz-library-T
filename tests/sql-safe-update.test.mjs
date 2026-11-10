// Supabase runs pg-safeupdate: an UPDATE or DELETE without a WHERE clause fails with
// "UPDATE requires a WHERE clause" (found live in ql_admin_gform_save). Every UPDATE/DELETE
// in supabase/*.sql must have one. PGlite has no safeupdate, so this checks the SQL text.
import assert from 'node:assert/strict';import fs from 'node:fs';import {test} from 'node:test';
const dir=new URL('../supabase/',import.meta.url);
export function unsafeStatements(sql){
 const s=sql.replace(/--[^\n]*/g,'');const out=[];
 const re=/(?<![a-z_])(update|delete\s+from)\s+/gi;let m;
 while((m=re.exec(s))){
  const before=s.slice(Math.max(0,m.index-20),m.index).toLowerCase();
  if(/(do|for|on|before|after|or|instead\s+of)\s*$/.test(before))continue; // on conflict do update, for update, triggers
  const end=s.indexOf(';',m.index),stmt=s.slice(m.index,end<0?s.length:end);
  if(/^update/i.test(m[1])&&!/^update\s+(only\s+)?[\w."]+(\s+as\s+\w+|\s+\w+)?\s+set\b/i.test(stmt))continue; // not an UPDATE statement
  if(!/\bwhere\b/i.test(stmt))out.push({line:s.slice(0,m.index).split('\n').length,stmt:stmt.replace(/\s+/g,' ').slice(0,120)});
 }
 return out;
}
test('the checker finds UPDATE/DELETE without WHERE and ignores ON CONFLICT DO UPDATE / FOR UPDATE',()=>{
 assert.equal(unsafeStatements('update t set a = 1;').length,1);
 assert.equal(unsafeStatements('delete from t;').length,1);
 assert.equal(unsafeStatements('update t set active = (x = v);').length,1);
 assert.equal(unsafeStatements('update t set a = 1 where id = 2;').length,0);
 assert.equal(unsafeStatements('delete from t where true;').length,0);
 assert.equal(unsafeStatements("insert into t values (1) on conflict (id) do update set a = 2;").length,0);
 assert.equal(unsafeStatements('select * from t for update;').length,0);
 assert.equal(unsafeStatements('-- update t set a = 1;\nselect 1;').length,0);
});
test('every UPDATE and DELETE in supabase/*.sql has a WHERE clause (Supabase safeupdate)',()=>{
 const bad=[];
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')))for(const u of unsafeStatements(fs.readFileSync(new URL(f,dir),'utf8')))bad.push(`${f}:${u.line} ${u.stmt}`);
 assert.deepEqual(bad,[]);
});
