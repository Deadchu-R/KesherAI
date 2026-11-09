// The interface check that runs on every version: the real server starts empty,
// a browser opens every main screen at computer width (1280) and phone width
// (390, as the remote app), and the check fails on a page error or a page wider
// than the screen. A picture of every screen is saved, to look at when it fails.
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

/** The screens to open (hash routes); a chat is made by the check itself. */
const PAGES = ["#/", "#/code", "#/unity", "#/unreal", "#/models", "#/personas", "#/knowledge", "#/pages", "#/images", "#/connections", "#/updates", "#/apps", "#/nodes", "#/pipelines", "#/watch", "#/settings"];

const load = async () => {
  if (process.env.PLAYWRIGHT_MODULE) return (await import(process.env.PLAYWRIGHT_MODULE)).default;
  return createRequire(join(root, "package.json"))("playwright");
};

const pw = await load();
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
  const chat = await (await fetch(`${base}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "chat" }) })).json();
  const pages = [...PAGES, `#/c/${chat.id}`];
  const browser = await pw.chromium.launch();
  for (const [w, h, name] of [[1280, 800, "computer"], [390, 844, "phone"]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
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
      if (measured.wide > 2) problems.push(`${name} ${p}: the page is ${measured.wide}px wider than the screen (it scrolls sideways)`);
      if (measured.bad.length) problems.push(`${name} ${p}: past the screen's edge: ${measured.bad.join(", ")}`);
      const file = `${name}-${p.replace(/^#\//, "").replace(/[^\w-]+/g, "_") || "home"}.png`;
      await page.screenshot({ path: join(out, file) });
    }
    await page.close();
  }
  await browser.close();
} catch (e) {
  problems.push(`The check could not run: ${e.message}`);
} finally {
  server.kill();
}
if (problems.length) {
  console.error(`Interface check: ${problems.length} problem(s)\n${problems.map((p) => `- ${p}`).join("\n")}\nPictures: ${out}`);
  process.exit(1);
}
console.log(`Interface check passed (pictures in ${out}).`);
process.exit(0);
