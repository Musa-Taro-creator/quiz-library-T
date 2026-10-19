// F1-only service-worker lifecycle tests. No network, database, or browser required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {test} from 'node:test';

const source=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const origin='https://quiz.test/';
const legacyLibrary='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const legacyWorker='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const library=origin+'vendor/pdfjs-6.4.299/legacy/build/pdf.min.mjs';
const worker=origin+'vendor/pdfjs-6.4.299/legacy/build/pdf.worker.min.mjs';
const html='<meta name="ql-shell-generation" content="reliability-2026-10-19-v1"><script type="module">import * as pdfjsLib from "'+library+'";</script>';
const oldHtml='<script src="'+legacyLibrary+'"></script>';
const key=x=>new URL(typeof x==='string'?x:x.url,origin).href;
class LocalRequest extends Request {
  constructor(input,options){super(typeof input==='string'?key(input):input,options);}
}
function storage(){
  // Bodies are strings to keep snapshots deterministic; this is Cache API simulation.
  const maps=new Map([
    ['ql-app-v1',new Map([[key('./'),oldHtml],[key('index.html'),oldHtml],[legacyLibrary,'old library'],[legacyWorker,'old worker']])],
    ['ql-off-pdf-user',new Map([['https://ql-offline.invalid/saved.pdf','saved PDF bytes']])],
    ['quiz-cache-user',new Map([['https://quiz.test/saved-quiz','saved questions/settings']])],
    ['ql-app-unrelated',new Map([['https://quiz.test/unrelated','unrelated app data']])]
  ]);
  return {maps,offline:false,fail:null,status:200,quota:false,hold:null,interrupted:false,requests:[],deleted:[],shellReads:new Map()};
}
function boot(store){
  const handlers={},state={skip:0,claim:0};
  const read=async request=>{
    const url=key(request);store.requests.push(url);
    if(store.hold?.url===url)await store.hold.promise;
    if(store.interrupted||store.offline||url===store.fail&&store.status===200)throw Error('network interrupted');
    const isHtml=url===key('./')||url===key('index.html');
    const times=(store.shellReads.get(url)||0)+1;store.shellReads.set(url,times);
    const local=new URL(url).pathname.slice(1);
    const realAsset=local.endsWith('.mjs')||local.endsWith('resources.json');
    const body=isHtml?(store.changeAfterPreflight&&times>1?oldHtml:store.htmlOverride??html):realAsset?fs.readFileSync(new URL('../'+local,import.meta.url),'utf8'):'asset '+url;
    if(request.integrity&&request.integrity!=='sha256-'+createHash('sha256').update(body).digest('base64'))throw TypeError('Integrity mismatch');
    return new Response(body,{status:url===store.fail?store.status:200});
  };
  const caches={
    async open(name){
      if(!store.maps.has(name))store.maps.set(name,new Map());
      const entries=store.maps.get(name);
      return {
        async match(request){const body=entries.get(key(request));return body===undefined?undefined:new Response(body);},
        async put(request,response){if(store.quota)throw Error('QuotaExceededError');entries.set(key(request),await response.text());},
        async addAll(requests){
          // Cache.addAll's atomic commit semantics: no writes until every fetch
          // succeeds; a quota/termination failure commits none of the entries.
          const records=await Promise.all(requests.map(async request=>{
            const response=await read(request);
            if(!response.ok)throw TypeError('Cache.addAll non-success response');
            return [key(request),await response.text()];
          }));
          if(store.quota)throw Error('QuotaExceededError');
          if(store.interrupted)throw Error('worker stopped before commit');
          for(const [url,body]of records)entries.set(url,body);
        }
      };
    },
    async keys(){return [...store.maps.keys()]},
    async delete(name){store.deleted.push(name);return store.maps.delete(name)}
  };
  const context={
    caches,fetch:read,Request:LocalRequest,Response,URL,crypto:webcrypto,Uint8Array,btoa,atob,
    self:{location:{origin:new URL(origin).origin},registration:{scope:origin},
      clients:{claim:async()=>{state.claim++}},
      skipWaiting:async()=>{state.skip++},
      addEventListener:(name,fn)=>{handlers[name]=fn}}
  };
  vm.createContext(context);
  const api=vm.runInContext(source+'\n({APP_CACHE,SHELL,LIBS,page,lib,asset})',context);
  function event(name){let pending;handlers[name]({waitUntil(p){pending=p}});assert.ok(pending);return pending}
  return {api,state,install:()=>event('install'),activate:()=>event('activate'),request:(url)=>new LocalRequest(url)};
}
function protectedSnapshot(store){
  return JSON.stringify([...store.maps].filter(([name])=>name!=='ql-app-v1'&&!name.startsWith('ql-app-reliability-')).map(([name,entries])=>[name,[...entries]]));
}
function legacySnapshot(store){return JSON.stringify([...store.maps.get('ql-app-v1')]);}
async function expectOfflineCurrent(store){
  store.offline=true;
  const restarted=boot(store);
  assert.equal(await(await restarted.api.page(restarted.request('index.html'))).text(),html);
  for(const url of [library,worker]){
    const response=await restarted.api.asset(restarted.request(url));
    assert.equal(response.ok,true);assert.equal(await response.text(),fs.readFileSync(new URL('../'+new URL(url).pathname.slice(1),import.meta.url),'utf8'));
  }
  assert.equal((await restarted.api.lib(restarted.request(legacyLibrary))).type,'error');
  assert.equal((await restarted.api.lib(restarted.request(legacyWorker))).type,'error');
}

