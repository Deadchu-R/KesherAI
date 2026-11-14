/**
 * Chat timers and notifications from the model (as Open WebUI 0.11's `timer` and `notify` tools): the model can bring
 * a chat back at a time ("check the build in an hour") and can send the user a notification when something is worth
 * one. Unlike Open WebUI, waiting timers are listed and can be cancelled (the chat's header and the Routines page).
 *
 * Timers are kept in timers.json, so one that came due while KesherAI was closed fires soon after it starts. A due
 * timer whose chat is answering waits in that chat's queue, like a message typed while it works.
 */
import type { AgentTool } from "@kesher/agent";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/** One waiting timer. */
export interface ChatTimer {
  id: string;
  convId: string;
  /** What the chat is asked when it fires. */
  prompt: string;
  /** When (ms since 1970). */
  due: number;
  setAt: number;
}

/** At most this many waiting timers per chat. */
export const TIMERS_PER_CHAT = 10;
/** No further ahead than this. */
export const TIMER_MAX_MS = 30 * 86_400_000;

/**
 * When a timer is due: `in` ("45m", "2 hours", "1d", "90s") or `at` (a date and time; without a zone it is this
 * computer's local time).
 *
 * @param when - What the model gave.
 * @param now - The time now (ms).
 * @returns The due time, or an error message for the model.
 */
export function parseWhen(when: { in?: unknown; at?: unknown }, now: number): number | string {
  if (typeof when.in === "string" && when.in.trim()) {
    const m = /^\s*(?:in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*$/i.exec(when.in);
    if (!m) return 'Give "in" as a number and a unit, e.g. "45m", "2 hours", "1d".';
    const unit = m[2]!.toLowerCase()[0];
    const ms = Number(m[1]) * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    return check(now + ms, now);
  }
  if (typeof when.at === "string" && when.at.trim()) {
    const t = Date.parse(when.at.trim().replace(" ", "T"));
    if (Number.isNaN(t)) return 'Give "at" as a date and time, e.g. "2026-11-15T09:00" (this computer\'s time).';
    return check(t, now);
  }
  return 'Give "in" (e.g. "45m") or "at" (e.g. "2026-11-15T09:00").';
}

function check(due: number, now: number): number | string {
  if (due < now + 30_000) return "The time must be at least 30 seconds from now.";
  if (due > now + TIMER_MAX_MS) return "A timer can be at most 30 days ahead.";
  return due;
}

/** What timers run on. */
export interface TimerDeps {
  /** Puts a message in a chat (queued when it is answering). */
  send(convId: string, text: string): Promise<unknown>;
  /** Whether the chat still exists. */
  exists(convId: string): Promise<boolean>;
}

/** Keeps the waiting timers and fires them on time. */
export class ChatTimers {
  private list_: ChatTimer[] = [];
  private loaded?: Promise<void>;
  private clock?: NodeJS.Timeout;
  private saving = Promise.resolve();

  /**
   * @param file - timers.json.
   * @param deps - Sending to a chat.
   * @param now - The clock (tests move it).
   */
  constructor(
    private readonly file: string,
    private readonly deps: TimerDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the timers and starts the clock (once). */
  start(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8")
      .then((t) => void (this.list_ = (JSON.parse(t) as ChatTimer[]).filter((x) => x && typeof x.convId === "string" && typeof x.due === "number")), () => undefined)
      .then(() => {
        // The first look a little after start (the chats are ready then); every 15 s after.
        this.clock = setInterval(() => void this.tick().catch(() => undefined), 15_000);
        this.clock.unref?.();
      });
    return this.loaded;
  }

  /** Stops the clock. */
  stop(): void {
    if (this.clock) clearInterval(this.clock);
  }

  /** @returns Waiting timers, soonest first (of one chat, or all). */
  list(convId?: string): ChatTimer[] {
    return this.list_.filter((t) => !convId || t.convId === convId).sort((a, b) => a.due - b.due);
  }

  /**
   * Sets a timer.
   *
   * @returns The timer, or an error message.
   */
  async add(convId: string, prompt: string, due: number): Promise<ChatTimer | string> {
    if (!prompt.trim()) return "Say what the chat should do when the timer fires (prompt).";
    if (this.list(convId).length >= TIMERS_PER_CHAT) return `This chat already has ${TIMERS_PER_CHAT} timers waiting. Cancel one first.`;
    const t: ChatTimer = { id: randomUUID().slice(0, 8), convId, prompt: prompt.trim().slice(0, 2000), due, setAt: this.now() };
    this.list_.push(t);
    await this.save();
    return t;
  }

  /** Cancels a timer. @returns Whether it was waiting. */
  async cancel(id: string): Promise<boolean> {
    const n = this.list_.length;
    this.list_ = this.list_.filter((t) => t.id !== id);
    if (this.list_.length === n) return false;
    await this.save();
    return true;
  }

  /** Removes a deleted chat's timers. */
  async forget(convId: string): Promise<void> {
    const n = this.list_.length;
    this.list_ = this.list_.filter((t) => t.convId !== convId);
    if (this.list_.length !== n) await this.save();
  }

  /** Fires what is due (the clock calls it; tests too). */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.list_.filter((t) => t.due <= now);
    if (!due.length) return;
    this.list_ = this.list_.filter((t) => t.due > now);
    await this.save();
    for (const t of due) {
      try {
        if (!(await this.deps.exists(t.convId))) continue;
        const late = now - t.due > 5 * 60_000 ? " (late: KesherAI was closed when it was due)" : "";
        await this.deps.send(t.convId, `⏰ Timer${late}: ${t.prompt}`);
      } catch {
        // the chat is gone or cannot take a message now; the timer is not tried again
      }
    }
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.list_, null, 1);
    this.saving = this.saving.then(() => writeFile(this.file, data, "utf8")).catch(() => undefined);
    return this.saving;
  }
}

