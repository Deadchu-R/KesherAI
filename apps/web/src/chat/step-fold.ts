/**
 * Pure helpers for the fold of a turn's steps ("▸ What the model did · 12 steps · 1:42") and for the screenshots
 * between them: the header text, the clock, and where a step's action (click, typing, scroll) is drawn on a
 * screenshot. No React and no i18n imports, so they run in `node:test`; callers pass `he` (true for Hebrew).
 */

/** "1:42", "0:07", "1:02:03". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What the fold's header needs. */
export interface FoldInfo {
  /** How many steps (calls) the turn has. */
  steps: number;
  /** Milliseconds from the first call to the last result (or now, while it runs); undefined when unknown. */
  ms?: number | undefined;
  /** True while the turn still works. */
  running: boolean;
  /** The step in progress, as a short sentence ("click 'Save'"), while running. */
  current?: string | undefined;
  /** What the steps mostly used (see {@link foldKind}); names the done line ("Used the browser"). */
  kind?: FoldKind | undefined;
  /** How many screenshots the steps took; counted on the done line when there are any. */
  shots?: number | undefined;
}

/** What a run of steps mostly used: one family when it makes at least half the steps, else "mixed". */
export type FoldKind = "browser" | "computer" | "files" | "commands" | "mixed";

const FAMILY: [Exclude<FoldKind, "mixed">, RegExp][] = [
  ["browser", /^browser_/],
  ["computer", /^computer_/],
  ["files", /^(read_file|list_files|search|write_file|edit_file|read_document)$/],
  ["commands", /^(run_command|build_executable|install_tool|check_tools)$/],
];

/**
 * What a turn's steps mostly used, to name its done line: the family (browser, computer, files, commands) that makes
 * at least half of the steps, or "mixed".
 *
 * @param names - The steps' tool names, in order.
 */
export function foldKind(names: string[]): FoldKind {
  if (!names.length) return "mixed";
  let best: FoldKind = "mixed";
  let most = 0;
  for (const [kind, re] of FAMILY) {
    const n = names.filter((x) => re.test(x)).length;
    if (n > most) [best, most] = [kind, n];
  }
  return most * 2 >= names.length ? best : "mixed";
}

const LEAD: Record<FoldKind, [he: string, en: string]> = {
  browser: ["השתמש בדפדפן", "Used the browser"],
  computer: ["השתמש במחשב", "Used the computer"],
  files: ["עבד עם קבצים", "Worked with files"],
  commands: ["הריץ פקודות", "Ran commands"],
  mixed: ["מה המודל עשה", "What the model did"],
};

/**
 * The header line of a turn's fold: "Used the browser · 6 steps · 3 screenshots · 1:42" ("What the model did · …"
 * for mixed work), or while it works
 * "Working… step 5: click 'Save'".
 *
 * @param f - The steps' count, time and current step.
 * @param he - True for Hebrew.
 */
export function foldHeader(f: FoldInfo, he: boolean): string {
  if (f.running) {
    const head = he ? `עובד… צעד ${f.steps}` : `Working… step ${f.steps}`;
    return f.current ? `${head}: ${f.current}` : head;
  }
  const n = he ? (f.steps === 1 ? "צעד אחד" : `${f.steps} צעדים`) : `${f.steps} ${f.steps === 1 ? "step" : "steps"}`;
  const s = f.shots ?? 0;
  const shots = !s ? [] : [he ? (s === 1 ? "צילום מסך אחד" : `${s} צילומי מסך`) : `${s} ${s === 1 ? "screenshot" : "screenshots"}`];
  const lead = LEAD[f.kind ?? "mixed"];
  return [he ? lead[0] : lead[1], n, ...shots, ...(f.ms !== undefined ? [formatClock(f.ms)] : [])].join(" · ");
}

/** The time a run of steps took: from the first call to the last result, or to `now` while one has no result. */
export function turnDuration(steps: Array<{ call: { at?: string }; result?: { at?: string } | undefined }>, now: number): number | undefined {
  const first = steps[0]?.call.at ? Date.parse(steps[0].call.at) : NaN;
  if (!Number.isFinite(first)) return undefined;
  const open = steps.some((s) => !s.result);
  const ends = steps.map((s) => (s.result?.at ? Date.parse(s.result.at) : NaN)).filter(Number.isFinite);
  const end = open ? now : ends.length ? Math.max(...ends) : NaN;
  return Number.isFinite(end) ? Math.max(0, end - first) : undefined;
}

