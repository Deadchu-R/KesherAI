import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { AgentEvent } from "@kesher/shared";
import type { KesherConfig } from "./config.js";

/**
 * Notifications: on the phone (ntfy) and on this computer, when a long chat
 * or agent run ends, a download finishes, or an agent has been waiting a
 * minute for an approval or an answer.
 *
 * ntfy (https://ntfy.sh, open source) delivers to its phone app without an
 * account: KesherAI posts to a long random topic only this user knows. By
 * default only the conversation's title is sent, not its content.
 */

/** One notification. */
export interface Note {
  title: string;
  body: string;
  /** Opens this when tapped (on the phone only with remote access from anywhere). */
  path?: string;
  /** ntfy tags (emoji names). */
  tags?: string[];
  priority?: 1 | 2 | 3 | 4 | 5;
  /** Buttons on the phone's notification (and a watch's): each one POSTs to its path through "Access from anywhere". */
  actions?: Array<{ label: string; path: string }>;
}

/** How long an Approve / Deny button works. */
const QUICK_MS = 15 * 60_000;

type Settings = KesherConfig["notifications"];

/** Sends notifications and decides when work is worth one. */
export class Notifier {
  private started = new Map<string, number>();
  private waiting = new Map<string, NodeJS.Timeout>();
  /** One-time codes behind the Approve / Deny buttons. */
  private quick = new Map<string, { convId: string; requestId: string; expires: number }>();
  /** Last notifications, newest last (for tests and the settings page). */
  readonly sent: Array<Note & { at: number; channels: string[] }> = [];

  /**
   * @param settings - The user's notification settings (read each time).
   * @param opts - Where to send, and how to name and link things.
   */
  constructor(
    private readonly settings: () => Settings,
    private readonly opts: {
      /** Shows a notification on this computer; resolves false when the window is in front (then nothing is shown). */
      desktop?: (n: Note) => boolean | Promise<boolean>;
      /** The address of KesherAI from anywhere, when the tunnel runs. */
      publicUrl?: () => string | undefined;
      /** Answers an approval request (the Approve / Deny buttons). */
      decide?: (convId: string, requestId: string, decision: "allow" | "deny") => Promise<boolean>;
      fetch?: typeof fetch;
      /** Keeps the last notifications in this file, so the notifications page still lists them after a restart. */
      history?: string;
    } = {},
  ) {
    if (opts.history) void this.loadHistory(opts.history);
  }

  private saving?: NodeJS.Timeout;
  private async loadHistory(file: string): Promise<void> {
    const old = JSON.parse(await readFile(file, "utf8").catch(() => "[]")) as unknown;
    if (!Array.isArray(old)) return;
    const ok = old.filter((n): n is Note & { at: number; channels: string[] } => !!n && typeof n.title === "string" && typeof n.at === "number");
    this.sent.unshift(...ok.map((n) => ({ title: n.title, body: String(n.body ?? ""), ...(typeof n.path === "string" ? { path: n.path } : {}), at: n.at, channels: Array.isArray(n.channels) ? n.channels.filter((c) => typeof c === "string") : [] })));
    this.sent.splice(0, Math.max(0, this.sent.length - 50));
  }
  /** Writes the history a moment later (never the Approve / Deny buttons' one-time codes). */
  private saveHistory(): void {
    const file = this.opts.history;
    if (!file || this.saving) return;
    this.saving = setTimeout(() => {
      this.saving = undefined;
      const keep = this.sent.map((n) => ({ title: n.title, body: n.body, ...(n.path ? { path: n.path } : {}), at: n.at, channels: n.channels }));
      void writeFile(file, JSON.stringify(keep)).catch(() => undefined);
    }, 1000);
    this.saving.unref?.();
  }

  /** @returns A new long random topic, hard to guess. */
  static newTopic(): string {
    return `kesher-${randomBytes(12).toString("base64url")}`;
  }

