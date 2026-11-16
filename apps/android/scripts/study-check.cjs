/**
 * A quick check of the phone app's own Study tab (no computer), at 390 px in Hebrew: the start guide, a course with a
 * lecture and an exam date (the plan shows), the file and photo buttons, and "Ask the course". No page errors.
 *
 * Usage: node apps/android/scripts/study-check.cjs apps/android/www out.png   (after scripts/vendor.mjs)
 */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = process.argv[2];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split("?")[0])); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); r.end(d); }); }).listen(7991, async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await pg.addInitScript(() => localStorage.setItem("lang", "he"));
  const errs = []; pg.on("pageerror", (e) => errs.push(e.message)); pg.on("dialog", (d) => { errs.push("dialog: " + d.message()); d.dismiss(); });
  await pg.goto("http://127.0.0.1:7991/local.html?tab=study"); await pg.waitForTimeout(1500);
  const sec = pg.locator("#studySection");
  console.log("HOWTO", await sec.locator("text=איך זה עובד").count());
  await sec.locator("input").first().fill("פרמקולוגיה"); await sec.locator("button", { hasText: "+ קורס" }).click(); await pg.waitForTimeout(500);
  await sec.locator("input[type=date]").fill("2026-11-25"); await sec.locator("input[type=date]").dispatchEvent("change"); await pg.waitForTimeout(400);
  await sec.locator("textarea").fill("דיגוקסין מגביר את כוח ההתכווצות."); await sec.locator("button", { hasText: "שמור הרצאה" }).click(); await pg.waitForTimeout(400);
  await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => {}); await pg.waitForTimeout(300);
  const text = await sec.innerText();
  console.log("PLAN", /המבחן בעוד \d+ ימים/.test(text), "| FILEBTN", text.includes("צילום לוח"));
  await sec.locator("button", { hasText: "שאלי את הקורס" }).click(); await pg.waitForTimeout(400);
  console.log("ASKVIEW", await sec.locator("text=התשובות רק מההרצאות שלך").count());
  console.log("SCROLLW", await pg.evaluate(() => document.documentElement.scrollWidth));
  await pg.screenshot({ path: process.argv[3] });
  console.log("ERRS", JSON.stringify(errs));
  process.exitCode = errs.length ? 1 : 0;
  await b.close(); srv.close();
});
