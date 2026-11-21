/**
 * Design-doc scenarios (tools/design/scenarios/*.json): what KesherAI renders into the design doc by itself.
 *
 * One file is one group of boards (for example "Games"). Each board names a page of the real built interface, the
 * sizes to shoot it at (computer 1280, phone 390), the language, the mocked API answers and the steps to take before
 * the shot. design-render.ts turns every board into a PNG and a `.dc.html` board of Claude's design doc.
 *
 * File shape:
 * ```json
 * { "group": "משחקים", "now": "2026-11-20T10:00:00Z",
 *   "mocks": [{ "url": "**\/api/games", "json": { "projects": [] } }],
 *   "boards": [{ "id": "GamesProjects", "title": "משחקים: הפרויקטים", "route": "#/games",
 *                "viewports": ["desktop", "phone"], "height": { "phone": 1000 },
 *                "steps": [{ "wait": ".games-card" }] }] }
 * ```
 * Times in mock data stay the same on every render: `{ "$ago": "40m" }` becomes the ISO time 40 minutes before
 * `now`, `{ "$agoMs": "5m" }` the same time in milliseconds (s, m, h and d work); `$in` and `$inMs` are the same
 * counted forward from `now` (a time still to come).
 */
import { z } from "zod";

/** The two sizes a board is shot at. */
export type DesignViewport = "desktop" | "phone";

/** Width and default height of each size (the design doc's computer and phone frames). */
export const VIEWPORTS: Record<DesignViewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};

/** The clock every render runs at when a file names none, so "40 minutes ago" looks the same each time. */
export const DEFAULT_NOW = "2026-11-20T10:00:00.000Z";

const selector = z.string().min(1).max(300);
const mockSchema = z.object({
  url: z.string().min(1).max(300),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  status: z.number().int().min(100).max(599).optional(),
  json: z.unknown().optional(),
  body: z.string().max(200_000).optional(),
  contentType: z.string().max(100).optional(),
});
const stepSchema = z.union([
  // force: no "is something covering it" check, for a button whose menu opens over it (the phone's sheets).
  z.object({ click: selector, optional: z.boolean().optional(), force: z.boolean().optional() }).strict(),
  z.object({ wait: selector }).strict(),
  z.object({ waitMs: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ fill: selector, value: z.string().max(2000) }).strict(),
  z.object({ hover: selector }).strict(),
  z.object({ scroll: selector }).strict(),
  // Scrolls the element to the top of the window (just under the app bar), so a tall window shows it from its first line.
  z.object({ top: selector }).strict(),
  // Selects the element's text (as a user's drag or the phone's handles would), for boards of a selection's tools.
  z.object({ select: selector }).strict(),
]);
/**
 * What a hub board (`"target": "hub"`) starts from: whether the owner is signed in (and the fields of `/api/state` to
 * change), whether this browser is a paired device, the PCs the hub lists, the tasks the page keeps, and the runs the
 * PCs report (`state` and `events` as in packages/shared/src/hub-protocol.ts; times as `{ "$agoMs": "5m" }`). The
 * missing fields are filled in by design-hub.ts.
 */
const hubSeedSchema = z.object({
  signedIn: z.boolean().default(true),
  owner: z.record(z.string(), z.unknown()).optional(),
  device: z.object({ name: z.string().min(1).max(60) }).optional(),
  pcs: z.array(z.object({ id: z.string().regex(/^[\w-]{1,64}$/), name: z.string().min(1).max(60), online: z.boolean().default(true), kind: z.enum(["pc", "claude-chat"]).default("pc") })).max(8).default([]),
  tasks: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
  agents: z.array(z.object({ pc: z.string(), runId: z.string().regex(/^[\w-]{1,64}$/), state: z.record(z.string(), z.unknown()).default({}), events: z.array(z.record(z.string(), z.unknown())).max(50).default([]) })).max(30).default([]),
  /** The browser is subscribed to Web Push (Settings › Notifications shows its switch on). */
  push: z.boolean().default(false),
}).strict();
/** A hub board's starting state (see {@link hubSeedSchema}). */
export type HubSeed = z.infer<typeof hubSeedSchema>;

const height = z.number().int().min(200).max(6000);
const boardSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,60}$/, "id: letters, digits and '-' (it becomes a file name)"),
  title: z.string().min(1).max(160),
  titleEn: z.string().max(160).optional(),
  // The interface's page (#/games), or for a hub board the hub's tab (#settings) or page (/connect?client_id=…).
  route: z.string().regex(/^(#\/|#[a-z]*$|\/)[^\s]*$/, "route: a page of the interface, like #/games (a hub board: #settings or /connect?…)").max(300),
  target: z.enum(["app", "hub"]).optional(),
  hub: hubSeedSchema.optional(),
  viewports: z.array(z.enum(["desktop", "phone"])).min(1).max(2).default(["desktop", "phone"]),
  locale: z.enum(["he", "en"]).default("he"),
  height: z.union([height, z.object({ desktop: height.optional(), phone: height.optional() })]).optional(),
  fullPage: z.boolean().default(false),
  // One element to shoot alone: a selector, or one per size (a phone's element shot is better left to the whole page).
  shot: z.union([selector, z.object({ desktop: selector.optional(), phone: selector.optional() })]).optional(),
  mocks: z.array(mockSchema).max(80).default([]),
  steps: z.array(stepSchema).max(60).default([]),
  phoneSteps: z.array(stepSchema).max(60).optional(),
});
const fileSchema = z.object({
  group: z.string().min(1).max(80),
  now: z.iso.datetime().optional(),
  target: z.enum(["app", "hub"]).default("app"),
  hub: hubSeedSchema.optional(),
  mocks: z.array(mockSchema).max(80).default([]),
  boards: z.array(boardSchema).min(1).max(60),
});

