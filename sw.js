/* Quiz Library service worker.
   Browsers only offer "Install app" to sites that register one. It caches
   nothing and does not touch requests, so every open still loads the newest
   version of the site (the update banner keeps working as before). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
