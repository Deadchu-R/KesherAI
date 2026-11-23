// Kesher Cloud hub: the service worker (a module, so it uses the page's own sealing code, compiled to /js/). It shows
// the hub's Web Push: the newest ask with two buttons (Run / Not now, or Approve / Deny) when the PC's sealed note
// opens with this device's key, else the count ("KesherAI: 2 waiting for you"). A button sends the answer sealed from
// this device to the PC; a plain tap opens the hub at that ask's card.
// It also keeps the page shell (offline-first, packages/shared/src/hub-offline.ts): the page, its style and every
// module, network first. When Cloudflare is down (no answer in 5 s, or a 5xx) the kept copy is served, so a paired
// phone still opens the page and sends through the backup relays. API answers are never kept.
// apps/hub/page/ask-note.ts has the logic; apps/hub/page/push.ts registers this; apps/hub/src/web-push.ts sends.
import { answerAsk, notificationForPush, resultNotification, samePath } from "/js/apps/hub/page/ask-note.js";
import { get, put } from "/js/apps/hub/page/kv.js";
import { SHELL_CACHE, SHELL_CORE, SHELL_TIMEOUT_MS, shellDown, shellKey, shellModules } from "/js/packages/shared/src/hub-offline.js";

const io = { get, put, fetch: (u, o) => fetch(u, o), now: () => Date.now() };

/** Keeps one shell file from the network (only a full same-origin 200). */
async function keep(cache, path) {
  const res = await fetch(path, { cache: "no-cache" }).catch(() => undefined);
  if (res && res.ok && res.type === "basic") await cache.put(path, res.clone());
  return res;
}

/** At install: the core files and every module app.js imports. Best effort: a failure here must not stop push. */
async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(SHELL_CORE.map((p) => keep(cache, p)));
  const read = async (p) => {
    const res = (await cache.match(p)) ?? (await keep(cache, p));
    return res && res.ok ? res.clone().text() : undefined;
  };
  await shellModules(read);
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(precache().catch(() => undefined));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith("kesher-hub-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)))),
  ]));
});

/** Network first (a fresh page whenever the hub answers, and the copy refreshed); the kept copy when it is down. */
async function shell(req, key) {
  const cache = await caches.open(SHELL_CACHE);
  const res = await fetch(req, { signal: AbortSignal.timeout(SHELL_TIMEOUT_MS) }).catch(() => undefined);
  if (!shellDown(res?.status)) {
    if (res.ok && res.type === "basic" && !res.redirected) await cache.put(key, res.clone()).catch(() => undefined);
    return res;
  }
  return (await cache.match(key)) ?? res ?? Response.error();
}

self.addEventListener("fetch", (e) => {
  const key = shellKey(e.request.url, self.location.origin, e.request.method);
  if (key) e.respondWith(shell(e.request, key));
});

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
