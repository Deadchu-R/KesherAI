/**
 * KesherAI renders the design doc itself (docs/HANDOFF.md "The design doc"): every scenario in
 * tools/design/scenarios/ is shot from the real built interface with mocked API answers, and the boards land in a
 * design-out folder in the layout Claude publishes to the design-doc artifact:
 *
 * ```
 * tools/design/out/kesher/
 *   project/canvas.json        the doc's canvas (Claude copies the live one in; renders update it)
 *   project/<Board>.dc.html    boards that changed since Claude last published
 *   shots/<Board>.png          every board's latest picture (the Design page shows these)
 *   publish.json               [{ as, path }] for Claude's publish_files: the changed boards + canvas.json
 *   BASE_VERSION               the artifact version canvas.json came from (written by Claude, only read here)
 *   state.json, notes.json, last.json   hashes for change detection, Roee's notes, the last render's result
 * ```
 * KesherAI never needs Claude's credentials: it only writes files; Claude reads publish.json and publishes.
 *
 * Rendering needs the source folder with a build (`pnpm build`) and Playwright (a dev dependency of the repo); a
 * fresh KesherAI server with an empty data folder answers what the scenario does not mock, so no real chats,
 * paths or names can show up in a board.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyBoardNotes, BOARD_WIDTH, boardHtml, diffRenders, mergeCanvas, readCanvas, type RenderDiff, type RenderedBoard } from "./design-canvas.js";
import { shotsDiffer } from "./design-png.js";
import { parseScenarios, type DesignJob, type DesignStep } from "./design-scenarios.js";

/** Where scenarios live in the repo, and the design-out folder under it. */
export const SCENARIO_DIR = "tools/design/scenarios";
export const OUT_DIR = "tools/design/out/kesher";

/** A board as the Design page lists it. */
export interface DesignBoardInfo extends RenderedBoard {
  name: string;
  /** Marked "newest" (new or changed since Claude last published). */
  newest: boolean;
  note: string;
}

/** The last render's result. */
export interface DesignRenderResult {
  at: string;
  ms: number;
  diff: RenderDiff;
  errors: string[];
}

interface State {
  boards: Record<string, RenderedBoard>;
  /** Boards new or changed since Claude last published (they carry the newest note and go in publish.json). */
  pending: string[];
  /** BASE_VERSION when `pending` started; a different one means Claude published, so pending starts over. */
  base: string;
}

/**
 * The KesherAI repo that has scenarios: the task inbox's repo when it has them, else the source folder this server
 * runs from (development and headless installs).
 * @param candidates Folders to try first (from settings).
 * @returns The folder, or undefined when none has tools/design/scenarios.
 */
export function findDesignRepo(candidates: Array<string | undefined>): string | undefined {
  const here = resolve(import.meta.dirname, "../../..");
  return [...candidates, here].find((d): d is string => !!d && existsSync(join(d, SCENARIO_DIR)));
}

/** The width and height of a PNG, from its header. */
function pngSize(png: Buffer): { w: number; h: number } {
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** The render's own server port: always the same when free, since the sidebar shows it in every board. */
const RENDER_PORT = 7466;

/** A free local port for the render's own server ({@link RENDER_PORT} when it is free). */
function freePort(port = RENDER_PORT): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", () => (port ? freePort(0).then(ok, fail) : fail(new Error("no port"))));
    s.listen(port, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? ok(a.port) : fail(new Error("no port"))));
    });
  });
}

const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};
/** Writes through a temp file so a reader never sees half a file. */
async function writeAtomic(file: string, text: string | Buffer): Promise<void> {
  await writeFile(file + ".tmp", text);
  await rename(file + ".tmp", file);
}

