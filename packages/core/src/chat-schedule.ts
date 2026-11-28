/**
 * Recurring scheduled tasks from a chat (like Claude's scheduled tasks). They live in the same store as the model's
 * timers (ChatTimers, timers.json): this file holds the small `when` grammar, the next-run computation (local time,
 * DST-safe) and the agent tools `schedule_task`, `list_scheduled` and `cancel_scheduled`.
 *
 * The grammar (the PC's local time zone): "daily 08:30", "weekdays 09:00", "weekly mon 18:00", "every 6 hours", or one
 * time as an ISO date and time ("2026-12-01T09:00").
 */
import type { AgentTool } from "@kesher/agent";
import type { ChatTimer, ChatTimers } from "./chat-timers.js";

/** At most this many scheduled tasks per chat. */
export const SCHEDULED_PER_CHAT = 10;
/** At most this many in all. */
export const SCHEDULED_TOTAL = 30;
/** The shortest repeat: one hour. */
export const SCHEDULE_MIN_HOURS = 1;
/** A repeat of "every N hours" is at most this (a week). */
export const SCHEDULE_MAX_HOURS = 168;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** A parsed `when`. */
export type Schedule =
  | { t: "daily"; h: number; m: number }
  | { t: "weekdays"; h: number; m: number }
  | { t: "weekly"; d: number; h: number; m: number }
  | { t: "every"; hours: number }
  | { t: "once"; at: number };

const pad = (n: number) => String(n).padStart(2, "0");

/** @returns The hour and minute of "HH:MM" / "H:MM", or undefined when it is not a time of day. */
function clock(s: string): { h: number; m: number } | undefined {
  const x = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!x) return undefined;
  const h = Number(x[1]);
  const m = Number(x[2]);
  return h < 24 && m < 60 ? { h, m } : undefined;
}

/**
 * Reads a `when` of the grammar above.
 *
 * @param text - What the model gave.
 * @param now - The time now (ms), to refuse a one-time date in the past.
 * @returns The schedule, or an error message for the model.
 */
export function parseSchedule(text: unknown, now: number): Schedule | string {
  const s = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const help = 'Give "when" as "daily 08:30", "weekdays 09:00", "weekly mon 18:00", "every 6 hours" (1 hour or more) or one time like "2026-12-01T09:00" (this computer\'s time).';
  let x: RegExpExecArray | null;
  if ((x = /^(daily|weekdays) (\d{1,2}:\d{2})$/.exec(s))) {
    const c = clock(x[2]!);
    return c ? { t: x[1] as "daily" | "weekdays", ...c } : `"${x[2]}" is not a time of day (00:00 to 23:59).`;
  }
  if ((x = /^weekly ([a-z]+) (\d{1,2}:\d{2})$/.exec(s))) {
    const d = DAYS.findIndex((n) => x![1]!.startsWith(n));
    const c = clock(x[2]!);
    if (d < 0 || x[1]!.length < 3) return `"${x[1]}" is not a day of the week (mon, tue, ...).`;
    return c ? { t: "weekly", d, ...c } : `"${x[2]}" is not a time of day (00:00 to 23:59).`;
  }
  if ((x = /^every (\d+) ?(?:hours?|hrs?|h)$/.exec(s))) {
    const hours = Number(x[1]);
    if (hours < SCHEDULE_MIN_HOURS) return "A scheduled task repeats at most once an hour. For something sooner use set_timer or check_back_later.";
    if (hours > SCHEDULE_MAX_HOURS) return `"every N hours" is at most ${SCHEDULE_MAX_HOURS} (a week); use "weekly" for longer.`;
    return { t: "every", hours };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const at = Date.parse(s.replace(" ", "T"));
    if (Number.isNaN(at)) return help;
    return at < now + 30_000 ? "That time has passed. Give a time at least 30 seconds ahead." : { t: "once", at };
  }
  return help;
}

