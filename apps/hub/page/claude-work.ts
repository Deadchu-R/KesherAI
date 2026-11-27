/**
 * "Agents' work" (העבודה של הסוכנים) in the hub's Agents tab (the design doc's HubAgentsWork board): what Claude's helper
 * agents did in the last 7 days, as each PC reports it (a sealed `claude_work` snapshot: commit titles, file counts,
 * times, release versions and GitHub links; read from git on the PC, no GitHub key, no tokens). Today first, then this
 * week; one card per session, its commits as rows with an "in 0.6.NNN" chip or "not released yet"; a row opens the
 * commit on GitHub. Nothing is stored here.
 */
import { splitToday, type ClaudeSession } from "../../../packages/shared/src/claude-work.js";
import { isMaybeStuck, minutesSince } from "../../../packages/shared/src/claude-status.js";
import type { HubClaudeCommit, HubClaudeRunning, HubClaudeSession } from "../../../packages/shared/src/hub-protocol.js";
import { h, L, type Child } from "./dom.js";
import type { HubDevice } from "./device.js";

/** The clock today, the weekday and clock on another day. */
function clock(t: number, now: number): string {
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString(L("he-IL", "en-GB"), sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** One commit as a row: title, files and time, and its release chip; it opens the commit on GitHub. */
function commitRow(c: HubClaudeCommit, now: number): HTMLElement {
  const body: Child[] = [
    h("span", { class: "cw-title", dir: "auto" }, c.title),
    h("span", { class: "mut sm" }, `${L(`${c.files} קבצים`, `${c.files} files`)} · ${clock(c.at, now)}`),
    h("span", { class: c.release ? "chip cw-rel" : "chip cw-pending" }, c.release ? L(`בגרסה ${c.release}`, `in ${c.release}`) : L("עוד לא בגרסה", "not released yet")),
  ];
  return c.url ? h("a", { class: "trow cw-row", href: c.url, target: "_blank", rel: "noopener noreferrer" }, ...body) : h("div", { class: "trow cw-row" }, ...body);
}

/** One session: its title, how many commits are not released yet, and its commits. */
function sessionCard(s: HubClaudeSession, now: number): HTMLElement {
  const pending = s.commits.filter((c) => !c.release).length;
  return h(
    "div",
    { class: "cw-session" },
    h("div", { class: "trow" }, h("b", { dir: "auto" }, s.title), h("span", { class: "mut sm" }, L(`${s.commits.length} קומיטים`, `${s.commits.length} commits`) + " · " + (pending ? L(`${pending} עוד לא בגרסה`, `${pending} not released yet`) : L("כולם בגרסה", "all released")))),
    ...s.commits.map((c) => commitRow(c, now)),
  );
}

/** One running helper as a row: title, model, minutes, and the "maybe stuck" chip when it has been quiet too long. */
function runningRow(a: HubClaudeRunning, now: number): HTMLElement {
  const stuck = isMaybeStuck({ ...a, state: "running" }, now);
  return h(
    "div",
    { class: "trow cw-row cw-run" },
    h("span", { class: "cw-title", dir: "auto" }, a.title),
    h("span", { class: "mut sm" }, `${a.model ? a.model + " · " : ""}${L(`${minutesSince(a.startedAt, now)} דק׳`, `${minutesSince(a.startedAt, now)} min`)}${a.lastNote ? " · " + a.lastNote : ""}`),
    stuck ? h("span", { class: "chip cw-stuck" }, "⚠ " + L("אולי תקוע", "maybe stuck")) : null,
  );
}

/**
 * The section for the Agents tab, or null while no PC has reported a list (an older PC) .
 *
 * @param device - The page's device state (its `claudeWork` snapshots).
 */
export function claudeWorkSection(device: HubDevice): HTMLElement | null {
  if (!device.claudeWork.size) return null;
  const now = Date.now();
  // Two PCs may see the same project: a session is listed once (the newer snapshot's copy).
  const all = new Map<string, HubClaudeSession>();
  for (const w of [...device.claudeWork.values()].sort((a, b) => a.at - b.at)) for (const s of w.sessions) all.set(s.id, s);
  // The newest snapshot's running list wins (the lead's file is the same for every PC of the project).
  const runSnap = [...device.claudeWork.values()].sort((a, b) => b.at - a.at).find((w) => w.running.length);
  const running = (runSnap?.running ?? []).slice().sort((a, b) => a.startedAt - b.startedAt);
  const asSessions = [...all.values()].sort((a, b) => b.at - a.at) as unknown as ClaudeSession[];
  const { today, week } = splitToday(asSessions, now);
  const group = (title: string, list: ClaudeSession[]) => (list.length ? [h("div", { class: "trow cw-day mut sm" }, title), ...(list as unknown as HubClaudeSession[]).map((s) => sessionCard(s, now))] : []);
  return h(
    "section",
    { class: "card clip claude-work" },
    h("div", { class: "row head wrap" }, h("span", { "aria-hidden": "true" }, "🧾"), h("b", null, L("העבודה של הסוכנים", "Agents' work")), h("span", { class: "grow" }), h("span", { class: "mut sm" }, L("7 ימים · מהקומיטים ב-main", "7 days · from the commits on main"))),
    ...(running.length ? [h("div", { class: "trow cw-day cw-running-head" }, h("b", null, L(`רצים עכשיו: ${running.length}`, `Running now: ${running.length}`))), ...running.map((a) => runningRow(a, now))] : []),
    ...(asSessions.length ? [...group(L("היום", "Today"), today), ...group(L("השבוע", "This week"), week)] : [...(running.length ? [] : [h("div", { class: "trow mut sm" }, L("עוד אין עבודה של סוכנים השבוע.", "No agent work this week yet."))])]),
  );
}
