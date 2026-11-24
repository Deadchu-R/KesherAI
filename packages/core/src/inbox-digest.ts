/**
 * The inbox digest (`inbox-digest.md`, served at GET /api/task-inbox/digest): what finished, failed, ended partly or
 * waits since the last digest, per executor, with the branches pushed, any reviewer verdict a task's text states, and
 * the quotas and caps, as plain facts (no model call). It lets the lead read one file at check-in time instead of
 * many API calls. Pure functions, so each part is tested with a fake clock.
 */

import type { InboxState, InboxTaskView } from "@kesher/shared";
import { clock, dailySummary, localDay } from "./work-loop.js";

/** The digest file's name in KesherAI's data folder. */
export const DIGEST_FILE = "inbox-digest.md";

/** The statuses that mean a task still waits for something (a Run, a slot, an answer, a quota reset). */
const WAITING = new Set<string>(["waiting", "queued", "running", "needs-approval", "deferred-quota"]);

/** What the digest reads besides the inbox state. */
export interface DigestInput {
  state: Pick<InboxState, "settings" | "today" | "tasks" | "busy" | "quota" | "opencode" | "free" | "loop">;
  /** Counted from here (the last digest, or a day back). */
  since: number;
  now: number;
  /** The last self-work run's facts, if any (no paths). */
  selfWork?: { status: string; branch?: string; note?: string } | null;
}

/**
 * A reviewer's verdict stated in a task's summary or note: a line like `Verdict: approve` or `Reviewer: needs changes`.
 *
 * @param t - The task.
 * @returns The verdict text (cut), or undefined when none is stated.
 */
export function reviewerVerdict(t: Pick<InboxTaskView, "summary" | "note">): string | undefined {
  for (const text of [t.summary, t.note]) {
    const m = /^\s*(?:reviewer(?:'s)? verdict|verdict|reviewer)\s*[:-]\s*(.+)$/im.exec(text ?? "");
    if (m) return m[1]!.trim().slice(0, 120);
  }
  return undefined;
}

/** A task's one line: id, title (cut), and the facts that apply. */
function line(t: InboxTaskView): string {
  const title = t.title.length > 70 ? `${t.title.slice(0, 69).trimEnd()}…` : t.title;
  const bits = [t.modelUsed ? `model ${t.modelUsed}` : "", t.pushed ? `branch ${t.branch} pushed${t.merged ? ", merged" : ""}` : t.status === "partial" ? `branch ${t.branch}` : "", t.status === "failed" && t.note ? `why: ${t.note.replace(/\s+/g, " ").slice(0, 120)}` : "", t.status === "deferred-quota" && t.retryAt ? `retry ${clock(t.retryAt)}` : ""];
  const v = reviewerVerdict(t);
  if (v) bits.push(`reviewer: ${v}`);
  return `- ${t.id}: ${title}${bits.filter(Boolean).length ? ` (${bits.filter(Boolean).join("; ")})` : ""}`;
}

/**
 * The digest as Markdown.
 *
 * @param i - The inbox state and the window.
 * @returns The file's text. The first line is a comment holding when it was made, read back by {@link digestSince}.
 */
export function buildDigest(i: DigestInput): string {
  const { state, since, now } = i;
  const tasks = state.tasks.filter((t) => !t.standing || t.status !== "waiting");
  const executors = [...new Set(tasks.map((t) => t.runBy))].sort();
  const next = tasks.filter((t) => t.status === "waiting").slice(0, 3).map((t) => t.title);
  const head = dailySummary({ tasks, next, since, state: state.loop ?? { state: "off" } });
  const out: string[] = [`<!-- digest-at: ${now} -->`, "# Inbox digest", "", `Made ${localDay(now)} ${clock(now)}; counts since ${localDay(since)} ${clock(since)}.`, "", head.title, ""];
  for (const ex of executors) {
    const mine = tasks.filter((t) => t.runBy === ex);
    const ended = mine.filter((t) => !WAITING.has(t.status) && (t.endedAt ?? 0) >= since);
    const group = (label: string, xs: InboxTaskView[]) => (xs.length ? [`**${label} (${xs.length})**`, ...xs.map(line), ""] : []);
    const body = [
      ...group("Finished", ended.filter((t) => t.status === "done")),
      ...group("Partial", ended.filter((t) => t.status === "partial")),
      ...group("Failed", ended.filter((t) => t.status === "failed")),
      ...group("Declined or skipped", ended.filter((t) => t.status === "declined" || t.status === "skipped")),
      ...group("Waiting or running", mine.filter((t) => WAITING.has(t.status))),
    ];
    out.push(`## ${ex}`, "", ...(body.length ? body : ["Nothing new.", ""]));
  }
  if (!executors.length) out.push("No tasks in the inbox.", "");
  const pushed = tasks.filter((t) => t.pushed && !t.merged && (t.status === "done" || t.status === "partial"));
  out.push("## Branches pushed, not merged", "", ...(pushed.length ? pushed.map((t) => `- ${t.branch} (${t.id}, ${t.status})`) : ["None."]), "");
  const s = state.settings;
  out.push("## Quotas and caps", "");
  out.push(`- Antigravity today: ${state.today.used} of ${s.dailyCap} runs${state.quota ? `; plan quota out until ${localDay(state.quota.until)} ${clock(state.quota.until)}${state.quota.estimated ? " (estimated)" : ""}` : ""}.`);
  if (state.opencode?.ready) out.push(`- OpenCode Go today: ${state.opencode.used} tasks${state.opencode.until ? `; limit reached until ${clock(state.opencode.until)}` : ""}.`);
  for (const f of state.free ?? []) out.push(`- ${f.name}: ${f.used}${f.limit ? ` of ${f.limit}` : ""} requests today${f.until ? `; out until ${clock(f.until)}` : ""}.`);
  out.push(`- Work loop: ${state.loop?.state ?? "off"}${state.loop?.until ? ` until ${clock(state.loop.until)}` : ""}${state.loop?.why ? ` (${state.loop.why})` : ""}; inbox ${!s.enabled ? "off" : s.paused ? "paused" : "on"}.`);
  out.push(`- This computer: ${state.busy.free ? "free" : `busy (${state.busy.reasons.join(", ") || "in use"})`}.`);
  if (i.selfWork) out.push(`- Self-work: ${i.selfWork.status}${i.selfWork.branch ? ` on ${i.selfWork.branch}` : ""}${i.selfWork.note ? ` (${i.selfWork.note.replace(/\s+/g, " ").slice(0, 120)})` : ""}.`);
  return `${out.join("\n")}\n`;
}

/**
 * When the previous digest was made, read from its first line.
 *
 * @param text - The old file's text (empty when there is none).
 * @param now - Now (ms), for the default.
 * @returns That time, or a day before now.
 */
export function digestSince(text: string, now: number): number {
  const m = /^<!-- digest-at: (\d+) -->/.exec(text);
  const at = m ? Number(m[1]) : NaN;
  return Number.isFinite(at) && at > 0 && at <= now ? at : now - 24 * 3_600_000;
}
