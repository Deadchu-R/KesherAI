// Takes screenshots and short videos of the KesherAI UI for the project page (roeetal.com/KesherAI).
// Run by .github/workflows/site-media.yml on the "site-media" branch, against `pnpm dev` (core :7420 + UI :5173).
import { chromium, devices } from "playwright";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
const LANG = process.env.KLANG || "en";   // the app's UI language (localStorage "locale")
const OUT = "site-media/" + LANG; mkdirSync(OUT + "/shots", { recursive: true }); mkdirSync(OUT + "/video", { recursive: true });
const BASE = "http://localhost:5173/";
const PAGES = [["home", "#/"], ["models", "#/models"], ["images", "#/images"], ["connections", "#/connections"], ["nodes", "#/nodes"], ["personas", "#/personas"],
  ["plugins", "#/plugins"], ["knowledge", "#/knowledge"], ["prompts", "#/prompts"], ["compare", "#/compare"], ["pipelines", "#/pipelines"], ["unreal", "#/unreal"],
  ["usage", "#/usage"], ["updates", "#/updates"], ["settings", "#/settings"], ["community", "#/community"], ["day", "#/day"], ["watch", "#/watch"]];
const settle = async p => { await p.waitForLoadState("domcontentloaded").catch(() => {}); await p.waitForTimeout(2200); };   // (the app polls, so "network idle" never comes)
const closeDialogs = async p => { for (let i = 0; i < 3; i++) { const b = p.locator('button:has-text("Skip"), button:has-text("Not now"), button:has-text("Later"), button:has-text("Close"), [aria-label="Close"]').first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); else break; await p.waitForTimeout(300); } };
const b0 = await chromium.launch();
// every context starts with the chosen UI language
const b = { newContext: async o => { const c = await b0.newContext(o); await c.addInitScript(l => { try { localStorage.setItem("locale", l); } catch (e) {} }, LANG); return c; }, close: () => b0.close() };
// desktop screenshots
{ const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "dark" }); const p = await ctx.newPage();
  await p.goto(BASE); await settle(p); await closeDialogs(p);
  for (const [n, h] of PAGES) { await p.goto(BASE + h); await settle(p); await closeDialogs(p); await p.screenshot({ path: `${OUT}/shots/${n}.png` }); console.log("shot", n); }
  await ctx.close(); }
// phone screenshots
{ const ctx = await b.newContext({ ...devices["Pixel 7"], colorScheme: "dark" }); const p = await ctx.newPage();
  for (const [n, h] of PAGES.slice(0, 6)) { await p.goto(BASE + h); await settle(p); await closeDialogs(p); await p.screenshot({ path: `${OUT}/shots/phone-${n}.png` }); }
  await ctx.close(); }
// videos: a tour of the desktop app, and the phone
async function tour(name, opts, pages) {
  const ctx = await b.newContext({ ...opts, colorScheme: "dark", recordVideo: { dir: OUT + "/video/tmp-" + name, size: opts.viewport } }); const p = await ctx.newPage();
  await p.goto(BASE); await settle(p); await closeDialogs(p);
  for (const h of pages) { await p.goto(BASE + h); await settle(p); await closeDialogs(p); await p.mouse.wheel(0, 500); await p.waitForTimeout(900); await p.mouse.wheel(0, -500); await p.waitForTimeout(700); }
  await ctx.close();
  const d = OUT + "/video/tmp-" + name, f = readdirSync(d)[0]; renameSync(`${d}/${f}`, `${OUT}/video/${name}.webm`);
}
await tour("desktop-tour", { viewport: { width: 1280, height: 800 } }, ["#/", "#/models", "#/images", "#/nodes", "#/connections", "#/personas", "#/plugins", "#/settings"]);
await tour("phone-tour", { ...devices["Pixel 7"], viewport: { width: 412, height: 860 } }, ["#/", "#/models", "#/images", "#/settings"]);
await b.close();