/** What a step did on the screen: a click, typing or a scroll, in the screenshot's pixels. */
export interface StepAction {
  kind: "click" | "type" | "scroll";
  x?: number;
  y?: number;
  /** The typed text (cut). */
  text?: string;
  /** Scroll direction. */
  dir?: "up" | "down" | "left" | "right";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The action a computer or browser call did, to draw on the screenshot it acted on.
 *
 * @param name - The tool's name.
 * @param input - The call's arguments.
 * @returns The action, or undefined for a call that does nothing visible (a screenshot, a read).
 */
export function stepAction(name: string, input: Record<string, unknown>): StepAction | undefined {
  const x = num(input.x);
  const y = num(input.y);
  const at = { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
  if (/^(computer_(click|double_click|right_click|move)|browser_click_at)$/.test(name) && x !== undefined && y !== undefined) return { kind: "click", ...at };
  if (/^(computer_type|browser_type)$/.test(name) && typeof input.text === "string") return { kind: "type", ...at, text: input.text.length > 40 ? `${input.text.slice(0, 39)}…` : input.text };
  if (/^(computer_scroll|browser_scroll)$/.test(name)) {
    const amount = num(input.amount);
    const dir = typeof input.direction === "string" && /^(up|down|left|right)$/.test(input.direction) ? (input.direction as StepAction["dir"]) : amount !== undefined ? (amount < 0 ? "up" : "down") : "down";
    return { kind: "scroll", ...at, dir };
  }
  return undefined;
}

/** A picture's size. */
export interface Frame { w: number; h: number }

/**
 * The size of the screen a computer screenshot step described ("Screenshot 1280×720. In front: …").
 *
 * @param output - The screenshot tool's text.
 */
export function shotFrame(output: string): Frame | undefined {
  const m = /Screenshot (\d{2,5})\s*[×x]\s*(\d{2,5})/.exec(output);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

/**
 * Where a point of the screenshot's own pixels lies on the shown picture, as percents of its width and height (so
 * it holds at any display size: the 240 px thumbnail and the big lightbox use the same numbers). Points outside
 * the picture are held at its edge.
 *
 * @param p - The point, in `from` pixels.
 * @param from - The pixel size the point is in (what the model saw).
 */
export function overlayPercent(p: { x: number; y: number }, from: Frame): { left: number; top: number } {
  const c = (v: number) => Math.min(100, Math.max(0, v));
  return { left: c((p.x / from.w) * 100), top: c((p.y / from.h) * 100) };
}

/** A step of a group, as far as the screenshot pairing reads it. */
interface PairStep { call: { callId: string; name: string; input: Record<string, unknown> }; result?: { output: string; assetIds?: string[] | undefined } | undefined }

/** The screenshot an action step acted on, and what size its pixels were. */
export interface ActedOn { assetId: string; frame?: Frame; action: StepAction }

/**
 * For each step with an on-screen action, the latest earlier screenshot of the same turn (what the model looked at
 * when it chose the point).
 *
 * @param steps - The turn's steps, in order.
 * @returns Per call id.
 */
export function actedOnShots(steps: PairStep[]): Map<string, ActedOn> {
  const out = new Map<string, ActedOn>();
  let last: { assetId: string; frame?: Frame } | undefined;
  for (const s of steps) {
    const action = stepAction(s.call.name, s.call.input ?? {});
    if (action && last) out.set(s.call.callId, { ...last, action });
    const id = s.result?.assetIds?.[0];
    if (id && /^(computer_|browser_)|screenshot/.test(s.call.name) && !action) {
      const frame = shotFrame(s.result?.output ?? "");
      last = { assetId: id, ...(frame ? { frame } : {}) };
    }
  }
  return out;
}

/** The last line of a command's output that says something (not the "Exit code 0." status line). */
function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(Exit code \S+\.|\(no output\))$/.test(l));
  return lines.at(-1) ?? "";
}

const cutTo = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A host name from a link, without "www."; undefined when it is not a link. */
function hostName(url: string): string | undefined {
  try {
    const h = new URL(url).hostname;
    return h ? h.replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page a browser step ended on, read from its result (the bridge writes the title and then the URL as the first
 * two lines inside the `<untrusted-page>` block). The title is page content: callers show it as text only.
 *
 * @param output - The browser tool's result text.
 * @returns The page's title (may be empty) and host, or undefined when the result names no page.
 */
export function pageOf(output: string): { title: string; host: string } | undefined {
  const m = /<untrusted-page[^>]*>\n(?:\(Content of[^\n]*\)\n)?([^\n]*)\n([^\n]*)/.exec(output);
  const host = m ? hostName(m[2]!.trim()) : undefined;
  return m && host ? { title: m[1]!.trim(), host } : undefined;
}

/** A tool result as far as {@link stepPreview} reads it. */
export interface PreviewResult { ok: boolean; output: string; diff?: string | undefined }

/**
 * One short line under a finished step, like Claude's step rows: the page's title and domain for a browser step,
 * the window in front for a computer step, the command's last line or its exit code, "+N −M" for a file change.
 * The line is cut, not masked: the caller masks secrets (`maskSecrets`) before showing it.
 *
 * @param name - The tool's name.
 * @param result - The step's result; nothing is shown before it comes or when it failed (the error line shows then).
 * @param max - The longest line, in characters.
 * @returns The line, or "" when the step has nothing worth a preview.
 */
export function stepPreview(name: string, result: PreviewResult | undefined, max = 90): string {
  if (!result?.ok) return "";
  const out = result.output ?? "";
  if (/^browser_/.test(name)) {
    const page = pageOf(out);
    return page ? cutTo(page.title ? `${page.title} · ${page.host}` : page.host, max) : "";
  }
  if (/^computer_/.test(name)) {
    const m = /In front: (.+?) "(.*)"/.exec(out);
    return m ? cutTo(m[2] ? `${m[1]} · ${m[2]}` : m[1]!, max) : "";
  }
  if (name === "run_command") {
    const code = /Exit code (\S+?)\.\s*$/.exec(out)?.[1];
    const tail = lastLine(out);
    const exit = code && code !== "0" ? `exit ${code}` : "";
    return cutTo([tail, exit].filter(Boolean).join(" · "), max);
  }
  if (/^(write_file|edit_file)$/.test(name) && result.diff) {
    let add = 0;
    let del = 0;
    for (const l of result.diff.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) add++;
      else if (l.startsWith("-") && !l.startsWith("---")) del++;
    }
    return add || del ? `+${add} −${del}` : "";
  }
  return "";
}
