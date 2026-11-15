/**
 * Share links (like ChatGPT's, LibreChat's and Open WebUI's): the user shares a chat as a read-only web page at
 * `/s/<token>`, reachable wherever KesherAI is (over "Access from anywhere" from the internet). A share is a snapshot
 * of the chat when it was made or last updated (same link): only what the user wrote and the answers, never tool
 * steps, approvals or instructions; attached files by name only; local paths and anything that looks like a key are
 * hidden. The token (128 bits) is the only key, so each share can be revoked on its own, and expires (7 days by default).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** One message in a share. */
export interface SharedMessage {
  role: "user" | "assistant";
  text: string;
  /** Attached files, by name. */
  files?: string[];
}

/** A share. */
export interface Share {
  /** For the owner's list and revoking (not secret). */
  id: string;
  /** The secret part of the link. */
  token: string;
  convId: string;
  title: string;
  messages: SharedMessage[];
  createdAt: string;
  updatedAt: string;
  /** When the link stops working (none: until revoked). */
  expiresAt: string | null;
  views: number;
  /** The sharer's interface language: the page's labels and direction. */
  lang?: "he" | "en";
}

/** What the share list shows (no messages). */
export type ShareSummary = Omit<Share, "messages"> & { messages: number };

/** What a chat's events look like, as far as a share reads them. */
export interface ChatEvent {
  type: string;
  text?: string;
}

const ATTACHED = /\[(?:Attached|קובץ מצורף|מצורף)\s*:\s*([^\]\n]+)\]/g;

/**
 * Hides what a shared page must not show: local paths (they hold the Windows user name) and things that look like
 * keys, tokens or passwords.
 *
 * @param text - A message.
 * @param home - This computer's home folder.
 * @returns The text to publish.
 */
