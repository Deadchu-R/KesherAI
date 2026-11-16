/* global localStorage, document, process, console -- the functions passed to the page run in the browser; process and console are Node's */
/**
 * A quick check of the phone app's own Study tab (no computer), at 390 px in Hebrew: the start guide, a course with a
 * lecture and an exam date (the plan shows), the file and photo buttons, and "Ask the course". No page errors.
 *
 * Usage: node apps/android/scripts/study-check.mjs [www] [out.png]   (after scripts/vendor.mjs)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(process.argv[2] ?? join(here, "..", "www"));
const shot = process.argv[3];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

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
await new Promise((ok) => srv.listen(7991, ok));

const { chromium } = createRequire(join(here, "..", "..", "..", "package.json"))("playwright");
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await pg.addInitScript(() => localStorage.setItem("lang", "he"));
const errs = [];
pg.on("pageerror", (e) => errs.push(e.message));
pg.on("dialog", (d) => {
  errs.push(`dialog: ${d.message()}`);
  void d.dismiss();
});
await pg.goto("http://127.0.0.1:7991/local.html?tab=study");
await pg.waitForTimeout(1500);
const sec = pg.locator("#studySection");
const checks = { howto: (await sec.locator("text=איך זה עובד").count()) > 0 };
await sec.locator("input").first().fill("פרמקולוגיה");
await sec.locator("button", { hasText: "+ קורס" }).click();
await pg.waitForTimeout(500);
await sec.locator("input[type=date]").fill("2026-12-25");
await sec.locator("input[type=date]").dispatchEvent("change");
await pg.waitForTimeout(400);
await sec.locator("textarea").fill("דיגוקסין מגביר את כוח ההתכווצות.");
await sec.locator("button", { hasText: "שמור הרצאה" }).click();
await pg.waitForTimeout(400);
await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
const text = await sec.innerText();
checks.plan = /המבחן בעוד \d+ ימים/.test(text);
checks.fileButtons = text.includes("צילום לוח");
await sec.locator("button", { hasText: "שאלי את הקורס" }).click();
await pg.waitForTimeout(400);
checks.ask = (await sec.locator("text=התשובות רק מההרצאות שלך").count()) > 0;
checks.fits = (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
if (shot) await pg.screenshot({ path: shot });
await b.close();
srv.close();
console.log(JSON.stringify({ checks, errors: errs }));
process.exitCode = errs.length || Object.values(checks).includes(false) ? 1 : 0;
