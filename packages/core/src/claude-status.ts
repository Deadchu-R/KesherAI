/**
 * "Running now" on the PC: reads `claude/agents.json` from the local `origin/claude-status` ref (the task inbox's fetch
 * brings it; no network, no token, no model here) and checks it (shared/claude-status.ts). The answer is cached by the
 * file's blob sha, so a poll costs one `git rev-parse` until the lead writes again.
 */
import { CLAUDE_STATUS_FILE, CLAUDE_STATUS_REF, parseClaudeStatus, type ClaudeAgentStatus } from "@kesher/shared";
import type { GitRun } from "./external-agents.js";

/** What the route and the hub report carry. */
export interface ClaudeRunning {
  agents: ClaudeAgentStatus[];
  /** The file's own `updatedAt` (ms); 0 when there is no file. */
  updatedAt: number;
}

/** Reads and caches the status file for one project. */
export class ClaudeStatusReader {
  private cache?: { sha: string; value: ClaudeRunning };

  /** @param git - The project's git runner, or undefined when no project is set. */
  constructor(private readonly git: () => GitRun | undefined) {}

  /** The agents in the file; an empty list when there is no project, no branch yet, bad JSON or git fails. */
  async read(): Promise<ClaudeRunning> {
    const empty: ClaudeRunning = { agents: [], updatedAt: 0 };
    const git = this.git();
    if (!git) return empty;
    try {
      const sha = (await git(["rev-parse", "--verify", "--quiet", `${CLAUDE_STATUS_REF}:${CLAUDE_STATUS_FILE}`])).trim();
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) return empty;
      if (this.cache?.sha === sha) return this.cache.value;
      const file = parseClaudeStatus(await git(["show", `${CLAUDE_STATUS_REF}:${CLAUDE_STATUS_FILE}`]));
      const value: ClaudeRunning = file ? { agents: file.agents, updatedAt: file.updatedAt } : empty;
      this.cache = { sha, value };
      return value;
    } catch {
      return empty;
    }
  }
}
