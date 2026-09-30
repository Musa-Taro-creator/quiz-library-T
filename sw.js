/* Quiz Library service worker.
   Browsers only offer "Install app" to sites that register one. It caches
   nothing and does not touch requests, so every open still loads the newest
   version of the site (the update banner keeps working as before). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
