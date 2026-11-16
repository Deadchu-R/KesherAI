/* global localStorage, window, document, process, console -- the functions passed to the page run in the browser; process and console are Node's */
/**
 * A check of recording a lecture with the screen off, with a fake recording service and speech engine: the option is
 * on by default, the clock and "recording" show, and at the end every piece becomes text in time order (with the ⭐
 * mark) and the lecture is saved. No page errors.
 *
 * Usage: node apps/android/scripts/record-check.mjs [www]   (after scripts/vendor.mjs)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(process.argv[2] ?? join(here, "..", "www"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
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
await new Promise((ok) => srv.listen(7997, ok));
const { chromium } = createRequire(join(here, "..", "..", "..", "package.json"))("playwright");
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
pg.on("pageerror", (e) => errs.push(e.message));
pg.on("dialog", (d) => { errs.push(`dialog: ${d.message()}`); void d.dismiss(); });
await pg.addInitScript(() => {
  localStorage.setItem("lang", "he");
  const course = { id: "c1", name: "פרמקולוגיה", t: 1, lectures: [], cards: [], reviews: [], quizzes: [] };
  localStorage.setItem("kesherai-study", JSON.stringify({ courses: [course] }));
  let running = false;
  const started = Date.now();
  window.__rec = { started: 0 };
  window.Capacitor = { isNativePlatform: () => true, Plugins: {
    KesherLlm: { list: async () => ({ models: [{ name: "ggml-small-q5_1.bin" }] }), addListener: async () => ({ remove() {} }) },
    KesherSpeech: {
      whisperAvailable: async () => ({ available: true }),
      transcribeWav: async ({ wav }) => ({ text: wav === "A" ? "חוסמי בטא מורידים דופק" : "ACE מעכבים מרחיבים כלי דם" }),
      recStart: async () => { running = true; window.__rec.started++; return { started }; },
      recState: async () => ({ running, startedAt: started, pieces: 0 }),
      recStop: async () => { running = false; return { pieces: [{ file: "piece-0000.wav", start: 0 }, { file: "piece-0001.wav", start: 30 }] }; },
      recRead: async ({ file }) => ({ wav: file === "piece-0000.wav" ? "A" : "B" }),
      recClear: async () => undefined,
    },
  } };
});
await pg.goto("http://127.0.0.1:7997/local.html?tab=study");
await pg.waitForTimeout(1200);
const sec = pg.locator("#studySection");
const checks = {};
await sec.locator("button", { hasText: "פתח" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: "הקלט הרצאה" }).first().click();
await pg.waitForTimeout(600);
checks.option = await sec.locator("label", { hasText: "להמשיך להקליט כשהמסך כבוי" }).locator("input").isChecked();
await sec.locator("button", { hasText: "התחל הקלטה" }).click();
await pg.waitForTimeout(800);
checks.recording = (await sec.locator("text=מקליט, גם כשהמסך כבוי").count()) > 0 && (await pg.evaluate(() => window.__rec.started)) === 1;
await sec.locator("button", { hasText: "⭐ חשוב" }).click();
await sec.locator("button", { hasText: "סיים הקלטה" }).click();
await pg.waitForTimeout(1500);
const saved = await pg.evaluate(() => JSON.parse(localStorage.getItem("kesherai-study") || "{}").courses?.[0]?.lectures?.[0]?.text ?? "");
checks.saved = /\[00:00\] חוסמי בטא/.test(saved) && /\[00:30\] ACE/.test(saved) && saved.includes("⭐");
checks.fits = (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
await b.close();
srv.close();
console.log(JSON.stringify({ checks, errors: errs }));
process.exit(Object.values(checks).every(Boolean) && !errs.length ? 0 : 1);