/** A mocked API answer (Playwright route): the URL glob, and the JSON or raw body to answer with. */
export type DesignMock = z.infer<typeof mockSchema>;
/** One step before the shot: click, wait for, wait a moment, type into, hover, scroll to, scroll to the top or select an element's text. */
export type DesignStep = z.infer<typeof stepSchema>;

/** One board at one size, ready to render. */
export interface DesignJob {
  /** The board's file in the design doc, like `GamesProjectsPhone.dc.html`. */
  name: string;
  /** The board's title on the canvas (Hebrew; the phone one ends with "בטלפון"). */
  title: string;
  /** The group (scenario file) it belongs to. */
  group: string;
  /** Which scenario file it came from (for errors and the Design page). */
  file: string;
  viewport: DesignViewport;
  width: number;
  height: number;
  locale: "he" | "en";
  route: string;
  fullPage: boolean;
  /** An element to shoot alone instead of the window. */
  shot?: string;
  /** Mocks in the order they are matched: the board's own first, then the file's. */
  mocks: DesignMock[];
  steps: DesignStep[];
  /** The fixed clock, ms since 1970. */
  now: number;
  /** `hub`: shot from the hub page's own files (design-hub.ts) instead of the KesherAI interface. */
  target: "app" | "hub";
  /** A hub board's starting state (times already fixed). */
  hub?: HubSeed;
}

/** The element a board shoots alone at this size (`shot` is one selector, or one per size), if any. */
function shotOf(shot: string | { desktop?: string | undefined; phone?: string | undefined } | undefined, viewport: DesignViewport): string | undefined {
  return typeof shot === "string" ? shot : shot?.[viewport];
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Replaces the relative times in mock data (`{ "$ago": "40m" }`, `{ "$agoMs": "5m" }`) with fixed ones.
 * @param value Any JSON value from a scenario file.
 * @param now The render's clock in ms.
 * @returns The same value with every time token replaced (a new object; the input is not changed).
 */
export function resolveTimes(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveTimes(v, now));
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && (keys[0] === "$ago" || keys[0] === "$agoMs" || keys[0] === "$in" || keys[0] === "$inMs") && typeof o[keys[0]] === "string") {
    const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(o[keys[0]] as string);
    if (!m) throw new Error(`time "${String(o[keys[0]])}": use a number and s, m, h or d (like 40m)`);
    const span = Number(m[1]) * UNITS[m[2]!]!;
    const at = keys[0]!.startsWith("$in") ? now + span : now - span;
    return keys[0] === "$ago" || keys[0] === "$in" ? new Date(at).toISOString() : at;
  }
  return Object.fromEntries(keys.map((k) => [k, resolveTimes(o[k], now)]));
}

/**
 * Reads one scenario file into render jobs (one per board and size).
 * @param text The file's JSON text.
 * @param file The file's name, for errors and for the Design page.
 * @returns The jobs, computer first then phone for each board.
 * @throws When the JSON is broken or does not match the shape (the message names the file and the field).
 */
export function parseScenarioFile(text: string, file: string): DesignJob[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${file}: ${issue.path.join(".") || "(file)"}: ${issue.message}`);
  }
  const f = parsed.data;
  const now = Date.parse(f.now ?? DEFAULT_NOW);
  const jobs: DesignJob[] = [];
  for (const b of f.boards) {
    const target = b.target ?? f.target;
    // A route fits its target: the interface's pages are #/…, the hub's are a tab (#settings) or a path (/connect).
    if (target === "app" && !b.route.startsWith("#/")) throw new Error(`${file}: board ${b.id}: route ${b.route} is a hub address; add "target": "hub"`);
    if (target === "hub" && b.route.startsWith("#/")) throw new Error(`${file}: board ${b.id}: a hub board's route is a tab like #settings or a path like /connect`);
    for (const viewport of b.viewports) {
      const phone = viewport === "phone";
      const h = typeof b.height === "number" ? b.height : b.height?.[viewport];
      jobs.push({
        name: `${b.id}${phone ? "Phone" : ""}.dc.html`,
        title: phone ? `${b.title} · בטלפון` : b.title,
        group: f.group,
        file,
        viewport,
        width: VIEWPORTS[viewport].width,
        height: h ?? VIEWPORTS[viewport].height,
        locale: b.locale,
        route: b.route,
        fullPage: b.fullPage,
        ...(shotOf(b.shot, viewport) ? { shot: shotOf(b.shot, viewport)! } : {}),
        mocks: [...b.mocks, ...f.mocks].map((m) => (m.json === undefined ? m : { ...m, json: resolveTimes(m.json, now) })),
        steps: (phone && b.phoneSteps) || b.steps,
        now,
        target,
        ...(target === "hub" ? { hub: hubSeedSchema.parse(resolveTimes(b.hub ?? f.hub ?? {}, now)) } : {}),
      });
    }
  }
  return jobs;
}

/**
 * Reads several scenario files and checks that no board name is used twice.
 * @param files The files as `{ name, text }`, in the order to render.
 * @returns Every job, and an error line per file that could not be read (the others still render).
 */
export function parseScenarios(files: Array<{ name: string; text: string }>): { jobs: DesignJob[]; errors: string[] } {
  const jobs: DesignJob[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    try {
      for (const j of parseScenarioFile(f.text, f.name)) {
        const other = seen.get(j.name);
        if (other) throw new Error(`${f.name}: board ${j.name} is already in ${other}`);
        seen.set(j.name, f.name);
        jobs.push(j);
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { jobs, errors };
}
