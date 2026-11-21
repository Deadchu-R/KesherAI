/* global localStorage -- the functions passed to page.evaluate run in the browser */
// Checks that every press-and-slide menu button (`data-slide-menu`, apps/web/src/slideMenus.ts) opens its menu
// with ONE press and keeps it open: a real held finger on a 390 px phone (touch events through the DevTools
// protocol, as a phone's WebView sends them), a mouse at computer width, and the keyboard (Enter). On the phone
// the menu opens as a sheet right under the finger, so the tap's own click must not toggle it again or choose
// an item. Screens: Home, the code start screen and a chat (its composer), with the top bar and side menu.
//
// Usage: node scripts/menu-tap-check.mjs   (needs `pnpm build:packages` and the web build)
// Playwright is found as a dependency, or set PLAYWRIGHT_MODULE to its index.js.

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = 7992;
const base = `http://127.0.0.1:${port}`;
const pw = process.env.PLAYWRIGHT_MODULE ? (await import(process.env.PLAYWRIGHT_MODULE)).default : createRequire(join(root, "package.json"))("playwright");

// A made-up chat, so the chat composer's menus show (the check's KesherAI has no model to make a real one).
const at = new Date().toISOString();
const chat = { id: "tap-check", title: "Tap check", kind: "chat", projectId: null, modelId: "none/none", mode: "ask", createdAt: at, updatedAt: at, session: { id: "tap-check", status: "idle", modelId: "none/none", mode: "ask", pendingApprovals: [], pendingQuestions: [], canUndo: false, grants: [] }, events: [{ seq: 1, at, type: "user", text: "Hi" }, { seq: 2, at, type: "assistant", turn: 1, text: "Hello" }] };
const ROUTES = ["#/", "#/code", `#/c/${chat.id}`];

/** Whether a menu button shows its menu as open (menus: aria-expanded; the side menu button: aria-pressed). */
const isOpen = (el) => (el.getAttribute("aria-expanded") ?? el.getAttribute("aria-pressed")) === "true";

const data = await mkdtemp(join(tmpdir(), "kesher-tap-"));
const server = spawn(process.execPath, [join(root, "packages/core/dist/main.js"), "--port", String(port), "--data-dir", data, "--no-autodetect"], { stdio: "ignore", env: { ...process.env, KESHER_NO_BEACON: "1" } });
const problems = [];
let checked = 0;
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
  }
  if (!up) throw new Error("The server did not start.");
  const browser = await pw.chromium.launch();
  for (const [name, w, h, touch] of [["phone", 390, 844, true], ["computer", 1280, 800, false]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.route(`**/api/conversations/${chat.id}`, (r) => (r.request().method() === "GET" ? r.fulfill({ json: chat }) : r.continue()));
    await ctx.addInitScript((phone) => {
      try {
        localStorage.setItem("locale", "he");
        if (phone) localStorage.setItem("kesher-token", "tap-check");
      } catch { /* private mode */ }
    }, touch);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${name}: page error: ${e.message}`));
    const cdp = touch ? await ctx.newCDPSession(page) : null;
    /** Presses and lifts at a point, held like a finger (or a mouse button), with no Playwright retries. */
    const press = async (x, y) => {
      if (cdp) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await page.waitForTimeout(150);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
      }
    };
    const fresh = async (route) => {
      await page.goto(`${base}/${route}`);
      await page.reload();
      await page.waitForTimeout(1200);
      await page.getByText(/^(דלג|Skip)/).first().click({ timeout: 1000 }).catch(() => undefined);
    };
    for (const route of ROUTES) {
      await fresh(route);
      const count = await page.locator("[data-slide-menu]:visible").count();
      if (!count) problems.push(`${name} ${route}: no menu buttons found`);
      for (let i = 0; i < count; i++) {
        await fresh(route);
        // A handle, not a locator: opening a menu can show or hide other menu buttons and shift the numbering.
        const btn = await page.locator("[data-slide-menu]:visible").nth(i).elementHandle({ timeout: 3000 }).catch(() => null);
        if (!btn) continue;
        const label = `${name} ${route} "${(await btn.getAttribute("aria-label")) ?? (await btn.textContent())?.trim()}"`;
        const before = await btn.evaluate(isOpen);
        // In the middle of the screen, clear of the phone's bottom bar (a real finger would scroll there too).
        await btn.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(150);
        const box = await btn.boundingBox();
        if (!box) continue;
        const url = page.url();
        await press(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(500);
        const after = await btn.evaluate(isOpen);
        checked++;
        if (after === before) problems.push(`${label}: one ${touch ? "tap" : "click"} did not toggle it (still ${after ? "open" : "closed"})`);
        if (page.url() !== url) problems.push(`${label}: the tap chose something in the menu (went to ${page.url()})`);
        // The keyboard still toggles it (computer only: a phone has no Enter on a button). Compared with the state
        // just before, since the side menu remembers whether it was shown.
        if (!touch) {
          await fresh(route);
          const k = await page.locator("[data-slide-menu]:visible").nth(i).elementHandle({ timeout: 3000 }).catch(() => null);
          if (!k) continue;
          const was = await k.evaluate(isOpen);
          await k.focus();
          await page.keyboard.press("Enter");
          await page.waitForTimeout(400);
          if ((await k.evaluate(isOpen)) === was) problems.push(`${label}: Enter did not toggle it`);
        }
      }
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  server.kill();
}
console.log(`menu-tap-check: ${checked} menu buttons checked`);
if (problems.length) {
  console.log(problems.join("\n"));
  process.exitCode = 1;
}
