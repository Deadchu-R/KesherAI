/* global window, document, localStorage, getComputedStyle, requestAnimationFrame, innerHeight, innerWidth -- the functions passed to page.evaluate run in the browser */
// The interface check that runs on every version: the real server starts empty,
// a browser opens every main screen at computer width (1280) and phone width
// (390 and 360, as the remote app), and the check fails on a page error or a page wider
// than the screen. A picture of every screen is saved, to look at when it fails. It also measures three speeds
// (first screen, typing in a 200-message chat, drawing a streamed token) and fails above generous limits.
//
// Usage: node scripts/ui-check.mjs [outDir]   (needs `pnpm build:packages` and the web build)
// Playwright is found as a dependency, or set PLAYWRIGHT_MODULE to its index.js.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "ui-check"));
const port = 7990;
const base = `http://127.0.0.1:${port}`;

/** The screens to open (hash routes), and a made-up 200-message chat. */
const PAGES = ["#/", "#/code", "#/unity", "#/godot", "#/unreal", "#/models", "#/personas", "#/knowledge", "#/pages", "#/images", "#/connections", "#/updates", "#/apps", "#/nodes", "#/pipelines", "#/watch", "#/settings", "#/canvas", "#/tasks", "#/study", "#/study/calc"];

const load = async () => {
  if (process.env.PLAYWRIGHT_MODULE) return (await import(process.env.PLAYWRIGHT_MODULE)).default;
  return createRequire(join(root, "package.json"))("playwright");
};

