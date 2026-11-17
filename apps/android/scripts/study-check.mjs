/* global localStorage, document, process, console -- the functions passed to the page run in the browser; process and console are Node's */
/**
 * A quick check of the phone app's own Study tab (no computer), at 390 px in Hebrew: the start guide, a course with a
 * lecture and an exam date (the plan shows), the file and photo buttons, "Ask the course" and its study mode. No page
 * errors.
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
await sec.locator("input[aria-label=\"שם קורס\"]").fill("פרמקולוגיה");
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
checks.share = text.includes("שיתוף הקורס");
await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
checks.focus = (await sec.locator("text=טיימר ריכוז").count()) > 0;
await sec.locator("button", { hasText: "התחלה" }).click();
await pg.waitForTimeout(1200);
checks.focusRuns = /\d\d:\d\d/.test(await sec.locator(".ph-clock").innerText());
await sec.locator("button", { hasText: "עצירה" }).click();
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: "פתח" }).first().click();
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: "שאלי את הקורס" }).click();
await pg.waitForTimeout(400);
checks.ask = (await sec.locator("text=התשובות רק מההרצאות שלך").count()) > 0;
await sec.locator("button", { hasText: "מצב תרגול" }).click();
await pg.waitForTimeout(300);
checks.studyMode = (await sec.locator("button", { hasText: "התחילי תרגול" }).count()) > 0;
await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: "סיכום הקורס" }).first().click();
await pg.waitForTimeout(300);
checks.summary = (await sec.locator("text=הסיכום של כל הקורס").count()) + (await sec.locator("button", { hasText: "כתיבת סיכום הקורס" }).count()) > 0;
await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: /^בוחן$/ }).first().click();
await pg.waitForTimeout(300);
checks.openQuiz = (await sec.locator("button", { hasText: "3 שאלות מקרה" }).count()) > 0 && (await sec.locator("select[aria-label='רמת קושי']").count()) > 0;
await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: "כלים לתחום" }).first().click();
await pg.waitForTimeout(300);
checks.tools = (await sec.locator("select[aria-label='כלי'] option").count()) > 0;
// The features from the computer's Study, on the phone alone (phone-study-plus.js).
const wide = async () => (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
const backTo = async () => { await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined); await pg.waitForTimeout(300); };
const open = async (label, wait = 300) => { await sec.locator("button", { hasText: label }).first().click(); await pg.waitForTimeout(wait); };
await backTo();
checks.plusButtons = (await sec.locator("button", { hasText: "📱 פיד" }).count()) > 0 && (await sec.locator("button", { hasText: "✉️ מכתב למרצה" }).count()) > 0;
for (const [name, label, look] of [["feed", "📱 פיד", "text=הפיד מתמלא"], ["web", "🕸 מפת הקורס", "text=המפה נבנית"], ["palace", "🏛 ארמון זיכרון", "text=ארמון זיכרון נבנה"], ["papers", "📚 מאמרים ומקורות", "input[type=search]"], ["letter", "✉️ מכתב למרצה", "select[aria-label='סוג המכתב']"]]) {
  await open(label);
  checks[name] = (await sec.locator(look).count()) > 0 && (await wide());
  await backTo();
}
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
await sec.locator("input[type=date]").fill(tomorrow);
await sec.locator("input[type=date]").dispatchEvent("change");
await pg.waitForTimeout(400);
checks.examEve = (await sec.locator("text=המבחן מחר").count()) > 0 && (await sec.locator("text=דקה של נשימה רגועה").count()) > 0;
await backTo();
await open("🎓 ציונים ותואר");
await sec.locator("input[placeholder='שם הקורס']").fill("פיזיולוגיה");
await sec.locator("button", { hasText: "+ קורס" }).last().click();
await pg.waitForTimeout(300);
checks.grades = (await sec.locator("text=פיזיולוגיה").count()) > 0 && (await sec.locator("text=התקדמות בתואר").count()) > 0 && (await wide());
await backTo();
await open("🗓 מערכת שעות");
await sec.locator("select[aria-label='יום']").selectOption("1");
await sec.locator("button", { hasText: /^הוספה$/ }).click();
await pg.waitForTimeout(300);
checks.timetable = (await sec.locator("text=10:00–12:00").count()) > 0 && (await wide());
await backTo();
await open("📘 אנגלית אקדמית");
checks.english = (await sec.locator("button", { hasText: "לתרגל על הטקסט" }).count()) > 0 && (await wide());
checks.fits = (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
if (shot) await pg.screenshot({ path: shot });
await b.close();
srv.close();
console.log(JSON.stringify({ checks, errors: errs }));
process.exitCode = errs.length || Object.values(checks).includes(false) ? 1 : 0;
