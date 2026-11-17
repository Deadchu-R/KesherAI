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
/** A prompt the check expects answers this once (any other dialog is an error). */
let answer;
pg.on("dialog", (d) => {
  if (answer !== undefined) { const a = answer; answer = undefined; return void d.accept(a); }
  errs.push(`dialog: ${d.message()}`);
  void d.dismiss();
});
await pg.goto("http://127.0.0.1:7991/local.html?tab=study");
await pg.waitForTimeout(1500);
const sec = pg.locator("#studySection");
// The first setup (design StudySetupWizardPhone): field, a course, the readiness check, then "later"; leaving in the
// middle resumes at the same step.
const checks = { setup: (await sec.locator("text=מה את לומדת?").count()) > 0 && (await sec.locator("text=שלב 1 מתוך 4").count()) > 0 };
await sec.locator("button", { hasText: "סיעוד" }).click();
await sec.locator("button", { hasText: "הבא ›" }).click();
await pg.waitForTimeout(300);
await sec.locator("input[aria-label=\"שם הקורס\"]").fill("מבוא לסיעוד");
await sec.locator("button", { hasText: "להוסיף ולהמשיך" }).click();
await pg.waitForTimeout(500);
await pg.reload();
await pg.waitForTimeout(1500);
checks.setupResumes = (await sec.locator("text=שלב 3 מתוך 4").count()) > 0 && (await sec.locator("text=האם זה יעבוד בטלפון?").count()) > 0;
await sec.locator("button", { hasText: "הבא ›" }).click();
await pg.waitForTimeout(500);
await sec.locator("button", { hasText: "בשיעור הבא" }).click();
await pg.waitForTimeout(500);
checks.setupDone = (await sec.locator("text=מתחילים:").count()) > 0 && (await pg.evaluate(() => JSON.parse(localStorage.getItem("kesherai-study") || "{}").courses?.[0]?.field)) === "nursing";
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
await sec.locator("button", { hasText: "פתח" }).first().click();
await pg.waitForTimeout(300);
checks.teachBack = (await sec.locator("summary", { hasText: "להסביר במילים שלי" }).count()) > 0;
checks.lectureClean = !/\b(undefined|null)\b/.test(await sec.innerText());
await sec.locator("button", { hasText: "› חזרה" }).first().click().catch(() => undefined);
await pg.waitForTimeout(300);
await sec.locator("button", { hasText: "שאלי את הקורס" }).click();
await pg.waitForTimeout(400);
checks.ask = (await sec.locator("text=התשובות רק מההרצאות שלך").count()) > 0;
checks.askVoice = (await sec.locator("button[aria-label='לשאול בקול']").count()) > 0 && (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
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
const stray = new Set();
const look = async (where) => { if (/\b(undefined|null|NaN)\b|\[object /.test(await sec.innerText())) stray.add(where); };
const open = async (label, wait = 300) => { await sec.locator("button", { hasText: label }).first().click(); await pg.waitForTimeout(wait); await look(label); };
await backTo();
checks.plusButtons = (await sec.locator("button", { hasText: "📱 פיד" }).count()) > 0 && (await sec.locator("button", { hasText: "✉️ מכתב למרצה" }).count()) > 0;
for (const [name, label, look] of [["mock", "📝 מבחן דמה", "button:has-text('לבנות את המבחן')"], ["feed", "📱 פיד", "text=הפיד מתמלא"], ["web", "🕸 מפת הקורס", "text=המפה נבנית"], ["palace", "🏛 ארמון זיכרון", "text=ארמון זיכרון נבנה"], ["papers", "📚 מאמרים ומקורות", "input[type=search]"], ["letter", "✉️ מכתב למרצה", "select[aria-label='סוג המכתב']"], ["writing", "✍️ מאמן כתיבה", "select[aria-label='שלב']"], ["practice", "⚡ 5 דקות", "text=שיעור של 5 דקות"], ["mistakes", "🔁 הטעויות שלי", "text=הטעויות שלי"], ["match", "🧩 התאמה", "text=משחק התאמה"], ["occlusion", "🖼 כרטיסיות מתמונה", "button:has-text('📷 תמונה')"]]) {
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
await sec.locator("button", { hasText: "לעקוב אחרי נוכחות" }).click();
await pg.waitForTimeout(300);
answer = "3";
await sec.locator("button", { hasText: "+ חובת נוכחות" }).first().click();
await pg.waitForTimeout(300);
checks.attendance = (await sec.locator("text=נשארו 3 חיסורים").count()) > 0 && (await wide());
await pg.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/attend-ph.png` : "/dev/null", fullPage: true }).catch(() => undefined);
await backTo();
await open("📈 ההתקדמות שלי");
await sec.locator("[role=radiogroup] button", { hasText: /^15$/ }).first().click();
await pg.waitForTimeout(300);
checks.progress = (await sec.locator("text=שליטה בנושאים").count()) > 0 && (await sec.locator("text=היעד של היום").count()) > 0 && (await wide());
await backTo();
await open("📅 השבוע שלי");
checks.week = (await sec.locator("input[aria-label='תאריך הגשה']").count()) > 0 && (await wide());
await backTo();
await open("📘 אנגלית אקדמית");
checks.english = (await sec.locator("button", { hasText: "לתרגל על הטקסט" }).count()) > 0 && (await wide());
checks.fits = (await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390;
checks.noStrayText = stray.size === 0;
if (stray.size) console.error("stray null/undefined text on:", [...stray].join(", "));
if (shot) await pg.screenshot({ path: shot });
await b.close();
srv.close();
console.log(JSON.stringify({ checks, errors: errs }));
process.exitCode = errs.length || Object.values(checks).includes(false) ? 1 : 0;
