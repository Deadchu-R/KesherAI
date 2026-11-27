/**
 * "Agents' work" on the PC: reads the project's own git (the task inbox already fetches it) for commits on
 * origin/main with a `Claude-Session:` trailer of the last 7 days (shared/claude-work.ts). No GitHub token and no
 * model. The answer is cached by origin/main's HEAD and the day, so the list costs one `git log` per new commit.
 */
import { CLAUDE_LOG_FORMAT, CLAUDE_WORK_DAYS, commitUrl, groupClaudeSessions, parseClaudeLog, type ClaudeSession } from "@kesher/shared";
import type { GitRun } from "./external-agents.js";

/** What the route returns: the sessions (newest first), and each commit's GitHub page when the remote is github.com. */
export interface ClaudeWork {
  sessions: Array<Omit<ClaudeSession, "commits"> & { commits: Array<ClaudeSession["commits"][number] & { url?: string }> }>;
  /** When the list was read (ms). */
  at: number;
  days: number;
}

/** Reads and caches the list for one project. */
export class ClaudeWorkReader {
  private cache?: { key: string; value: ClaudeWork };

  /**
   * @param git - The project's git runner, or undefined when no project is set.
   * @param now - The clock (tests).
   */
  constructor(private readonly git: () => GitRun | undefined, private readonly now: () => number = Date.now) {}

  /** The sessions of the last {@link CLAUDE_WORK_DAYS} days; an empty list when there is no project or git fails. */
  async read(): Promise<ClaudeWork> {
    const git = this.git();
    const now = this.now();
    const empty: ClaudeWork = { sessions: [], at: now, days: CLAUDE_WORK_DAYS };
    if (!git) return empty;
    try {
      const head = (await git(["rev-parse", "origin/main"])).trim();
      const key = `${head}|${new Date(now).toDateString()}`;
      if (this.cache?.key === key) return this.cache.value;
      // A little more than the window: the log is cut by the time of each commit, and the releases after it are newer.
      const log = await git(["log", "origin/main", `--since=${CLAUDE_WORK_DAYS + 1}.days.ago`, `--format=${CLAUDE_LOG_FORMAT}`, "--name-only"]);
      const remote = (await git(["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
      const sessions = groupClaudeSessions(parseClaudeLog(log), now).map((s) => ({ ...s, commits: s.commits.map((c) => ({ ...c, ...(commitUrl(remote, c.sha) ? { url: commitUrl(remote, c.sha) } : {}) })) }));
      const value: ClaudeWork = { sessions, at: now, days: CLAUDE_WORK_DAYS };
      this.cache = { key, value };
      return value;
    } catch {
      return empty;
    }
  }
}