const pw = await load();
// Accessibility (board t44, docs/DESIGN_RESEARCH.md §3 step 4): axe-core on every screen at computer width; "serious" and
// "critical" findings fail the check, the others are listed. Rules can be skipped with a reason in A11Y_SKIP.
const axeSource = await import("node:fs/promises").then((fs) => fs.readFile(createRequire(join(root, "package.json")).resolve("axe-core/axe.min.js"), "utf8"));
const A11Y_SKIP = {};
const a11yNotes = [];
await mkdir(out, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "kesher-ui-"));
const server = spawn(process.execPath, [join(root, "packages/core/dist/main.js"), "--port", String(port), "--data-dir", data, "--no-autodetect"], { stdio: "ignore", env: { ...process.env, KESHER_NO_BEACON: "1" } });
const problems = [];
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
  }
  if (!up) throw new Error("The server did not start.");
  // A made-up chat (the check's KesherAI has no model, so it cannot make a real one): its summary, session and events.
  const at = new Date().toISOString();
  const fake = { id: "speed-check", title: "Speed check", kind: "chat", projectId: null, modelId: "none/none", mode: "auto-edit", createdAt: at, updatedAt: at };
  const session = { id: fake.id, status: "idle", modelId: fake.modelId, mode: fake.mode, pendingApprovals: [], pendingQuestions: [], canUndo: false, grants: [] };
  const para = "A **long** answer with `code`, a [link](https://example.com) and a list:\n\n- one\n- two\n\nThen more words to wrap over a few lines in the chat column, like a real reply would.";
  const events = Array.from({ length: 200 }, (_, i) => (i % 2 ? { seq: i + 1, at, type: "assistant", turn: (i + 1) / 2, text: para } : { seq: i + 1, at, type: "user", text: `Question number ${i / 2 + 1}?` }));
  const fakeChat = (r) => (r.request().method() === "GET" ? r.fulfill({ json: { ...fake, session, events } }) : r.continue());
  const pages = [...PAGES, `#/c/${fake.id}`];
  const browser = await pw.chromium.launch();
  for (const [w, h, name] of [[1280, 800, "computer"], [390, 844, "phone"], [360, 780, "small-phone"]]) {
    // axe runs as a script added to the page, which the app's own CSP would refuse (only at computer width).
    const page = await browser.newPage({ viewport: { width: w, height: h }, ...(name === "computer" ? { bypassCSP: true } : {}) });
    await page.route(`**/api/conversations/${fake.id}`, fakeChat);
    let current = "";
    page.on("pageerror", (e) => problems.push(`${name} ${current}: page error: ${e.message}`));
    page.on("console", (m) => {
      // React's warnings and failed fetches of things an empty KesherAI does not have are not interface bugs.
      if (m.type() === "error" && !/Failed to load resource|favicon|404|503/.test(m.text())) problems.push(`${name} ${current}: console: ${m.text().slice(0, 200)}`);
    });
    if (name === "phone") await page.addInitScript(() => { try { localStorage.setItem("kesher-token", "ui-check"); } catch { /* private mode */ } });
    await page.goto(`${base}/#/`);
    await page.waitForTimeout(1200);
    // The first-run welcome: skip it (Hebrew or English).
    await page.getByText(/^(דלג|Skip)/).first().click({ timeout: 1500 }).catch(() => undefined);
    for (const p of pages) {
      current = p;
      await page.goto(`${base}/${p}`);
      await page.waitForTimeout(1200);
      // Anything that sticks out past the screen's edge (the page itself may hide the overflow), unless it sits
      // inside something that scrolls or clips on purpose (code blocks, graphs, carousels).
      const measured = await page.evaluate(() => {
        const W = window.innerWidth;
        const clipped = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
          }
          return false;
        };
        const bad = [];
        for (const el of document.body.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || getComputedStyle(el).position === "fixed") continue;
          if ((r.right > W + 2 || r.left < -2) && !clipped(el)) bad.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : ""} (${Math.round(r.left)}–${Math.round(r.right)})`);
          if (bad.length >= 3) break;
        }
        return { wide: document.documentElement.scrollWidth - W, bad };
      });
      if (name === "computer") {
        await page.addScriptTag({ content: axeSource });
        const found = await page.evaluate(async (skip) => {
          const r = await window.axe.run(document, { resultTypes: ["violations"], rules: Object.fromEntries(Object.keys(skip).map((k) => [k, { enabled: false }])) });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, where: v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | "), n: v.nodes.length }));
        }, A11Y_SKIP);
        for (const v of found) {
          const line = `${p}: ${v.id} (${v.impact}, ${v.n}×): ${v.help} — ${v.where}`;
          if (v.impact === "serious" || v.impact === "critical") problems.push(`accessibility ${line}`);
          else a11yNotes.push(line);
        }
      }
      if (measured.wide > 2) problems.push(`${name} ${p}: the page is ${measured.wide}px wider than the screen (it scrolls sideways)`);
      if (measured.bad.length) problems.push(`${name} ${p}: past the screen's edge: ${measured.bad.join(", ")}`);
      const file = `${name}-${p.replace(/^#\//, "").replace(/[^\w-]+/g, "_") || "home"}.png`;
      await page.screenshot({ path: join(out, file) });
    }
    await page.close();
  }

  // The controller (audit C6): a simulated pad moves the focus with the D-pad, A on a search field opens the on-screen
  // keyboard, B closes it.
  const padPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  padPage.on("pageerror", (e) => problems.push(`pad: page error: ${e.message}`));
  await padPage.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: "ui-check pad", index: 0, connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
  await padPage.goto(`${base}/#/settings`);
  await padPage.waitForTimeout(1500);
  const press = async (i) => {
    await padPage.evaluate((b) => { window.__pad.buttons[b].pressed = true; }, i);
    await padPage.waitForTimeout(120);
    await padPage.evaluate((b) => { window.__pad.buttons[b].pressed = false; }, i);
    await padPage.waitForTimeout(160);
  };
  await padPage.evaluate(() => window.dispatchEvent(new Event("gamepadconnected")));
  const before = await padPage.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "");
  for (let k = 0; k < 3; k++) await press(13); // D-pad down
  const after = await padPage.evaluate(() => ({ el: document.activeElement?.outerHTML.slice(0, 80) ?? "", pad: document.documentElement.classList.contains("pad") }));
  if (after.el === before || !after.pad) problems.push("pad: the D-pad did not move the focus (or pad mode did not turn on)");
  const field = await padPage.evaluate(() => {
    const f = document.querySelector('main input[type="search"], main input[type="text"]');
    if (!f) return false;
    f.focus();
    return true;
  });
  if (!field) problems.push("pad: no search field on the settings page to try the on-screen keyboard on");
  else {
    await press(0); // A
    if (!(await padPage.evaluate(() => !!document.querySelector(".osk")))) problems.push("pad: A on a field did not open the on-screen keyboard");
    await press(1); // B
    if (await padPage.evaluate(() => !!document.querySelector(".osk"))) problems.push("pad: B did not close the on-screen keyboard");
  }
  // Every main screen with the pad: the D-pad moves the focus to something on the screen, and on (a stuck focus or one
  // that goes off-screen means the pad cannot reach the page).
  for (const hash of PAGES) {
    await padPage.goto(`${base}/${hash}`);
    await padPage.waitForTimeout(700);
    // A new hash keeps the page: start each screen with nothing chosen, as on arriving there.
    await padPage.evaluate(() => {
      document.activeElement?.blur?.();
      window.dispatchEvent(new Event("gamepadconnected"));
    });
    const seen = new Set();
    let offscreen = "";
    for (let k = 0; k < 4; k++) {
      await press(13);
      const f = await padPage.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        return { id: el.outerHTML.slice(0, 80), visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
      });
      if (f) {
        seen.add(f.id);
        if (!f.visible && !offscreen) offscreen = f.id;
      }
    }
    if (seen.size < 2) problems.push(`pad ${hash}: the D-pad did not move the focus (${[...seen].join(" | ") || "nothing focused"})`);
    if (offscreen) problems.push(`pad ${hash}: the focus went off the screen (${offscreen})`);
  }
  await padPage.close();

  // Speed (docs/DESIGN_RESEARCH.md §5): start to first screen, typing lag in a 200-message chat, and the time to draw
  // one streamed token. Printed every run; generous limits fail the check only on a real slowdown.
  const perf = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  perf.on("pageerror", (e) => problems.push(`speed: page error: ${e.message}`));
  const t0 = Date.now();
  await perf.goto(`${base}/#/`);
  await perf.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, { timeout: 15000 });
  const startMs = Date.now() - t0;
  // A chat with 200 messages (fake: the real chat's answer with made-up events), and the live events in the check's hands.
  await perf.route(`**/api/conversations/${fake.id}`, fakeChat);
  await perf.addInitScript(() => {
    const Real = window.EventSource;
    window.EventSource = function (url, o) {
      if (!String(url).includes("/events?after=")) return new Real(url, o);
      const fake = { onmessage: null, onerror: null, readyState: 1, close() {}, addEventListener() {}, removeEventListener() {} };
      window.__chatES = fake;
      return fake;
    };
  });
  await perf.goto(`${base}/#/c/${fake.id}`);
  await perf.reload(); // a new hash alone does not reload the page, and the stand-in EventSource comes with a load
  await perf.waitForFunction(() => !!window.__chatES, null, { timeout: 15000 }).catch(async (e) => {
    await perf.screenshot({ path: join(out, "speed-chat.png") });
    throw new Error(`the 200-message chat did not open its live events (${e.message.split("\n")[0]})`);
  });
  await perf.waitForTimeout(800);
  await perf.click(".composer textarea");
  await perf.evaluate(() => {
    window.__lags = [];
    document.addEventListener("keydown", () => {
      const t = performance.now();
      requestAnimationFrame(() => window.__lags.push(performance.now() - t));
    }, true);
  });
  await perf.keyboard.type("Typing in a long chat should feel instant.", { delay: 30 });
  const lags = (await perf.evaluate(() => window.__lags)).sort((a, b) => a - b);
  const typingMs = lags.length ? lags[Math.floor(lags.length / 2)] : Infinity;
  const tokenMs = await perf.evaluate(async () => {
    const es = window.__chatES;
    const words = "The answer streams in word by word, with **bold**, `code` and lists, and the page redraws each time.".split(" ");
    // After each token, wait for React's scheduled work (a MessageChannel task, like React's own scheduler), then force layout.
    const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
    const n = 300;
    const t = performance.now();
    for (let i = 0; i < n; i++) {
      es.onmessage({ data: JSON.stringify({ type: "assistant_delta", seq: 0, at: new Date().toISOString(), turn: 999, text: `${words[i % words.length]}${i % 40 === 39 ? "\n\n" : " "}` }) });
      await tick();
      void document.body.offsetHeight;
    }
    return (performance.now() - t) / n;
  });
  const drawn = await perf.evaluate(() => document.querySelector(".msg.streaming")?.textContent?.length ?? 0);
  if (!drawn) problems.push("speed: the streamed answer was not drawn");
  console.log(`Speed: first screen ${startMs} ms · typing ${typingMs.toFixed(1)} ms per key (200 messages) · ${tokenMs.toFixed(2)} ms per streamed token`);
  if (startMs > 3000) problems.push(`speed: the first screen took ${startMs} ms (limit 3000)`);
  if (typingMs > 50) problems.push(`speed: typing lags ${typingMs.toFixed(1)} ms per key in a 200-message chat (limit 50)`);
  if (tokenMs > 8) problems.push(`speed: drawing a streamed token takes ${tokenMs.toFixed(2)} ms (limit 8)`);
  await perf.close();
  await browser.close();
} catch (e) {
  problems.push(`The check could not run: ${e.message}`);
} finally {
  server.kill();
}
if (a11yNotes.length) console.log(`Accessibility notes (not failing):\n${a11yNotes.map((n) => `- ${n}`).join("\n")}`);
if (problems.length) {
  console.error(`Interface check: ${problems.length} problem(s)\n${problems.map((p) => `- ${p}`).join("\n")}\nPictures: ${out}`);
  process.exit(1);
}
console.log(`Interface check passed (pictures in ${out}).`);
process.exit(0);
