/**
 * KesherAI's own fault log, so it can look into its problems (asked for: "investigate its own faults"): server
 * errors, chats that failed, and other failures, one JSON line each in logs/faults.jsonl on this computer. Kept
 * small (about 1 MB, then the older half goes) and cleaned of secrets and the user's home path before writing.
 */
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

/** One fault. */
export interface Fault {
  at: string;
  kind: "server" | "chat" | "engine" | "other";
  /** Where: a route, a chat's title, an engine. */
  where: string;
  message: string;
  chatId?: string;
}

const MAX_BYTES = 1024 * 1024;

/**
 * Removes secrets (keys, tokens, passwords in addresses) and the home folder's path from a text.
 *
 * @param text - Anything about to be logged.
 */
export function redact(text: string, home = homedir()): string {
  let t = text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-…")
    .replace(/\b(ghp|gho|ghu|ghs|github_pat|hf|xox[abp])_[A-Za-z0-9_]{8,}/g, "$1_…")
    .replace(/\b(Bearer|token|apikey|api_key|key|password|secret)([=: ]+)[^\s&"']{4,}/gi, "$1$2…")
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1…@");
  if (home && home.length > 3) t = t.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
  return t.slice(0, 2000);
}

/** The fault log file. */
export class FaultLog {
  private writes: Promise<void> = Promise.resolve();

  /** @param file - logs/faults.jsonl in KesherAI's data folder. */
  constructor(private file: string) {}

  /** Writes a fault (never throws; logging must not break anything). */
  add(f: Omit<Fault, "at">): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind: f.kind, where: redact(f.where).slice(0, 200), message: redact(f.message), ...(f.chatId ? { chatId: f.chatId } : {}) })}\n`;
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const size = await stat(this.file).then((s) => s.size, () => 0);
        if (size > MAX_BYTES) await rename(this.file, `${this.file}.old`);
        await appendFile(this.file, line);
      })
      .catch(() => undefined);
  }

  /**
   * The latest faults, newest first.
   *
   * @param o.limit - At most this many (default 40).
   * @param o.chatId - Only this chat's.
   */
  async recent(o: { limit?: number; chatId?: string } = {}): Promise<Fault[]> {
    await this.writes;
    const text = await readFile(this.file, "utf8").catch(() => "");
    const out: Fault[] = [];
    for (const line of text.split("\n").reverse()) {
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line) as Fault;
        if (o.chatId && f.chatId !== o.chatId) continue;
        out.push(f);
        if (out.length >= (o.limit ?? 40)) break;
      } catch {
        /* a cut line */
      }
    }
    return out;
  }
}