/** @returns The schedule written the same way every time ("weekly mon 18:00"), for storing and showing. */
export function scheduleText(sc: Schedule): string {
  switch (sc.t) {
    case "daily":
    case "weekdays":
      return `${sc.t} ${pad(sc.h)}:${pad(sc.m)}`;
    case "weekly":
      return `weekly ${DAYS[sc.d]} ${pad(sc.h)}:${pad(sc.m)}`;
    case "every":
      return `every ${sc.hours} hours`;
    case "once":
      return new Date(sc.at).toISOString();
  }
}

/**
 * The weekend days (0 = Sunday … 6 = Saturday) of this computer's work week: Friday and Saturday where the week runs
 * Sunday to Thursday (Israel, and most of the Middle East by time zone), else Saturday and Sunday.
 *
 * @param timeZone - The IANA time zone (default: this computer's).
 * @returns The two weekend days.
 */
export function weekendDays(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): readonly number[] {
  return /^Asia\/(Jerusalem|Tel_Aviv|Gaza|Hebron|Riyadh|Kuwait|Qatar|Bahrain|Baghdad|Amman|Damascus|Aden|Muscat|Dubai)$/.test(timeZone) || timeZone === "Israel"
    ? [5, 6]
    : [0, 6];
}

/**
 * The first run after `after`. Local times are built from the calendar date (not by adding 24 hours), so "daily
 * 09:00" stays 09:00 across a daylight-saving change; a time the clock skips (02:30 on the spring-forward night) runs
 * when the clock gets there.
 *
 * @param sc - The schedule.
 * @param after - From when (ms), exclusive.
 * @param weekend - The days "weekdays" skips (default: this computer's work week, {@link weekendDays}).
 * @returns When (ms); for "once" the time itself (or `after` + 1 when it has passed, never repeated by the caller).
 */
export function nextRun(sc: Schedule, after: number, weekend: readonly number[] = weekendDays()): number {
  if (sc.t === "once") return sc.at;
  if (sc.t === "every") return after + sc.hours * 3_600_000;
  const base = new Date(after);
  for (let i = 0; i < 9; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, sc.h, sc.m, 0, 0);
    const wd = day.getDay();
    if (sc.t === "weekdays" && weekend.includes(wd)) continue;
    if (sc.t === "weekly" && wd !== sc.d) continue;
    if (day.getTime() > after) return day.getTime();
  }
  return after + 86_400_000; // not reached: a match always lies within 8 days
}

/** What a scheduled task is stored as and shown as. */
export type ScheduledTask = ChatTimer & { kind: "scheduled"; name: string; when: string };

/** @returns Whether a stored timer is a scheduled task. */
export function isScheduled(t: ChatTimer): t is ScheduledTask {
  return t.kind === "scheduled" && typeof t.name === "string" && typeof t.when === "string";
}

/**
 * The text of the confirm card for a `schedule_task` call (the approval card's preview): one `key: value` line each
 * for the name, the schedule (stored form), the next run (ms), whether each run is a fresh chat, then the instructions
 * after a `---` line. The interface (apps/web/src/schedule-confirm.ts) reads it back and words it in the user's language.
 *
 * @param input - The tool's input.
 * @param now - The time now (ms).
 * @returns The preview, or an error message for the model when the schedule cannot be read.
 */
export function schedulePreview(input: Record<string, unknown>, now: number): { preview: string } | { error: string } {
  const sc = parseSchedule(input.when, now);
  if (typeof sc === "string") return { error: sc };
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) return { error: "Give the task a short name." };
  const prompt = String(input.prompt ?? "").trim().slice(0, 2000);
  if (!prompt) return { error: "Say what to do each time (prompt)." };
  return { preview: `schedule\nname: ${name.replace(/\s+/g, " ")}\nwhen: ${scheduleText(sc)}\nnext: ${nextRun(sc, now)}\nnewChat: ${input.new_chat === true}\n---\n${prompt}` };
}