test('successful upgrade installs a complete isolated generation, then retires only the legacy app cache',async()=>{
  const store=storage(),runtime=boot(store),protectedBefore=protectedSnapshot(store),legacyBefore=legacySnapshot(store);
  assert.notEqual(runtime.api.APP_CACHE,'ql-app-v1');
  await runtime.install();
  assert.equal(runtime.state.skip,1);
  assert.equal(store.maps.get(runtime.api.APP_CACHE).size,runtime.api.SHELL.length+runtime.api.LIBS.length);
  assert.equal(legacySnapshot(store),legacyBefore,'old generation must remain until activation');
  await runtime.activate();
  assert.deepEqual(store.deleted,['ql-app-v1']);
  assert.equal(runtime.state.claim,1);
  assert.equal(protectedSnapshot(store),protectedBefore);
  await expectOfflineCurrent(store);
});

const failures=[
  ['root shell','./'],['index shell','index.html'],
  ['module',library],['worker',worker],
  ['icon','icons/icon-192.png'],
  ['font',origin+'vendor/pdfjs-6.4.299/standard_fonts/FoxitFixed.pfb'],
  ['Supabase','https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2']
];
for(const [label,url]of failures)for(const status of [200,404]){
  test('failed '+label+' '+(status===200?'network request':'HTTP response')+' prevents installation and preserves the old generation',async()=>{
    const store=storage(),runtime=boot(store),legacyBefore=legacySnapshot(store),protectedBefore=protectedSnapshot(store);
    store.fail=key(url);store.status=status;
    await assert.rejects(runtime.install());
    assert.equal(runtime.state.skip,0);assert.equal(runtime.state.claim,0);
    assert.equal(store.maps.get(runtime.api.APP_CACHE).size,0,'no partial addAll writes');
    assert.equal(legacySnapshot(store),legacyBefore);
    assert.equal(protectedSnapshot(store),protectedBefore);
    assert.deepEqual(store.deleted,[]);
  });
}
test('quota failure cannot replace the old complete app cache',async()=>{
  const store=storage(),runtime=boot(store),before=legacySnapshot(store);
  store.quota=true;
  await assert.rejects(runtime.install(),/QuotaExceededError/);
  assert.equal(runtime.state.skip,0);assert.equal(store.maps.get(runtime.api.APP_CACHE).size,0);
  assert.equal(legacySnapshot(store),before);assert.deepEqual(store.deleted,[]);
});

test('a stopped installation cannot publish partial assets; retry and offline restart succeed',async()=>{
  const store=storage(),before=legacySnapshot(store),protectedBefore=protectedSnapshot(store);
  let release;const blocked=new Promise(resolve=>release=resolve);
  store.hold={url:worker,promise:blocked};
  const first=boot(store),pending=first.install();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(first.state.skip,0);assert.equal(store.maps.get(first.api.APP_CACHE).size,0);
  assert.equal(legacySnapshot(store),before);
  store.interrupted=true;release();
  await assert.rejects(pending);
  assert.equal(first.state.skip,0);assert.equal(legacySnapshot(store),before);
  store.interrupted=false;store.hold=null;
  const retry=boot(store);await retry.install();await retry.activate();
  assert.equal(retry.state.skip,1);assert.equal(protectedSnapshot(store),protectedBefore);
  await expectOfflineCurrent(store);
});

test('interruption after complete cache commit but before activation leaves the legacy cache intact',async()=>{
  const store=storage(),first=boot(store),before=legacySnapshot(store);
  await first.install();
  assert.equal(legacySnapshot(store),before);
  assert.equal(first.state.claim,0);
  // A restarted worker reads the same complete generation, never legacy fallback.
  await expectOfflineCurrent(store);
});

test('HTTP-200 stale or mixed-version HTML fails installation without retiring legacy storage',async()=>{
  for(const body of [oldHtml,html+'<script src="'+legacyLibrary+'"></script>']){
    const store=storage(),runtime=boot(store),before=legacySnapshot(store);
    store.htmlOverride=body;
    await assert.rejects(runtime.install(),/complete/);
    assert.equal(runtime.state.skip,0);assert.equal(runtime.state.claim,0);
    assert.equal(legacySnapshot(store),before);assert.deepEqual(store.deleted,[]);
  }
});

