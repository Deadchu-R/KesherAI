import { randomBytes } from "node:crypto";
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
}

type Settings = KesherConfig["notifications"];

/** Sends notifications and decides when work is worth one. */
export class Notifier {
  private started = new Map<string, number>();
  private waiting = new Map<string, NodeJS.Timeout>();
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
      fetch?: typeof fetch;
    } = {},
  ) {}

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
      const url = `${s.ntfy.server.replace(/\/$/, "")}/${encodeURIComponent(s.ntfy.topic)}`;
      jobs.push(
        (this.opts.fetch ?? fetch)(url, { method: "POST", headers, body: n.body, signal: AbortSignal.timeout(15_000) }).then(
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
        void this.send({
          title: `Waiting for you: ${title()}`,
          body: e.type === "question" ? "The agent asked you a question." : "The agent needs your approval to go on.",
          path: `#/c/${convId}`,
          tags: ["raised_hand"],
          priority: 4,
        }).catch(() => undefined);
      }, 60_000);
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