/** A short "in 3 h" / "tomorrow 08:30" for the model. */
function whenShort(due: number): string {
  return new Date(due).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * `schedule_task`, `list_scheduled` and `cancel_scheduled` for one chat.
 *
 * @param timers - The timers (the same store as set_timer).
 * @param convId - The chat.
 * @returns The tools.
 */
export function scheduleTools(timers: ChatTimers, convId: string, now: () => number = Date.now): AgentTool[] {
  return [
    {
      risk: "read",
      // Nothing is saved before the user agrees: a confirm card (name, schedule and next run, the instructions) with
      // Save / Edit / Cancel, in every mode, and never "always" (a schedule keeps running when no one is looking).
      async gate(input, _ctx, info) {
        if (info.plan) return { action: "deny", reason: "Plan mode is on: nothing is scheduled. Put the schedule in the plan instead." };
        const p = schedulePreview(input, now());
        return "error" in p ? { action: "deny", reason: p.error } : { action: "ask", reason: "Save this scheduled task?", noAlways: true };
      },
      async preview(input) {
        const p = schedulePreview(input, now());
        return "error" in p ? p.error : p.preview;
      },
      spec: {
        name: "schedule_task",
        description:
          'Run a prompt again and again on a schedule, like Claude\'s scheduled tasks (e.g. "every morning summarise the news", "every Monday check the build"). Each time it is due, `prompt` arrives in this chat as a message "[KesherAI] Scheduled: <name>" and you answer it (or in a fresh chat with new_chat). `when` is one of: "daily 08:30", "weekdays 09:00", "weekly mon 18:00", "every 6 hours" (1 hour or more), or one time "2026-12-01T09:00"; this computer\'s time. If the computer was off, it runs once when KesherAI starts, marked late. Up to 10 per chat. Write `prompt` so it makes sense on its own; the user sees and can pause or delete scheduled tasks. The user first sees a card with the name, schedule and instructions and saves, edits or cancels it: if they cancel or ask for a change, do not save it another way; if they ask for a change, call schedule_task again with it. After scheduling, confirm it in one sentence (what and when).',
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "A short name, e.g. \"Morning news\"." },
            prompt: { type: "string", description: "What to do each time, written as an instruction that stands on its own." },
            when: { type: "string", description: 'e.g. "daily 08:30", "weekdays 09:00", "weekly mon 18:00", "every 6 hours", "2026-12-01T09:00".' },
            new_chat: { type: "boolean", description: "Run each time in a fresh chat instead of this one (default false)." },
          },
          required: ["name", "prompt", "when"],
        },
      },
      async run(input) {
        const t = await timers.schedule(convId, { name: String(input.name ?? ""), prompt: String(input.prompt ?? ""), when: String(input.when ?? ""), newChat: input.new_chat === true });
        if (typeof t === "string") throw new Error(t);
        return { output: `Scheduled "${t.name}" (${t.when}); next run ${whenShort(t.due)}. The user can pause or delete it in this chat's Scheduled list and in Settings.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "list_scheduled",
        description: "List this chat's scheduled tasks (id, name, when, next run, paused).",
        inputSchema: { type: "object", properties: {} },
      },
      async run() {
        const mine = timers.scheduled(convId);
        if (!mine.length) return { output: "No scheduled tasks in this chat." };
        return { output: mine.map((t) => `${t.id}: ${t.name} (${t.when}${t.paused ? ", paused" : ""}) next ${t.paused ? "-" : whenShort(t.due)}`).join("\n") };
      },
    },
    {
      risk: "read",
      spec: {
        name: "cancel_scheduled",
        description: "Delete one of this chat's scheduled tasks by its id (from list_scheduled).",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      async run(input) {
        const id = String(input.id ?? "");
        if (!timers.scheduled(convId).some((t) => t.id === id)) throw new Error("This chat has no scheduled task with that id (see list_scheduled).");
        await timers.cancel(id);
        return { output: "Scheduled task deleted." };
      },
    },
  ];
}