test('stale online HTML cannot poison the validated active generation or the next offline restart',async()=>{
  const store=storage(),runtime=boot(store);
  await runtime.install();await runtime.activate();
  store.htmlOverride=oldHtml;
  const result=await runtime.api.page(runtime.request('index.html'));
  assert.equal(await result.text(),html);
  store.htmlOverride=undefined;
  await expectOfflineCurrent(store);
});

test('a stale repeated install cannot overwrite an already active complete generation',async()=>{
  const store=storage(),first=boot(store);
  await first.install();await first.activate();
  const before=JSON.stringify([...store.maps.get(first.api.APP_CACHE)]);
  store.htmlOverride=oldHtml;
  const retry=boot(store);await assert.rejects(retry.install(),/complete/);
  assert.equal(retry.state.skip,0);
  assert.equal(JSON.stringify([...store.maps.get(first.api.APP_CACHE)]),before);
  await expectOfflineCurrent(store);
});

test('HTML changing after preflight fails integrity without replacing either old or active caches',async()=>{
  for(const alreadyActive of [false,true]){
    const store=storage(),first=boot(store);
    if(alreadyActive){await first.install();await first.activate()}
    const before=JSON.stringify([...store.maps].map(([name,entries])=>[name,[...entries]]));
    store.shellReads.clear();store.changeAfterPreflight=true;
    const retry=boot(store);await assert.rejects(retry.install(),/Integrity mismatch/);
    assert.equal(retry.state.skip,0);
    // A new empty generation may be created, but no existing entries may change.
    const after=JSON.stringify([...store.maps].filter(([name,entries])=>entries.size||name!==first.api.APP_CACHE).map(([name,entries])=>[name,[...entries]]));
    assert.equal(after,before);
  }
});

test('retry after rejected stale HTML builds a valid generation without stale leftovers',async()=>{
  const store=storage(),first=boot(store);store.htmlOverride=oldHtml;
  await assert.rejects(first.install(),/complete/);
  store.htmlOverride=undefined;
  const retry=boot(store);await retry.install();await retry.activate();
  await expectOfflineCurrent(store);
});

test('old open clients cannot redownload either vulnerable file after activation',async()=>{
  const store=storage(),runtime=boot(store);
  await runtime.install();await runtime.activate();
  const count=store.requests.length;
  for(const url of [legacyLibrary,legacyWorker,legacyLibrary+'?cache-bust=1']){
    assert.equal((await runtime.api.lib(runtime.request(url))).type,'error');
  }
  assert.equal(store.requests.length,count,'blocked before a network fetch');
});

test('a runtime with missing new-cache HTML never falls back to the old app generation',async()=>{
  const store=storage(),runtime=boot(store);
  store.offline=true;
  assert.equal((await runtime.api.page(runtime.request('index.html'))).type,'error');
  assert.equal(store.maps.get('ql-app-v1').get(key('index.html')),oldHtml);
});

test('Core PDF files/fonts and the complete auxiliary-resource bundle are cached',()=>{
 const runtime=boot(storage());assert.equal(runtime.api.SHELL.length,6);assert.equal(runtime.api.LIBS.length,20);
 assert.ok(runtime.api.LIBS.includes('vendor/pdfjs-6.4.299/legacy/build/pdf.min.mjs'));
 assert.ok(runtime.api.LIBS.includes('vendor/pdfjs-6.4.299/legacy/build/pdf.worker.min.mjs'));
 assert.ok(runtime.api.LIBS.includes('vendor/pdfjs-6.4.299/standard_fonts/FoxitFixed.pfb'));
 assert.ok(!runtime.api.LIBS.some(url=>url.includes('cmaps/')));
 assert.ok(fs.existsSync(new URL('../vendor/pdfjs-6.4.299/cmaps/78-EUC-H.bcmap',import.meta.url)));
 assert.ok(fs.existsSync(new URL('../vendor/pdfjs-6.4.299/wasm/openjpeg.wasm',import.meta.url)));
});

test('Cold offline CMap/decoder requests are fulfilled from the bundled resources without downloads',async()=>{
 const store=storage(),runtime=boot(store);await runtime.install();await runtime.activate();store.offline=true;const previous=store.requests.length;
 for(const path of ['cmaps/78-EUC-H.bcmap','wasm/openjpeg.wasm','iccs/CGATS001Compat-v2-micro.icc']){
  const response=await runtime.api.asset(runtime.request('vendor/pdfjs-6.4.299/'+path));
  assert.equal(response.ok,true);assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(new URL('../vendor/pdfjs-6.4.299/'+path,import.meta.url)));
 }
 assert.equal(store.requests.length,previous);
});
