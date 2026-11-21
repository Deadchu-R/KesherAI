// Kesher Cloud hub: the service worker (a module, so it uses the page's own sealing code, compiled to /js/). It shows
// the hub's Web Push: the newest ask with two buttons (Run / Not now, or Approve / Deny) when the PC's sealed note
// opens with this device's key, else the count ("KesherAI: 2 waiting for you"). A button sends the answer sealed from
// this device to the PC; a plain tap opens the hub at that ask's card. It caches nothing: the page always loads fresh.
// apps/hub/page/ask-note.ts has the logic; apps/hub/page/push.ts registers this; apps/hub/src/web-push.ts sends.
import { answerAsk, notificationForPush, resultNotification, samePath } from "/js/apps/hub/page/ask-note.js";
import { get, put } from "/js/apps/hub/page/kv.js";

const io = { get, put, fetch: (u, o) => fetch(u, o), now: () => Date.now() };

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

/** Shows one notification ({title, options} from ask-note.ts). */
function show(n) {
  return self.registration.showNotification(n.title, n.options);
}

self.addEventListener("push", (e) => {
  let raw = {};
  try { raw = e.data ? e.data.json() : {}; } catch { raw = {}; }
  e.waitUntil(notificationForPush(raw, io).then(show));
});

/** Opens (or focuses) the hub at a path on this hub. */
function open(path) {
  const url = new URL(samePath(path), self.location.origin).href;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && "focus" in c) return c.navigate(url).then((w) => (w || c).focus()).catch(() => c.focus());
    }
    return self.clients.openWindow(url);
  });
}

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();
  if ((e.action === "allow" || e.action === "deny") && data.ask) {
    const decision = e.action;
    e.waitUntil(answerAsk(data, decision, io).then(async (result) => {
      const shown = resultNotification(data, decision, result);
      await show(shown);
      // "Sent" closes by itself after a moment; "not sent" and "expired" stay until tapped.
      if (result === "sent" || result === "answered") {
        await new Promise((r) => setTimeout(r, 4000));
        for (const x of await self.registration.getNotifications({ tag: shown.options.tag })) if (x.title === shown.title) x.close();
      }
    }));
    return;
  }
  e.waitUntil(open(data.url));
});
