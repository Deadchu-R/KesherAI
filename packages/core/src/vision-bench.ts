/**
 * "Test vision models" (Settings): ten fixed tasks on local fixture pages, five web pages and five on a Notepad-like
 * window drawn like Windows 11's Notepad, each with one target element. Every installed vision model is asked to find
 * each target; a task counts as right when the point falls inside the target's box. The result per model: how many
 * were right, the time per task, and the time it took to load (docs/research/browser-computer-control.md, Phase 6).
 *
 * The pages are drawn in KesherAI's own browser pane (routes/vision.ts), so no app is opened and nothing on the
 * computer is clicked; the runner itself takes the drawing as a function, so tests pass a fake.
 */
import type { VisionModel } from "@kesher/shared";
import type { GroundResult, Rect } from "./vision-ground.js";

/** One task: a page with one `#target` element and how a person would describe it. */
export interface BenchTask {
  id: string;
  kind: "web" | "notepad";
  query: string;
  html: string;
}

/** One task's result for one model. */
export interface BenchTaskResult {
  id: string;
  ok: boolean;
  ms: number;
  x?: number;
  y?: number;
  confidence?: number;
  error?: string;
}

/** One model's results. */
export interface BenchModelResult {
  model: string;
  name: string;
  right: number;
  of: number;
  /** The median time per task, ms. */
  medianMs: number;
  /** How long loading the model took, ms. */
  loadMs: number;
  tasks: BenchTaskResult[];
  error?: string;
}

/** One test run. */
export interface BenchRun {
  at: string;
  models: BenchModelResult[];
}

/** A drawn task: the picture and the target's box in its pixels. */
export interface Drawn {
  png: Buffer;
  width: number;
  height: number;
  target: Rect;
}

/** Points this close outside the box still count (anti-aliased edges, a model aiming at the border). */
const SLACK = 4;

