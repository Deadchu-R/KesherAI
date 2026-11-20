// Kesher Cloud hub: the service worker. It shows the hub's Web Push ("KesherAI: 2 waiting for you", a count only,
// never content) and opens the hub's "Waiting for you" on a tap. It caches nothing: the page always loads fresh.
// Plain script, no build step (apps/hub/page/push.ts subscribes; apps/hub/src/web-push.ts sends).
"use strict";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

/** Only a path on this hub is ever opened (the message is the hub's, but a tap must never leave the hub). */
function samePath(u) {
  return typeof u === "string" && /^\/[^/\\]/.test(u) ? u : "/#waiting";
}

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  var title = typeof d.title === "string" ? d.title.slice(0, 80) : "KesherAI";
  var body = typeof d.body === "string" ? d.body.slice(0, 200) : "";
  e.waitUntil(self.registration.showNotification(title, {
    body: body,
    tag: typeof d.tag === "string" ? d.tag : "kesher-waiting",
    renotify: true,
    icon: "/icon-192.png",
    data: { url: samePath(d.url) },
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL(samePath(e.notification.data && e.notification.data.url), self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).origin === self.location.origin && "focus" in c) return c.navigate(url).then(function (w) { return (w || c).focus(); }).catch(function () { return c.focus(); });
    }
    return self.clients.openWindow(url);
  }));
});
