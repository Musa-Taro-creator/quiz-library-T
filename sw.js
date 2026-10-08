/* Quiz Library service worker.
   Offline mode: the student app (index.html) and the libraries it needs are kept
   on the device, so the app still opens with no internet. Pages are always asked
   from the network first, so every open with internet still gets the newest
   version (the update banner keeps working); the saved copy is only used offline.
   Supabase (login, data, files) is never cached here — the app keeps its own
   offline copy of the library and of saved PDFs. */
const APP_CACHE = "ql-app-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
/* the libraries the student app loads (same addresses as in index.html) + the PDF viewer's worker */
const LIBS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/tus-js-client@4/dist/tus.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"
];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => Promise.all([
    ...SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})),
    ...LIBS.map((u) => c.match(u).then((hit) => hit || c.add(new Request(u, { mode: "cors" })).catch(() => {})))
  ])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ql-app-") && k !== APP_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* the student app page: network first, saved copy when offline */
async function page(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put("index.html", res.clone());
    return res;
  } catch (e) {
    return (await cache.match("index.html")) || (await cache.match("./")) || Response.error();
  }
}
/* libraries and fonts: use the saved copy at once, refresh it in the background */
async function lib(request) {
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