const PAGE = (body: string, css = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:15px "Segoe UI",system-ui,sans-serif;color:#1b1b1f;background:#fff}${css}</style></head><body>${body}</body></html>`;

const NOTEPAD_CSS =
  ".np{position:fixed;inset:0;display:flex;flex-direction:column;background:#f3f3f3}.tabs{height:40px;display:flex;align-items:end;gap:4px;padding:0 8px;background:#e9e9e9}" +
  ".tab{height:32px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#fbfbfb;border-radius:8px 8px 0 0;font-size:13px}.x,.plus{border:0;background:none;font-size:14px;width:24px;height:24px;border-radius:4px}" +
  ".menu{height:36px;display:flex;align-items:center;gap:2px;padding:0 6px;background:#fbfbfb;border-bottom:1px solid #e5e5e5}.menu button{border:0;background:none;padding:6px 10px;font-size:13px;border-radius:4px}" +
  ".gear{margin-inline-start:auto;width:32px;height:28px}.text{flex:1;background:#fff;padding:12px 16px;font:15px Consolas,monospace;white-space:pre}" +
  ".status{height:28px;display:flex;align-items:center;font-size:12px;color:#444;background:#f3f3f3;border-top:1px solid #e5e5e5}.status span{padding:0 14px;border-inline-end:1px solid #ddd}";

const GEAR_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`;

/** The Notepad-like window with `#target` on one of its parts. */
function notepad(target: "file" | "edit" | "gear" | "zoom" | "plus"): string {
  const t = (k: typeof target) => (k === target ? ' id="target"' : "");
  return PAGE(
    `<div class="np"><div class="tabs"><div class="tab">Untitled<button class="x" aria-label="Close tab">✕</button></div><button class="plus"${t("plus")} aria-label="New tab">+</button></div>` +
      `<div class="menu"><button${t("file")}>File</button><button${t("edit")}>Edit</button><button>View</button><button class="gear"${t("gear")} aria-label="Settings">${GEAR_SVG}</button></div>` +
      `<div class="text">Shopping list\n- milk\n- bread\n- coffee</div>` +
      `<div class="status"><span>Ln 4, Col 9</span><span>54 characters</span><span${t("zoom")}>100%</span><span>Windows (CRLF)</span><span>UTF-8</span></div></div>`,
    NOTEPAD_CSS,
  );
}

const FORM_CSS = ".card{max-width:520px;margin:60px auto;padding:28px;border:1px solid #ddd;border-radius:12px}label{display:block;margin:12px 0 4px}input[type=text],input[type=email]{width:100%;padding:9px;border:1px solid #bbb;border-radius:6px}.row{display:flex;gap:10px;margin-top:22px}.row button{padding:10px 18px;border-radius:8px;border:0;font-size:15px}";

/** The ten tasks. */
export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: "web-save",
    kind: "web",
    query: "the blue Save button",
    html: PAGE(`<div class="card"><h2>Profile</h2><label>Name</label><input type="text" value="Dana"><label>Email</label><input type="email" value="dana@example.com"><div class="row"><button style="background:#d93025;color:#fff">Delete</button><button style="background:#e0e0e0">Cancel</button><button id="target" style="background:#1a73e8;color:#fff">Save</button></div></div>`, FORM_CSS),
  },
  {
    id: "web-search-icon",
    kind: "web",
    query: "the magnifying glass search icon in the header",
    html: PAGE(`<header style="display:flex;align-items:center;gap:24px;padding:14px 28px;background:#202124;color:#fff"><b style="font-size:20px">Shop</b><a style="color:#ccc">Deals</a><a style="color:#ccc">Help</a><span style="flex:1"></span><button id="target" aria-label="Search" style="background:none;border:0;padding:6px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg></button><button style="background:none;border:0;color:#fff;font-size:20px">🛒</button></header><main style="padding:40px 28px"><h1>Winter sale</h1><p>Up to 40% off coats and boots.</p></main>`),
  },
  {
    id: "web-remember",
    kind: "web",
    query: "the checkbox next to Remember me",
    html: PAGE(`<div class="card"><h2>Sign in</h2><label>Email</label><input type="email"><div style="display:flex;align-items:center;gap:8px;margin-top:16px"><input id="target" type="checkbox" style="width:18px;height:18px;margin:0"><span>Remember me</span></div><div class="row"><button style="background:#1a73e8;color:#fff">Next</button></div><p style="margin-top:18px"><a href="#" style="color:#1a73e8">Forgot email?</a></p></div>`, FORM_CSS),
  },
  {
    id: "web-next-arrow",
    kind: "web",
    query: "the right arrow that shows the next photo",
    html: PAGE(`<div style="position:relative;width:640px;height:360px;margin:50px auto;background:linear-gradient(135deg,#5b8def,#9c6ade);border-radius:12px"><button aria-label="Previous" style="position:absolute;left:12px;top:156px;width:48px;height:48px;border-radius:50%;border:0;background:#fffc;font-size:22px">‹</button><button id="target" aria-label="Next" style="position:absolute;right:12px;top:156px;width:48px;height:48px;border-radius:50%;border:0;background:#fffc;font-size:22px">›</button><div style="position:absolute;bottom:14px;width:100%;text-align:center;color:#fff">2 / 7</div></div>`),
  },
  {
    id: "web-cart-icon",
    kind: "web",
    query: "the shopping cart icon",
    html: PAGE(`<header style="display:flex;align-items:center;gap:20px;padding:16px 28px;border-bottom:1px solid #ddd"><b style="font-size:20px">Books</b><input type="text" placeholder="Search books" style="flex:1;max-width:360px;padding:8px;border:1px solid #bbb;border-radius:6px"><span style="flex:1"></span><button aria-label="Account" style="background:none;border:0;font-size:22px">👤</button><button id="target" aria-label="Cart" style="background:none;border:0;padding:4px"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#222" stroke-width="2"><path d="M3 4h2l2.4 11h11l2-8H6.2"/><circle cx="9" cy="20" r="1.6"/><circle cx="17" cy="20" r="1.6"/></svg></button></header><main style="padding:30px 28px;display:grid;grid-template-columns:repeat(3,160px);gap:24px"><div style="height:220px;background:#eee"></div><div style="height:220px;background:#e4e4e4"></div><div style="height:220px;background:#eee"></div></main>`),
  },
  { id: "notepad-file", kind: "notepad", query: "the File menu", html: notepad("file") },
  { id: "notepad-edit", kind: "notepad", query: "the Edit menu", html: notepad("edit") },
  { id: "notepad-gear", kind: "notepad", query: "the settings gear icon at the top right", html: notepad("gear") },
  { id: "notepad-zoom", kind: "notepad", query: "the zoom level 100% in the status bar", html: notepad("zoom") },
  { id: "notepad-plus", kind: "notepad", query: "the plus button that opens a new tab", html: notepad("plus") },
];

