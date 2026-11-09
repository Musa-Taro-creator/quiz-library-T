// A stuck sign-in request must not freeze the site. No network: fetch is simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const read=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
const helperOf=src=>{const m=src.match(/function qlAuthTimeLimit\(fetchFn,ms=20000\)\{.*\}\}\n/);assert.ok(m,'qlAuthTimeLimit not found');return m[0]};
const student=read('index.html'),admin=read('admin.html');
const load=src=>vm.runInNewContext(helperOf(src)+';qlAuthTimeLimit',{AbortController,setTimeout,clearTimeout,Promise,String});
// The in-page sign-in lock the student app gives supabase-js (one request at a time, no time limit of its own).
const lockSrc=student.match(/const qlAuthLocks=\{\};\s*const qlAuthLock=.*?;\n/s)[0];
const makeLock=()=>vm.runInNewContext(lockSrc+';qlAuthLock',{Promise});
const aborted=()=>Object.assign(new Error('aborted'),{name:'AbortError'});
const hang=(input,init)=>new Promise((_,reject)=>{const sig=init?.signal;if(sig?.aborted)return reject(aborted());sig?.addEventListener('abort',()=>reject(aborted()))});
const AUTH='https://x.supabase.co/auth/v1/token?grant_type=refresh_token',DATA='https://x.supabase.co/rest/v1/library_items';

test('Student and admin use the same sign-in time limit',()=>{
 assert.equal(helperOf(student),helperOf(admin));
 assert.match(student,/global:\{fetch:qlAuthTimeLimit\(/);
 assert.match(admin,/global:\{fetch:qlAuthTimeLimit\(/);
});

for(const [name,src] of [['student',student],['admin',admin]]){
 test(name+': a sign-in request that never answers is cancelled',async()=>{
  const limited=load(src)(hang,50);const started=Date.now();
  await assert.rejects(limited(AUTH,{method:'POST'}),{name:'AbortError'});
  assert.ok(Date.now()-started<1000);
 });
}

test('Other requests (data, uploads) are passed on unchanged, with no time limit',async()=>{
 let seen;const init={method:'POST',body:'big PDF'};
 const limited=load(student)((input,i)=>{seen=i;return Promise.resolve('ok')},50);
 assert.equal(await limited(DATA,init),'ok');
 assert.equal(seen,init);
});

test('Cancelling from outside still cancels a sign-in request',async()=>{
 const limited=load(student)(hang,60000),outer=new AbortController();
 const p=limited(AUTH,{signal:outer.signal});outer.abort();
 await assert.rejects(p,{name:'AbortError'});
});

test('After a stuck sign-in request, the next request still runs (no freeze)',async()=>{
 let connectionGood=false;
 const network=(input,init)=>connectionGood?Promise.resolve('library loaded'):hang(input,init);
 const timed=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(()=>r('STILL WAITING'),ms))]);
 const goodAgainSoon=()=>setTimeout(()=>{connectionGood=true},10);
 // Without a time limit (the old code): the stuck refresh keeps the lock; the next request waits forever.
 const lock=makeLock();
 lock('auth',-1,()=>network(AUTH,{})).catch(()=>{});goodAgainSoon();
 assert.equal(await timed(lock('auth',-1,()=>network(DATA,{})),300),'STILL WAITING');
 // With the time limit: the stuck refresh is cancelled after 50 ms and the next request runs.
 connectionGood=false;const lock2=makeLock(),limited=load(student)(network,50);
 const refresh=lock2('auth',-1,()=>limited(AUTH,{})).catch(e=>e.name);goodAgainSoon();
 assert.equal(await timed(lock2('auth',-1,()=>limited(DATA,{})),1000),'library loaded');
 assert.equal(await refresh,'AbortError');
});
