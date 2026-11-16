/* global localStorage, sessionStorage, document, location, window, Buffer, process, console -- the functions passed to the page run in the browser; process and console are Node's */
/**
 * A quick check of the phone app's chat list at 390 px in Hebrew: the phone's own chats and the paired computer's
 * chats (as last read) show together; the "Computer" filter shows only the computer's; no page errors.
 *
 * Usage: node apps/android/scripts/chats-check.mjs [www] [out.png]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(process.argv[2] ?? join(here, "..", "www"));
const shot = process.argv[3];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const srv = createServer(async (q, r) => {
  const p = join(root, decodeURIComponent((q.url ?? "/").split("?")[0]));
  try {
    const body = await readFile(p);
    r.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
    r.end(body);
  } catch {
    r.writeHead(404);
    r.end();
  }
});
await new Promise((ok) => srv.listen(7992, ok));
const { chromium } = createRequire(import.meta.url)("playwright");
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
const errors = [];
pg.on("pageerror", (e) => errors.push(String(e)));
await pg.goto("http://127.0.0.1:7992/local.html");
await pg.evaluate(() => {
  localStorage.setItem("kesherai-phone-chats", JSON.stringify([{ id: "p1", title: "צ׳אט בטלפון", name: "Gemma", url: "local:x", updatedAt: Date.now() }]));
  localStorage.setItem("kesherai-pc-chats", JSON.stringify([{ id: "c-1", title: "צ׳אט מהמחשב", updatedAt: Date.now() - 1000, kind: "chat" }]));
});
await pg.goto("http://127.0.0.1:7992/local.html");
await pg.waitForTimeout(400);
await pg.locator("#appTabs [data-go=chats]").click();
await pg.waitForTimeout(400);
const checks = {};
const text = await pg.locator("#chatList").innerText();
checks.both = text.includes("צ׳אט בטלפון") && text.includes("צ׳אט מהמחשב");
checks.tag = (await pg.locator("#chatList .tag.pc").count()) === 1;
await pg.locator("#chatFilters [data-f=pc]").click();
await pg.waitForTimeout(200);
const only = await pg.locator("#chatList").innerText();
checks.pcOnly = only.includes("צ׳אט מהמחשב") && !only.includes("צ׳אט בטלפון");
// "Go on on the phone": a chat handed over from the computer lands in the list with its messages.
const json = JSON.stringify({ t: "מהמחשב", m: [["u", "שאלה"], ["a", "תשובה"]] });
const b64 = Buffer.from(json).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
await pg.goto(`http://127.0.0.1:7992/local.html?handoff=${b64}`);
await pg.waitForTimeout(600);
checks.handoff = await pg.evaluate(() => {
  const list = JSON.parse(localStorage.getItem("kesherai-phone-chats") || "[]");
  const c = list.find((x) => x.title === "מהמחשב");
  const msgs = c && JSON.parse(localStorage.getItem(`kesherai-phone-msgs:${c.id}`) || "[]");
  return !!c && msgs.length === 2 && msgs[1].content === "תשובה" && !location.search.includes("handoff");
});
// The home-screen widget's "Chats" button: the app opens on its chat list (no computer needed).
const w = await b.newPage({ viewport: { width: 390, height: 844 } });
await w.addInitScript(() => {
  // Like the app's own plugin: the request is read once (kept across pages, as the app keeps it natively).
  window.Capacitor = { Plugins: { KesherNotify: { takeOpenPhone: async () => { if (sessionStorage.getItem("taken")) return {}; sessionStorage.setItem("taken", "1"); return { path: "#/phone/chats" }; }, addListener: async () => ({ remove() {} }) } } };
});
await w.goto("http://127.0.0.1:7992/local.html");
await w.waitForTimeout(1200);
checks.widget = w.url().includes("tab=chats") && (await w.locator("#chatsView").isVisible());
await w.close();
checks.fits = (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
if (shot) await pg.screenshot({ path: shot });
await b.close();
srv.close();
console.log(JSON.stringify({ checks, errors }));
process.exit(Object.values(checks).every(Boolean) && !errors.length ? 0 : 1);