/**
 * Whether a point is in a box (with {@link SLACK} pixels around it).
 *
 * @param x - The point.
 * @param y - The point.
 * @param r - The box.
 */
export function inBox(x: number, y: number, r: Rect): boolean {
  return x >= r[0] - SLACK && y >= r[1] - SLACK && x <= r[0] + r[2] + SLACK && y <= r[1] + r[3] + SLACK;
}

/** @returns The median of numbers (0 for none). */
export function median(list: readonly number[]): number {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** What the runner needs. */
export interface BenchDeps {
  models: readonly VisionModel[];
  /** Loads a model into the vision slot; its time, ms. */
  load: (m: VisionModel) => Promise<number>;
  ground: (m: VisionModel, req: { png: Buffer; width: number; height: number; query: string; signal?: AbortSignal }) => Promise<GroundResult>;
  /** Draws a task's page (once per task; every model sees the same picture). */
  draw: (task: BenchTask) => Promise<Drawn>;
  /** After each task. */
  progress?: (done: number, of: number, model: string) => void;
  signal?: AbortSignal;
  tasks?: readonly BenchTask[];
  now?: () => Date;
}

/**
 * Runs the test: draws each task once, then asks every model for every task.
 *
 * @param d - The models and how to draw, load and ask.
 * @returns The run, ready to save.
 */
export async function runVisionBench(d: BenchDeps): Promise<BenchRun> {
  const tasks = d.tasks ?? BENCH_TASKS;
  const drawn = new Map<string, Drawn | Error>();
  for (const t of tasks) drawn.set(t.id, await d.draw(t).catch((e: Error) => e));
  const of = tasks.length * d.models.length;
  let done = 0;
  const models: BenchModelResult[] = [];
  for (const m of d.models) {
    const out: BenchModelResult = { model: m.id, name: m.name, right: 0, of: tasks.length, medianMs: 0, loadMs: 0, tasks: [] };
    models.push(out);
    try {
      out.loadMs = await d.load(m);
    } catch (e) {
      out.error = (e as Error).message;
      done += tasks.length;
      d.progress?.(done, of, m.id);
      continue;
    }
    for (const t of tasks) {
      if (d.signal?.aborted) throw new Error("Stopped.");
      const pic = drawn.get(t.id)!;
      let r: BenchTaskResult;
      if (pic instanceof Error) r = { id: t.id, ok: false, ms: 0, error: `Could not draw the page: ${pic.message}` };
      else {
        try {
          const g = await d.ground(m, { png: pic.png, width: pic.width, height: pic.height, query: t.query, ...(d.signal ? { signal: d.signal } : {}) });
          r = g.found
            ? { id: t.id, ok: inBox(g.x, g.y, pic.target), ms: g.ms, x: g.x, y: g.y, ...(g.confidence !== undefined ? { confidence: g.confidence } : {}) }
            : { id: t.id, ok: false, ms: g.ms, error: g.why };
        } catch (e) {
          r = { id: t.id, ok: false, ms: 0, error: (e as Error).message };
        }
      }
      out.tasks.push(r);
      d.progress?.(++done, of, m.id);
    }
    out.right = out.tasks.filter((t) => t.ok).length;
    out.medianMs = median(out.tasks.filter((t) => t.ms > 0).map((t) => t.ms));
  }
  return { at: (d.now?.() ?? new Date()).toISOString(), models };
}
