/**
 * "My day"'s pure parts: the day key, which windows are never captured, a day's figures, and reading the model's
 * answers. No disk, no screen: tested on their own (journal.ts re-exports them).
 */
import { isSensitiveWindow } from "./computer.js";
import type { Capture, DayStats, Meeting } from "./journal.js";

/** Apps never captured, whatever the user sets. */
const ALWAYS_EXCLUDED = /^(1password|bitwarden|keepass(xc)?|lastpass|dashlane|nordpass|enpass|keeper|lockapp|logonui|consent|credentialuibroker)$/i;
const PRIVATE_WINDOW = /(inprivate|incognito|private browsing|גלישה בסתר|פרטי)/i;
const MEETING = /(zoom meeting|zoom workplace|microsoft teams|\| microsoft teams|meet\.google|google meet|webex|skype|discord.*voice|slack.*huddle)/i;

/** Local day key, `YYYY-MM-DD`. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Whether a window must not be captured.
 *
 * @param app - Process name.
 * @param title - Window title.
 * @param exclude - The user's excluded apps.
 * @returns Why, or undefined when it may be captured.
 */
export function skipReason(app: string, title: string, exclude: string[]): string | undefined {
  const a = app.replace(/\.exe$/i, "");
  if (ALWAYS_EXCLUDED.test(a)) return "password-manager";
  if (exclude.some((x) => x.trim() && x.trim().replace(/\.exe$/i, "").toLowerCase() === a.toLowerCase())) return "excluded";
  if (PRIVATE_WINDOW.test(title)) return "private-window";
  if (isSensitiveWindow(title)) return "sensitive";
  return undefined;
}

/**
 * Works out time per app, focus and meetings from a day's captures.
 *
 * @param caps - The day's captures, in order.
 * @param intervalSec - Seconds between captures (each capture counts for that long, at most).
 * @returns The figures.
 */
export function dayStats(caps: Capture[], intervalSec: number): DayStats {
  const per = new Map<string, number>();
  const hours = Array.from({ length: 24 }, () => 0);
  const meetings: DayStats["meetings"] = [];
  let switches = 0;
  let prev = "";
  let run = { app: "", start: 0, end: 0 };
  let longest = { app: "", minutes: 0 };
  let active = 0;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i]!;
    if (c.idle) {
      prev = "";
      continue;
    }
    const next = caps[i + 1];
    const dur = Math.min(intervalSec * 1000 * 1.5, next ? next.t - c.t : intervalSec * 1000) / 60000;
    active += dur;
    const app = c.app || "?";
    per.set(app, (per.get(app) ?? 0) + dur);
    hours[new Date(c.t).getHours()]! += dur;
    if (prev && app !== prev) switches++;
    if (app !== run.app) run = { app, start: c.t, end: c.t };
    run.end = c.t + dur * 60000;
    const len = (run.end - run.start) / 60000;
    if (len > longest.minutes) longest = { app, minutes: len };
    prev = app;
    if (MEETING.test(`${c.app} ${c.title}`)) {
      const last = meetings.at(-1);
      if (last && c.t - last.t1 < 5 * 60000) last.t1 = c.t + dur * 60000;
      else meetings.push({ t0: c.t, t1: c.t + dur * 60000, title: c.title || c.app });
    }
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    activeMinutes: r(active),
    apps: [...per].map(([app, minutes]) => ({ app, minutes: r(minutes) })).sort((a, b) => b.minutes - a.minutes),
    switches,
    longestFocus: { app: longest.app, minutes: r(longest.minutes) },
    meetings: meetings.filter((m) => m.t1 - m.t0 >= 2 * 60000),
    hours: hours.map(r),
  };
}

/**
 * Reads the model's JSON answer, tolerating code fences and extra words.
 *
 * @param text - The model's answer.
 * @returns The parsed parts.
 */
export function parseInsights(text: string): {
  observations: Array<{ from?: string; to?: string; text: string; kind?: string }>;
  actions: Array<{ text: string; who?: string }>;
  entities: Array<{ name: string; kind?: string; note?: string }>;
} {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const empty = { observations: [], actions: [], entities: [] };
  if (start < 0 || end <= start) return empty;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
    return {
      observations: arr<{ from?: string; to?: string; text: string; kind?: string }>(j.observations).filter((o) => typeof o?.text === "string"),
      actions: arr<{ text: string; who?: string }>(j.actions).filter((a) => typeof a?.text === "string"),
      entities: arr<{ name: string; kind?: string; note?: string }>(j.entities).filter((e) => typeof e?.name === "string" && e.name.trim().length > 1),
    };
  } catch {
    return empty;
  }
}

/**
 * A meeting's transcript as text: one line per piece, with the time and who
 * spoke ("Me" is the user's microphone, "Others" the call's sound).
 *
 * @param m - The meeting.
 * @returns The transcript.
 */
export function meetingTranscript(m: Pick<Meeting, "segments">): string {
  return m.segments.map((x) => `[${new Date(x.t).toTimeString().slice(0, 5)}] ${x.who === "me" ? "Me: " : x.speaker ? `Speaker ${x.speaker}: ` : x.who === "others" ? "Others: " : ""}${x.text}`).join("\n");
}


/**
 * Reads the model's meeting write-up.
 *
 * @param text - The model's answer.
 * @returns Summary, decisions and actions.
 */
export function parseMeeting(text: string): { summary: string; decisions: string[]; actions: Array<{ text: string; who?: string }> } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as { summary?: unknown; decisions?: unknown; actions?: unknown };
    return {
      summary: typeof j.summary === "string" ? j.summary.slice(0, 3000) : "",
      decisions: Array.isArray(j.decisions) ? j.decisions.filter((d): d is string => typeof d === "string").slice(0, 30) : [],
      actions: Array.isArray(j.actions) ? (j.actions as Array<{ text?: unknown; who?: unknown }>).filter((x) => typeof x?.text === "string").map((x) => ({ text: String(x.text), ...(typeof x.who === "string" && x.who ? { who: x.who } : {}) })) : [],
    };
  } catch {
    return { summary: text.trim().slice(0, 3000), decisions: [], actions: [] };
  }
}