/** When each chat's notifications went (for the limits). */
const notesSent = new Map<string, number[]>();

/** A short "in 45 minutes" / "at 09:00" for the model's answer. */
function whenText(due: number, now: number): string {
  const min = Math.round((due - now) / 60_000);
  const at = new Date(due).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return min < 120 ? `in ${Math.max(1, min)} minutes (${at})` : `at ${at}`;
}

/**
 * `set_timer` and `notify_user` for one chat.
 *
 * @param timers - The timers.
 * @param convId - The chat.
 * @param notify - Sends the user a notification that opens this chat.
 * @param now - The clock (tests).
 * @returns The tools.
 */
export function timerTools(timers: ChatTimers, convId: string, notify: (title: string, body: string) => Promise<void>, now: () => number = Date.now): AgentTool[] {
  // Per chat, kept across turns (the tools are made again for each turn).
  const sent = notesSent.get(convId) ?? [];
  notesSent.set(convId, sent);
  return [
    {
      risk: "read",
      spec: {
        name: "set_timer",
        description:
          "Bring this chat back later: at the time, `prompt` is sent to this chat as a message and you answer it then (e.g. check a download, a build or a page again, or remind the user). Use it when the user asks to be reminded or to check something later. Give `in` (\"45m\", \"2 hours\", \"1d\") or `at` (\"2026-11-15T09:00\", this computer's time). The user sees waiting timers in the chat and can cancel them.",
        inputSchema: {
          type: "object",
          properties: {
            in: { type: "string", description: 'How long from now, e.g. "45m", "2 hours", "1d".' },
            at: { type: "string", description: 'A date and time, e.g. "2026-11-15T09:00".' },
            prompt: { type: "string", description: "What to do when it fires, written as an instruction to yourself." },
          },
          required: ["prompt"],
        },
      },
      async run(input) {
        const due = parseWhen({ in: input.in, at: input.at }, now());
        if (typeof due === "string") throw new Error(due);
        const t = await timers.add(convId, String(input.prompt ?? ""), due);
        if (typeof t === "string") throw new Error(t);
        return { output: `Timer set ${whenText(t.due, now())}. The user can see and cancel it in this chat.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "notify_user",
        description:
          "Send the user a notification (on this computer and their phone) that opens this chat. Only for something they asked to hear about or clearly need to know now (a long task finished, a timer found a change). At most one a minute.",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "One or two short sentences." },
            title: { type: "string", description: "A few words." },
          },
          required: ["message"],
        },
      },
      async run(input) {
        const t = now();
        while (sent.length && t - sent[0]! > 86_400_000) sent.shift();
        if (sent.length && t - sent.at(-1)! < 60_000) throw new Error("A notification was sent less than a minute ago; wait before sending another.");
        if (sent.length >= 20) throw new Error("20 notifications were sent from this chat today; no more today.");
        const message = String(input.message ?? "").trim().slice(0, 400);
        if (!message) throw new Error("Give the message.");
        sent.push(t);
        await notify(String(input.title ?? "").trim().slice(0, 80) || "KesherAI", message);
        return { output: "Notification sent." };
      },
    },
  ];
}