  /**
   * Sends a notification to every channel that is on.
   *
   * @param n - The notification.
   * @param force - Send even when it would normally wait (the "send a test" button).
   * @returns The channels it went to.
   */
  async send(n: Note, force = false): Promise<string[]> {
    const s = this.settings();
    const channels: string[] = [];
    const jobs: Array<Promise<unknown>> = [];
    if (s.desktop && this.opts.desktop) {
      jobs.push(Promise.resolve(this.opts.desktop(n)).then((shown) => shown && channels.push("desktop"), () => undefined));
    }
    if ((s.ntfy.enabled || force) && s.ntfy.topic) {
      const base = this.opts.publicUrl?.();
      const headers: Record<string, string> = { Title: ascii(n.title), Priority: String(n.priority ?? 3) };
      if (n.tags?.length) headers.Tags = n.tags.join(",");
      if (base && n.path) headers.Click = `${base.replace(/\/$/, "")}/${n.path.replace(/^\//, "")}`;
      const server = s.ntfy.server.replace(/\/$/, "");
      const url = `${server}/${encodeURIComponent(s.ntfy.topic)}`;
      // With buttons: ntfy's JSON form (its headers cannot carry the buttons' addresses well).
      const json = !!base && !!n.actions?.length;
      const request: RequestInit =
        json && base && n.actions
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                topic: s.ntfy.topic,
                title: n.title,
                message: n.body,
                priority: n.priority ?? 3,
                ...(n.tags?.length ? { tags: n.tags } : {}),
                ...(headers.Click ? { click: headers.Click } : {}),
                actions: n.actions.map((a) => ({ action: "http", label: a.label, url: `${base.replace(/\/$/, "")}/${a.path.replace(/^\//, "")}`, method: "POST", clear: true })),
              }),
            }
          : { method: "POST", headers, body: n.body };
      jobs.push(
        (this.opts.fetch ?? fetch)(json ? server : url, { ...request, signal: AbortSignal.timeout(15_000) }).then(
          (r) => {
            if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
            channels.push("phone");
          },
          (e: Error) => {
            if (force) throw e;
          },
        ),
      );
    }
    await Promise.all(jobs);
    this.sent.push({ ...n, at: Date.now(), channels });
    if (this.sent.length > 50) this.sent.shift();
    this.saveHistory();
    return channels;
  }

  /**
   * Follows a conversation's events: remembers when work starts, notifies
   * when long work ends, and when the agent waits a minute for the user.
   *
   * @param convId - The conversation.
   * @param title - Its current title.
   * @param e - The event.
   * @param lastAnswer - The latest answer's text, for the notification.
   */
  onConversationEvent(convId: string, title: () => string, e: AgentEvent, lastAnswer: () => string | undefined): void {
    const s = this.settings();
    if (e.type === "status") {
      if (e.status === "running") {
        if (!this.started.has(convId)) this.started.set(convId, Date.now());
        this.clearWaiting(convId);
        return;
      }
      if (e.status === "waiting") return;
      const t0 = this.started.get(convId);
      this.started.delete(convId);
      this.clearWaiting(convId);
      if (t0 === undefined || Date.now() - t0 < s.minSeconds * 1000) return;
      const failed = e.status === "error";
      const text = s.includeText ? (lastAnswer() ?? "").replace(/\s+/g, " ").trim().slice(0, 200) : "";
      void this.send({
        title: failed ? `Stopped with an error: ${title()}` : `Done: ${title()}`,
        body: text || (failed ? e.message ?? "Open KesherAI to see what happened." : `Finished after ${minutes(Date.now() - t0)}.`),
        path: `#/c/${convId}`,
        tags: [failed ? "warning" : "white_check_mark"],
      }).catch(() => undefined);
      return;
    }
    if ((e.type === "approval_request" || e.type === "question") && s.waiting) {
      this.clearWaiting(convId);
      const t = setTimeout(() => {
        this.waiting.delete(convId);
        const approval = e.type === "approval_request";
        const buttons = approval && s.approveButtons && !!this.opts.decide && !!this.opts.publicUrl?.();
        const code = buttons ? this.quickCode(convId, e.requestId) : undefined;
        const what = approval ? (s.includeText && e.preview ? `${e.name}: ${e.preview.replace(/\s+/g, " ").slice(0, 160)}` : e.name) : "";
        void this.send({
          title: `Waiting for you: ${title()}`,
          body: approval ? `The agent needs your approval to go on (${what}).` : "The agent asked you a question.",
          path: approval ? "#/watch" : `#/c/${convId}`,
          tags: ["raised_hand"],
          priority: 4,
          ...(code ? { actions: [{ label: "Approve", path: `api/quick-approve/${code}?d=allow` }, { label: "Deny", path: `api/quick-approve/${code}?d=deny` }] } : {}),
        }).catch(() => undefined);
      }, s.waitingSeconds * 1000);
      t.unref?.();
      this.waiting.set(convId, t);
      return;
    }
    if (e.type === "approval_result" || e.type === "answer") this.clearWaiting(convId);
  }

  /**
   * Notifies when a long download finishes or fails.
   *
   * @param job - The download as it is now.
   * @param job.id - Its id.
   * @param job.label - What it is.
   * @param job.status - Its status.
   */
  onDownload(job: { id: string; label: string; status: string; error?: string }): void {
    const s = this.settings();
    if (job.status === "downloading" || job.status === "queued") {
      if (!this.started.has(`dl:${job.id}`)) this.started.set(`dl:${job.id}`, Date.now());
      return;
    }
    if (job.status !== "done" && job.status !== "failed") return;
    const t0 = this.started.get(`dl:${job.id}`);
    this.started.delete(`dl:${job.id}`);
    if (t0 === undefined || Date.now() - t0 < Math.max(s.minSeconds, 60) * 1000) return;
    const name = job.label.split(/[\\/]/).pop() ?? job.label;
    void this.send({
      title: job.status === "done" ? `Downloaded: ${name}` : `Download failed: ${name}`,
      body: job.status === "done" ? `Ready after ${minutes(Date.now() - t0)}.` : job.error ?? "Open KesherAI to try again.",
      path: "#/models",
      tags: [job.status === "done" ? "inbox_tray" : "warning"],
    }).catch(() => undefined);
  }

  private quickCode(convId: string, requestId: string): string {
    const now = Date.now();
    for (const [k, v] of this.quick) if (v.expires < now) this.quick.delete(k);
    const code = randomBytes(24).toString("base64url");
    this.quick.set(code, { convId, requestId, expires: now + QUICK_MS });
    return code;
  }

  /**
   * Answers an approval from a notification's button. Each code works once,
   * for one request, for 15 minutes.
   *
   * @param code - The button's code.
   * @param decision - Approve or deny.
   * @returns Whether a waiting request was answered.
   */
  async quickDecide(code: string, decision: "allow" | "deny"): Promise<boolean> {
    const q = this.quick.get(code);
    this.quick.delete(code);
    if (!q || q.expires < Date.now() || !this.opts.decide) return false;
    return this.opts.decide(q.convId, q.requestId, decision);
  }

  private clearWaiting(convId: string) {
    clearTimeout(this.waiting.get(convId));
    this.waiting.delete(convId);
  }

  /** Stops the timers. */
  close(): void {
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** HTTP headers must be plain text; ntfy reads UTF-8 titles sent as RFC 2047. */
function ascii(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}