/** Minimal shape of the Playwright API the renderer uses (it is loaded from the repo at run time). */
interface PwPage {
  clock: { setFixedTime(t: number): Promise<void> };
  route(url: string, h: (r: PwRoute) => Promise<void>): Promise<void>;
  addInitScript(fn: (a: { locale: string; phone: boolean }) => void, arg: { locale: string; phone: boolean }): Promise<void>;
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(sel: string): { first(): PwLocator };
  screenshot(o: Record<string, unknown>): Promise<Buffer>;
}
interface PwLocator {
  click(o?: { timeout?: number; force?: boolean }): Promise<void>;
  waitFor(o?: { timeout?: number }): Promise<void>;
  fill(v: string, o?: { timeout?: number }): Promise<void>;
  hover(o?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(o?: { timeout?: number }): Promise<void>;
  evaluate(fn: (el: Element) => void): Promise<void>;
  screenshot(o: Record<string, unknown>): Promise<Buffer>;
}
interface PwRoute {
  request(): { method(): string };
  fulfill(o: Record<string, unknown>): Promise<void>;
  fallback(): Promise<void>;
  fetch(): Promise<{ json(): Promise<unknown> }>;
}
interface PwBrowser {
  newContext(o: Record<string, unknown>): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>;
  close(): Promise<void>;
}

/** Runs one step before the shot. */
async function runStep(page: PwPage, s: DesignStep): Promise<void> {
  const T = { timeout: 15_000 };
  if ("click" in s) await page.locator(s.click).first().click({ ...(s.optional ? { timeout: 2500 } : T), ...(s.force ? { force: true } : {}) }).catch((e: unknown) => { if (!s.optional) throw e; });
  else if ("wait" in s) await page.locator(s.wait).first().waitFor(T);
  else if ("waitMs" in s) await page.waitForTimeout(s.waitMs);
  else if ("fill" in s) await page.locator(s.fill).first().fill(s.value, T);
  else if ("hover" in s) await page.locator(s.hover).first().hover(T);
  else if ("scroll" in s) await page.locator(s.scroll).first().scrollIntoViewIfNeeded(T);
  else if ("select" in s) {
    const el = page.locator(s.select).first();
    await el.waitFor(T);
    // Select its text, then the mouse up the page listens for (the phone follows selectionchange by itself).
    await el.evaluate((node) => {
      const r = document.createRange();
      r.selectNodeContents(node);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  }
}

/** Shoots one job; returns the PNG. */
async function shoot(browser: PwBrowser, base: string, job: DesignJob): Promise<Buffer> {
  const phone = job.viewport === "phone";
  const ctx = await browser.newContext({ viewport: { width: job.width, height: job.height }, locale: job.locale === "he" ? "he-IL" : "en-US", ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
  try {
    const page = await ctx.newPage();
    await page.clock.setFixedTime(job.now);
    // The version under the sidebar would mark every board changed after each release: only major.minor shows.
    await page.route("**/api/version", async (r) => {
      const v = (await (await r.fetch()).json()) as { version?: string };
      await r.fulfill({ json: { ...v, version: String(v.version ?? "").split(".").slice(0, 2).join("."), commit: undefined } });
    });
    // Playwright tries the route added last first: the file's mocks go in first so a board's own win.
    for (const m of [...job.mocks].reverse()) {
      await page.route(m.url, async (r) => {
        if (m.method && r.request().method() !== m.method) return r.fallback();
        await r.fulfill({ status: m.status ?? 200, ...(m.json !== undefined ? { json: m.json } : { body: m.body ?? "", contentType: m.contentType ?? "text/plain" }) });
      });
    }
    // The phone talks to the PC through a pairing token (remote), as the real phone app does.
    await page.addInitScript((a) => {
      try {
        localStorage.setItem("locale", a.locale);
        if (a.phone) localStorage.setItem("kesher-token", "design-render");
      } catch { /* storage blocked: the page still renders */ }
    }, { locale: job.locale, phone });
    await page.goto(`${base}/${job.route}`, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1200);
    for (const s of job.steps) await runStep(page, s);
    await page.waitForTimeout(400);
    const o = { animations: "disabled", caret: "hide", type: "png" };
    const take = () => (job.shot ? page.locator(job.shot).first().screenshot(o) : page.screenshot({ ...o, fullPage: job.fullPage }));
    // Wait for a still picture (two shots in a row the same), so a transition still running does not count as a change.
    let png = await take();
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(350);
      const next = await take();
      if (next.equals(png)) break;
      png = next;
    }
    return png;
  } finally {
    await ctx.close();
  }
}

/** Options for {@link renderDesign}. */
export interface RenderOptions {
  /** The KesherAI source folder (with tools/design/scenarios and a build). */
  repo: string;
  /** The design-out folder (default tools/design/out/kesher in the repo). */
  out?: string;
  /** Render only these board ids or names (the rest keep their last picture). */
  only?: string[];
  /** Progress lines. */
  log?: (line: string) => void;
}

/**
 * Renders every scenario to PNG and `.dc.html` boards, updates canvas.json and publish.json, and marks the boards
 * that are new or changed since Claude last published as "newest".
 * @param o The repo, the out folder, which boards, and where progress goes.
 * @returns What changed and the errors (a failing board keeps its last picture; the others still render).
 * @throws When there are no scenarios, no build or no Playwright in the repo.
 */
export async function renderDesign(o: RenderOptions): Promise<DesignRenderResult> {
  const started = Date.now();
  const log = o.log ?? (() => undefined);
  const out = o.out ?? join(o.repo, OUT_DIR);
  const sdir = join(o.repo, SCENARIO_DIR);
  const names = (await readdir(sdir)).filter((f) => f.endsWith(".json")).sort();
  const files = await Promise.all(names.map(async (name) => ({ name, text: await readFile(join(sdir, name), "utf8") })));
  const parsed = parseScenarios(files);
  const errors = [...parsed.errors];
  const only = o.only?.map((n) => n.replace(/\.dc\.html$/, ""));
  const jobs = only ? parsed.jobs.filter((j) => only.includes(j.name.replace(/\.dc\.html$/, "")) || only.includes(j.name.replace(/(Phone)?\.dc\.html$/, ""))) : parsed.jobs;
  if (!jobs.length) throw new Error(errors[0] ?? "No scenarios to render (tools/design/scenarios/*.json).");

  const main = join(o.repo, "packages/core/dist/main.js");
  const web = join(o.repo, "apps/web/dist");
  if (!existsSync(main) || !existsSync(join(web, "index.html"))) throw new Error("Build KesherAI in this folder first (pnpm build): the render shoots the built interface.");
  let pw: { chromium: { launch(o?: Record<string, unknown>): Promise<PwBrowser> } };
  try {
    pw = createRequire(join(o.repo, "package.json"))("playwright") as typeof pw;
  } catch {
    throw new Error("Playwright is not installed in this folder (pnpm install).");
  }

  for (const d of ["project", "shots"]) await mkdir(join(out, d), { recursive: true });
  const data = await mkdtemp(join(tmpdir(), "kesher-design-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A fresh server with an empty data folder: what is not mocked comes back empty, never from the real install.
  const server = spawn(process.execPath, [main, "--port", String(port), "--data-dir", data, "--no-autodetect", "--web", web], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
  const shots: Record<string, { png: Buffer; job: DesignJob }> = {};
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(base + "/api/health").then((r) => r.ok, () => false);
    }
    if (!up) throw new Error("The render's own KesherAI server did not start.");
    // Past the welcome, with every part shown.
    await fetch(base + "/api/onboarding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true, simple: false }) });
    const browser = await pw.chromium.launch();
    try {
      for (const job of jobs) {
        log(`${job.name} (${job.viewport})`);
        try {
          shots[job.name] = { png: await shoot(browser, base, job), job };
        } catch (e) {
          errors.push(`${job.name}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
    await rm(data, { recursive: true, force: true }).catch(() => undefined);
  }

  // Change detection against the last render.
  const state = await readJson<State>(join(out, "state.json"), { boards: {}, pending: [], base: "" });
  const baseNow = (await readFile(join(out, "BASE_VERSION"), "utf8").catch(() => "")).trim();
  if (baseNow !== state.base) state.pending = [];
  state.base = baseNow;
  const now: Record<string, RenderedBoard> = {};
  const at = new Date().toISOString();
  for (const [name, { png, job }] of Object.entries(shots)) {
    const size = pngSize(png);
    const w = BOARD_WIDTH[job.viewport];
    now[name] = { title: job.title, group: job.group, viewport: job.viewport, w, h: Math.round((size.h * w) / size.w), hash: createHash("sha256").update(png).digest("hex"), changedAt: at };
  }
  // Chromium draws a few pixels a little differently each time: a picture that looks the same keeps its old hash.
  for (const [name, b] of Object.entries(now)) {
    const old = state.boards[name];
    if (!old || old.hash === b.hash) continue;
    const prev = await readFile(join(out, "shots", name.replace(/\.dc\.html$/, ".png"))).catch(() => undefined);
    if (prev && !shotsDiffer(prev, shots[name]!.png)) b.hash = old.hash;
  }
  const diff = diffRenders(state.boards, now);
  // Boards not rendered this time (only, or failed) are neither removed nor changed.
  diff.removed = only ? [] : diff.removed.filter((n) => !jobs.some((j) => j.name === n));
  for (const name of [...diff.added, ...diff.changed]) {
    const { png, job } = shots[name]!;
    const b = now[name]!;
    await writeAtomic(join(out, "shots", name.replace(/\.dc\.html$/, ".png")), png);
    await writeAtomic(join(out, "project", name), boardHtml(b.title, b.w, b.h, png.toString("base64"), job.locale));
    if (!state.pending.includes(name)) state.pending.push(name);
  }
  for (const name of diff.same) now[name] = { ...now[name]!, changedAt: state.boards[name]!.changedAt };
  for (const name of diff.removed) state.pending = state.pending.filter((n) => n !== name);
  state.boards = { ...Object.fromEntries(Object.entries(state.boards).filter(([n]) => !diff.removed.includes(n))), ...now };

  // The canvas: new boards placed, the newest notes on everything Claude has not published yet.
  const notes = await readJson<Record<string, string>>(join(out, "notes.json"), {});
  const canvas = readCanvas(await readFile(join(out, "project/canvas.json"), "utf8").catch(() => ""));
  const order = jobs.map((j) => j.name).filter((n) => now[n]);
  // A render with no change leaves the newest notes where they are.
  const marks = diff.added.length + diff.changed.length ? state.pending : [];
  const boards = order.map((n) => ({ name: n, title: now[n]!.title, group: now[n]!.group, w: now[n]!.w, h: now[n]!.h }));
  const merged = mergeCanvas(canvas, boards, { added: marks.filter((n) => !canvas.boards[n]), changed: marks.filter((n) => canvas.boards[n]) }, notes);
  await writeAtomic(join(out, "project/canvas.json"), JSON.stringify(merged, null, 1));
  await writeAtomic(join(out, "state.json"), JSON.stringify(state, null, 1));
  await writePublishList(out, state.pending);
  const result: DesignRenderResult = { at, ms: Date.now() - started, diff, errors };
  await writeAtomic(join(out, "last.json"), JSON.stringify(result, null, 1));
  log(`done: ${diff.added.length} new, ${diff.changed.length} changed, ${errors.length} errors`);
  return result;
}

/** publish.json: the boards waiting to be published and canvas.json, as Claude's publish_files takes them. */
async function writePublishList(out: string, pending: string[]): Promise<void> {
  const list = [...pending.filter((n) => existsSync(join(out, "project", n))), "canvas.json"].map((n) => ({ as: `project/${n}`, path: resolve(out, "project", n) }));
  await writeAtomic(join(out, "publish.json"), JSON.stringify(list, null, 1));
}

/** A board file name the Design page may ask for (never a path). */
export const BOARD_NAME = /^[A-Za-z][A-Za-z0-9-]{0,70}\.dc\.html$/;

/**
 * Reads the design-out folder for the Design page.
 * @param out The design-out folder.
 * @returns The boards (newest first), the last render and the artifact version canvas.json came from.
 */
export async function readDesignOut(out: string): Promise<{ boards: DesignBoardInfo[]; last?: DesignRenderResult; baseVersion: string }> {
  const state = await readJson<State>(join(out, "state.json"), { boards: {}, pending: [], base: "" });
  const notes = await readJson<Record<string, string>>(join(out, "notes.json"), {});
  const last = await readJson<DesignRenderResult | undefined>(join(out, "last.json"), undefined);
  const baseVersion = (await readFile(join(out, "BASE_VERSION"), "utf8").catch(() => "")).trim();
  const published = baseVersion !== state.base;
  const boards = Object.entries(state.boards)
    .map(([name, b]) => ({ ...b, name, newest: !published && state.pending.includes(name), note: notes[name] ?? "" }))
    .sort((a, b) => Number(b.newest) - Number(a.newest) || b.changedAt.localeCompare(a.changedAt) || a.name.localeCompare(b.name));
  return { boards, ...(last ? { last } : {}), baseVersion };
}

/**
 * Saves Roee's note on a board and puts it on the canvas beside the board (canvas.json goes in publish.json).
 * @param out The design-out folder.
 * @param name The board's file name.
 * @param text The note; empty removes it.
 */
export async function setBoardNote(out: string, name: string, text: string): Promise<void> {
  if (!BOARD_NAME.test(name)) throw new Error("bad board name");
  await mkdir(join(out, "project"), { recursive: true });
  const notes = await readJson<Record<string, string>>(join(out, "notes.json"), {});
  if (text.trim()) notes[name] = text.trim().slice(0, 2000);
  else delete notes[name];
  await writeAtomic(join(out, "notes.json"), JSON.stringify(notes, null, 1));
  const file = join(out, "project/canvas.json");
  const canvas = readCanvas(await readFile(file, "utf8").catch(() => ""));
  await writeAtomic(file, JSON.stringify(applyBoardNotes(canvas, { [name]: text }), null, 1));
  const state = await readJson<State>(join(out, "state.json"), { boards: {}, pending: [], base: "" });
  await writePublishList(out, state.pending);
}
