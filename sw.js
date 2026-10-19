/* Quiz Library service worker.
   Offline mode: the student app (index.html) and the libraries it needs are kept
   on the device, so the app still opens with no internet. Pages are always asked
   from the network first, so every open with internet still gets the newest
   version (the update banner keeps working); the saved copy is only used offline.
   Supabase (login, data, files) is never cached here — the app keeps its own
   offline copy of the library and of saved PDFs. */
const APP_CACHE = "ql-app-reliability-2026-10-19-v1";
const SHELL_GENERATION = 'name="ql-shell-generation" content="reliability-2026-10-19-v1"';
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const LIBS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/tus-js-client@4/dist/tus.min.js",
  "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
  "vendor/pdfjs-6.4.299/legacy/build/pdf.min.mjs",
  "vendor/pdfjs-6.4.299/legacy/build/pdf.worker.min.mjs",
  "vendor/pdfjs-6.4.299/resources.json",
  ...["vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-BoldItalic.ttf", "vendor/pdfjs-6.4.299/standard_fonts/FoxitSerifBold.pfb", "vendor/pdfjs-6.4.299/standard_fonts/FoxitFixedBoldItalic.pfb", "vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-Bold.ttf", "vendor/pdfjs-6.4.299/standard_fonts/FoxitSerif.pfb", "vendor/pdfjs-6.4.299/standard_fonts/FoxitSerifBoldItalic.pfb", "vendor/pdfjs-6.4.299/standard_fonts/FoxitFixed.pfb", "vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-Regular.ttf", "vendor/pdfjs-6.4.299/standard_fonts/FoxitSerifItalic.pfb", "vendor/pdfjs-6.4.299/standard_fonts/LiberationSans-Italic.ttf", "vendor/pdfjs-6.4.299/standard_fonts/FoxitFixedItalic.pfb", "vendor/pdfjs-6.4.299/standard_fonts/FoxitDingbats.pfb", "vendor/pdfjs-6.4.299/standard_fonts/FoxitFixedBold.pfb", "vendor/pdfjs-6.4.299/standard_fonts/FoxitSymbol.pfb"]
];
const PDF_INTEGRITY = {"vendor/pdfjs-6.4.299/legacy/build/pdf.min.mjs": "sha256-vMwk6nEduORFA2KVGZBKUpLXO52qohS7583MKCsPQlk=", "vendor/pdfjs-6.4.299/legacy/build/pdf.worker.min.mjs": "sha256-FF0t06sMhhUQEdupWs+i1TNuKszVk4jqQ9vuDv3arsY=", "vendor/pdfjs-6.4.299/resources.json": "sha256-wnD3ZkLHqaic+tSJP8MySItmgAC+aYYrPawygSlc150="};
let pdfResources;
const OLD_PDFJS = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\//;
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
async function currentPage(response){
  if(!response?.ok)return false;
  const html=await response.clone().text();return html.includes(SHELL_GENERATION)&&!html.includes("pdf.js/3.11.174/");
}
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(APP_CACHE);
    const shell=await Promise.all(SHELL.map(async url=>{
      const req=new Request(url,{cache:"reload"});
      if(url!=="./"&&url!=="index.html")return req;
      const response=await fetch(req);
      if(!await currentPage(response))throw Error("Application update is not complete yet");
      const hash=await crypto.subtle.digest("SHA-256",await response.arrayBuffer());
      return new Request(req,{integrity:"sha256-"+btoa(String.fromCharCode(...new Uint8Array(hash)))});
    }));
    // Atomic manifest insertion: failed downloads/quota never activate a partial shell.
    await cache.addAll([...shell,...LIBS.map(url=>new Request(url,{mode:"cors",cache:"reload",integrity:PDF_INTEGRITY[url]||""}))]);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(APP_CACHE);
    if(!await currentPage(await cache.match("index.html")))throw Error("Incomplete application cache");
    for(const url of [...SHELL,...LIBS])if(!await cache.match(url))throw Error("Incomplete application dependencies");
    // Only application generations are retired. Saved PDFs, quizzes and account storage stay intact.
    const names=await caches.keys();
    await Promise.all(names.filter(name=>(name==="ql-app-v1"||name.startsWith("ql-app-reliability-")||name.startsWith("ql-app-pdfjs-"))&&name!==APP_CACHE).map(name=>caches.delete(name)));
    await self.clients.claim();
  })());
});
async function page(request){
  const cache=await caches.open(APP_CACHE);
  try{const response=await fetch(request);if(await currentPage(response)){await cache.put("index.html",response.clone());return response}}catch{}
  return await cache.match("index.html")||Response.error();
}
/* libraries and fonts: use the saved copy at once, refresh it in the background */
async function lib(request) {
  if(OLD_PDFJS.test(request.url))return Response.error();
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((res) => {
    if (res.ok || res.type === "opaque") cache.put(request, res.clone());
    return res;
  }).catch(() => hit || Response.error());
  return hit || fresh;
}
/* icons and manifest: saved copy first */
async function asset(request) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const path=new URL(request.url).pathname.split("/vendor/pdfjs-6.4.299/")[1];
  if(path){
    if(!pdfResources)pdfResources=(async()=>{const packed=await cache.match("vendor/pdfjs-6.4.299/resources.json");return packed?(await packed.json()).files:null})().catch(()=>{pdfResources=null;return null});
    const entry=(await pdfResources)?.[path];
    if(entry)return new Response(Uint8Array.from(atob(entry.base64),c=>c.charCodeAt(0)),{headers:{"Content-Type":entry.type}});
  }
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.searchParams.has("_qlv")) return; // the update check must reach the network
    const p = url.pathname;
    if (req.mode === "navigate" ? !/admin\.html$/.test(p) : /\/(index\.html)?$/.test(p)) { event.respondWith(page(req)); return; }
    if (/\/vendor\/pdfjs-6\.4\.299\//.test(p)) { event.respondWith(asset(req)); return; }
    if (/\/icons\/|\.webmanifest$/.test(p)) { event.respondWith(asset(req)); return; }
    return;
  }
  if (CDN.test(req.url)) event.respondWith(lib(req));
});

/* Admin notifications (admin → Settings → Notifications): a new Help & Support
   message or payment receipt arrives as a push and shows here, even when the
   admin app is closed. Tapping it opens the right admin page. */
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || "Quiz Library", {
    body: d.body || "",
    icon: "icons/admin-192.png",
    badge: "icons/admin-badge.png",   /* Android status bar: white shape on clear background */
    tag: d.tag || undefined,
    renotify: !!d.tag,                /* a 2nd message with the same tag still rings and vibrates */
    vibrate: [200, 100, 200],
    timestamp: Date.now(),
    data: { url: d.url || "admin.html" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "admin.html", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.includes("admin.html") && "focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
