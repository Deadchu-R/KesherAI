// Service worker: makes KesherAI installable and lets the app shell open
// instantly. It never caches the API — everything under /api and /v1 always
// goes to the computer, so the phone never shows stale conversations.
const CACHE = "kesherai-shell-v2";

// When the computer is starting (after an update or a restart) the internet link answers
// 502/503/504/530. Instead of that error page, show a short "starting" page that tries again.
const WAITING = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KesherAI</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121213;color:#ededee;font:16px system-ui,sans-serif;text-align:center}p{color:#94949c;max-width:22em;margin:8px auto}.dot{width:14px;height:14px;border-radius:50%;background:#98a3ff;margin:0 auto 18px;animation:p 1.2s ease-in-out infinite}@keyframes p{50%{opacity:.25;transform:scale(.7)}}button{margin-top:14px;padding:10px 18px;border-radius:12px;border:1px solid #333;background:#1f1f22;color:inherit;font:inherit}</style>
<div><div class="dot"></div><h2>המחשב עולה…</h2><p>KesherAI במחשב מתחילה (למשל אחרי עדכון). מנסה שוב לבד כל כמה שניות.</p><p dir="ltr">The computer is starting KesherAI. Trying again…</p><button onclick="location.reload()">נסה עכשיו</button></div>
<script>setInterval(function(){fetch("/api/hello",{cache:"no-store"}).then(function(r){if(r.status<500)location.reload()}).catch(function(){})},4000)</script></html>`;
const DOWN = [502, 503, 504, 530];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return;
  // Network first, so updates show up right away; the cache is the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (event.request.mode === "navigate" && DOWN.includes(res.status)) return new Response(WAITING, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./"))),
  );
});