export function cleanForShare(text: string, home = homedir()): string {
  let t = text;
  if (home && home.length > 3) t = t.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  return t
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`)\]]+/gi, "~")
    .replace(/(^|[\s"'`(])\/(?:home|Users)\/[^/\s"'`)\]]+/g, "$1~")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-…")
    .replace(/\b(ghp|gho|ghu|ghs|github_pat|hf|xox[abp])_[A-Za-z0-9_]{8,}/g, "$1_…")
    .replace(/\bkd_[A-Za-z0-9_-]{8,}/g, "kd_…")
    .replace(/\b(Bearer|token|apikey|api_key|password|secret)([=: ]+)[^\s&"']{4,}/gi, "$1$2…")
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1…@")
    .replace(/([?&](?:token|key|sig|signature)=)[^\s&"']+/gi, "$1…");
}

/**
 * The messages of a share: what the user wrote and the final answers, cleaned; files by name.
 *
 * @param events - The chat's events.
 * @returns The messages (empty when there is nothing to share).
 */
export function snapshotOf(events: readonly ChatEvent[]): SharedMessage[] {
  const out: SharedMessage[] = [];
  for (const e of events) {
    if ((e.type !== "user" && e.type !== "assistant") || typeof e.text !== "string") continue;
    const files = [...e.text.matchAll(ATTACHED)].map((m) => m[1]!.trim().split(/[\\/]/).pop()!).filter(Boolean);
    const text = cleanForShare(e.text.replace(ATTACHED, "").replace(/\n{3,}/g, "\n\n").trim());
    if (!text && !files.length) continue;
    out.push({ role: e.type, text: text.slice(0, 100_000), ...(files.length ? { files: files.map((f) => cleanForShare(f)) } : {}) });
  }
  return out.slice(-500);
}

/** The shares, in one file. */
export class ShareStore {
  private shares: Share[] | undefined;
  private writes = Promise.resolve();

  /** @param file - shares.json in KesherAI's data folder. */
  constructor(private readonly file: string) {}

  private async all(): Promise<Share[]> {
    this.shares ??= await readFile(this.file, "utf8").then((t) => JSON.parse(t) as Share[], () => []);
    return this.shares;
  }

  private save(): Promise<void> {
    const run = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.shares ?? []), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** @returns The shares, newest first, without their messages. */
  async list(): Promise<ShareSummary[]> {
    return (await this.all()).map((s) => ({ ...s, messages: s.messages.length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Shares a chat, or updates its share (same link, a new snapshot and expiry).
   *
   * @param convId - The chat.
   * @param title - Its title.
   * @param messages - The snapshot.
   * @param days - How long the link works (0: until revoked).
   * @param now - The time (tests pass their own).
   * @param lang - The sharer's interface language (the page's labels).
   * @returns The share.
   */
  async share(convId: string, title: string, messages: SharedMessage[], days: number, now = Date.now(), lang: "he" | "en" = "en"): Promise<Share> {
    if (!messages.length) throw Object.assign(new Error("There is nothing to share in this chat yet."), { code: 400 });
    const list = await this.all();
    const at = new Date(now).toISOString();
    const expiresAt = days > 0 ? new Date(now + Math.min(days, 365) * 86_400_000).toISOString() : null;
    let s = list.find((x) => x.convId === convId);
    if (s) Object.assign(s, { title: cleanForShare(title).slice(0, 200), messages, updatedAt: at, expiresAt, lang });
    else {
      s = { id: randomBytes(6).toString("hex"), token: randomBytes(16).toString("base64url"), convId, title: cleanForShare(title).slice(0, 200), messages, createdAt: at, updatedAt: at, expiresAt, views: 0, lang };
      list.push(s);
    }
    await this.save();
    return s;
  }

  /**
   * @param convId - A chat.
   * @returns Its share, if it has one.
   */
  async ofChat(convId: string): Promise<ShareSummary | undefined> {
    return (await this.list()).find((s) => s.convId === convId);
  }

  /**
   * Opens a share by its link (and counts the view).
   *
   * @param token - The link's token.
   * @param now - The time.
   * @returns The share, or undefined when there is none or it expired.
   */
  async open(token: string, now = Date.now()): Promise<Share | undefined> {
    if (!/^[\w-]{22}$/.test(token)) return undefined;
    const s = (await this.all()).find((x) => x.token === token);
    if (!s || (s.expiresAt && Date.parse(s.expiresAt) <= now)) return undefined;
    s.views++;
    void this.save().catch(() => undefined);
    return s;
  }

  /**
   * Revokes a share: its link stops working at once.
   *
   * @param id - The share's id.
   * @returns Whether there was one.
   */
  async revoke(id: string): Promise<boolean> {
    const list = await this.all();
    const i = list.findIndex((s) => s.id === id || s.convId === id);
    if (i < 0) return false;
    list.splice(i, 1);
    await this.save();
    return true;
  }
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Bold and inline code inside escaped text (nothing else: no links, no pictures). */
const inline = (t: string) => t.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

/** A message's text as safe HTML: code blocks as <pre>, the rest as paragraphs (no links, no pictures, no scripts). */
function body(text: string): string {
  return text
    .split(/```[^\n]*\n?/)
    .map((part, i) => (i % 2 ? `<pre>${esc(part.replace(/\n$/, ""))}</pre>` : part.split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p dir="auto">${inline(esc(p)).replace(/\n/g, "<br>")}</p>`).join("")))
    .join("");
}

/** The headers a shared page goes out with: nothing runs or loads from it, search engines leave it out. */
export const SHARE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

/**
 * The read-only page of a share: plain HTML and CSS, no script.
 *
 * @param s - The share (undefined: the "no longer shared" page).
 * @returns The page.
 */
export function sharePage(s: Share | undefined): string {
  const css = `body{margin:0;background:#141414;color:#e8e8e8;font:16px/1.6 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px 64px}h1{font-size:20px;margin:0 0 4px}.meta{color:#999;font-size:13px;margin:0 0 24px}.m{margin:0 0 20px}.user{background:#262626;border-radius:12px;padding:10px 14px;margin-inline-start:15%}.who{font-size:12px;color:#999;margin:0 0 4px}pre{background:#0b101a;border:1px solid #333;border-radius:8px;padding:10px;overflow-x:auto;white-space:pre;direction:ltr;text-align:left;font:13px ui-monospace,monospace}.files{font-size:13px;color:#bbb}code{font:13px ui-monospace,monospace;background:rgba(127,127,127,.18);border-radius:4px;padding:1px 4px}p{margin:0 0 8px;overflow-wrap:anywhere}@media(prefers-color-scheme:light){body{background:#fff;color:#1b1b1b}.user{background:#f1f1f1}pre{background:#f6f8fa;border-color:#ddd}}`;
  const he = s?.lang === "he";
  const T = (h: string, e: string) => (he ? h : e);
  const head = (title: string) => `<!doctype html><html lang="${he ? "he" : "en"}" dir="${he ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${css}</style></head>`;
  if (!s) return `${head("Not shared")}<body><main><h1>This link is no longer shared</h1><p class="meta">It was revoked or it expired. Ask the person who sent it for a new one.</p></main></body></html>`;
  const msgs = s.messages
    .map((m) => `<section class="m ${m.role}"><p class="who">${m.role === "user" ? T("שאלה", "Question") : T("תשובה", "Answer")}</p>${m.files?.length ? `<p class="files">📎 ${m.files.map(esc).join(", ")}</p>` : ""}${body(m.text)}</section>`)
    .join("");
  return `${head(s.title)}<body><main><h1 dir="auto">${esc(s.title)}</h1><p class="meta">${T("שותף מקשר", "Shared from KesherAI")} · ${esc(s.updatedAt.slice(0, 10))} · ${T("לקריאה בלבד", "read-only")}</p>${msgs}</main></body></html>`;
}
