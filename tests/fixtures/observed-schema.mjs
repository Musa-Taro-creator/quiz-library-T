// Reproduce the supplied schema metadata in disposable local test engines only.
import fs from 'node:fs';
const root=new URL('../../',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,root),'utf8');
const observed=JSON.parse(read('tests/fixtures/deployed-compatibility.json'));
const types={uuid:'uuid',text:'text',int4:'integer',bool:'boolean',jsonb:'jsonb',numeric:'numeric',timestamptz:'timestamptz'};
const ident=name=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Invalid fixture identifier');return '"'+name+'"'};
export async function createObservedTables(db,names){
 for(const name of names){
  const columns=observed.columns.filter(c=>c.table===name);
  if(!columns.length)throw Error('Unknown observed fixture table');
  const defs=columns.map(c=>{
   if(!types[c.type])throw Error('Unknown fixture type');
   return `${ident(c.column)} ${types[c.type]}${c.default===null?'':' default '+c.default}`;
  });
  defs.push(...observed.constraints.filter(c=>c.table===name).map(c=>c.definition));
  await db.exec(`create table public.${ident(name)} (${defs.join(',')})`);
  for(const index of observed.indexes.filter(i=>i.table===name&&!/CREATE UNIQUE INDEX/.test(i.definition)))await db.exec(index.definition);
 }
}
export async function installObservedItemLimits(db){
 // Supporting helpers match the repository's existing plan implementation;
 // the actual existing item-limit function/trigger comes from the CSV export.
 const source=read('supabase/plans_admin.sql');
 await db.exec(source.slice(source.indexOf('create or replace function public.ql__default_plan()'),source.indexOf('-- ------------------------------------------------------------------ everyone')));
 const trigger=observed.triggers.find(t=>t.table==='student_library_items'&&t.trigger.includes('ql_item_limits'));
 await db.exec(trigger.function+';'+trigger.trigger+';');
}
