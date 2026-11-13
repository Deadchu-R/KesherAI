/**
 * A code session's pull request on GitHub (like Claude Code's desktop PR view): find or open the PR for the
 * session's branch, its checks, the log of a failed check (for "Fix failing checks"), and merging.
 * Uses the GitHub account connected in KesherAI (its token); without one, the page offers GitHub's own
 * "compare" link instead of opening the PR itself.
 */

/** A pull request as the page shows it. */
export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: string;
  base: string;
  sha: string;
}

/** A commit's checks (GitHub Actions runs) and their overall state. */
export interface Checks {
  /** none: no checks; pending: some running; success; failure. */
  state: "none" | "pending" | "success" | "failure";
  runs: Array<{ id: number; name: string; status: string; conclusion: string | null; url: string }>;
}

type Fetch = typeof fetch;

/** GitHub's REST API with the connected account's token. */
export class GitHubApi {
  /**
   * @param token - The connected account's token, read on each call.
   * @param f - fetch (a fake in tests).
   */
  constructor(
    private token: () => string | undefined,
    private f: Fetch = fetch,
  ) {}

  /** Whether an account is connected (a token to open PRs and merge with). */
  get connected(): boolean {
    return !!this.token();
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = this.token();
    const res = await this.f(`https://api.github.com${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "KesherAI",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const msg = ((await res.json().catch(() => ({}))) as { message?: string }).message;
      throw Object.assign(new Error(`GitHub: ${msg ?? res.statusText} (${res.status})`), { status: res.status });
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** The repo's default branch (where a PR goes by default). */
  async defaultBranch(slug: string): Promise<string> {
    return (await this.call<{ default_branch?: string }>(`/repos/${slug}`)).default_branch ?? "main";
  }

  /** The newest PR from a branch (open first), or undefined. */
  async prFor(slug: string, branch: string): Promise<PrInfo | undefined> {
    const owner = slug.split("/")[0]!;
    const list = await this.call<RawPr[]>(`/repos/${slug}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`);
    const pick = list.find((p) => p.state === "open") ?? list[0];
    return pick ? toPr(pick) : undefined;
  }

  /** Opens a PR. */
  async createPr(slug: string, o: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PrInfo> {
    return toPr(await this.call<RawPr>(`/repos/${slug}/pulls`, { method: "POST", body: { ...o, draft: !!o.draft } }));
  }

  /** The checks (GitHub Actions runs) of a commit, and their overall state. */
  async checks(slug: string, sha: string): Promise<Checks> {
    const data = await this.call<{ workflow_runs?: Array<{ id: number; name?: string; status?: string; conclusion?: string | null; html_url?: string }> }>(`/repos/${slug}/actions/runs?head_sha=${sha}&per_page=30`);
    const runs = (data.workflow_runs ?? []).map((w) => ({ id: w.id, name: w.name ?? "", status: w.status ?? "", conclusion: w.conclusion ?? null, url: w.html_url ?? "" }));
    return { runs, state: checksState(runs) };
  }

  /**
   * The end of the log of each failed job in a run (for the model to fix).
   *
   * @returns Text: "## <job>\n<last lines>" for each failed job, short enough for a chat message.
   */
  async failedLogs(slug: string, runId: number, maxPerJob = 6000): Promise<string> {
    const jobs = await this.call<{ jobs?: Array<{ id: number; name: string; conclusion: string | null }> }>(`/repos/${slug}/actions/runs/${runId}/jobs?per_page=50`);
    const failed = (jobs.jobs ?? []).filter((j) => j.conclusion === "failure").slice(0, 3);
    const parts: string[] = [];
    for (const j of failed) {
      const token = this.token();
      // The log is a redirect to a file; fetch follows it.
      const res = await this.f(`https://api.github.com/repos/${slug}/actions/jobs/${j.id}/logs`, {
        headers: { "user-agent": "KesherAI", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
      const text = res?.ok ? await res.text() : "(the log could not be read)";
      parts.push(`## ${j.name}\n${cleanLog(text).slice(-maxPerJob)}`);
    }
    return parts.join("\n\n");
  }

  /** Merges a PR (squash by default). */
  async merge(slug: string, n: number, method: "squash" | "merge" | "rebase" = "squash"): Promise<void> {
    await this.call(`/repos/${slug}/pulls/${n}/merge`, { method: "PUT", body: { merge_method: method } });
  }
}

interface RawPr {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  merged_at?: string | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

function toPr(p: RawPr): PrInfo {
  return { number: p.number, url: p.html_url, title: p.title, state: p.merged_at ? "merged" : p.state, draft: !!p.draft, head: p.head.ref, base: p.base.ref, sha: p.head.sha };
}

/** The overall state of a commit's checks. */
export function checksState(runs: Array<{ status: string; conclusion: string | null }>): Checks["state"] {
  if (!runs.length) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return runs.some((r) => r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion)) ? "failure" : "success";
}

/** A job log without its timestamps and colour codes. */
export function cleanLog(text: string): string {
  // eslint-disable-next-line no-control-regex -- the log's colour codes
  return text.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "").replace(/\u001b\[[0-9;]*m/g, "");
}

/** GitHub's own page to open a PR, for when no account is connected. */
export function compareUrl(slug: string, base: string, head: string): string {
  return `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

/** What the model is asked for a PR's title and body. */
export function prPrompt(log: string, stat: string): string {
  return `Write a pull request for these commits.\n\nCommits:\n${log.slice(0, 6000)}\n\nFiles changed:\n${stat.slice(0, 4000)}\n\nAnswer in exactly this form:\nTITLE: <one line, under 70 characters>\nBODY:\n<what changed and why, as a few short bullet points; how it was tested if the commits say>`;
}

/** Splits the model's answer into a title and a body. */
export function parsePrText(text: string): { title: string; body: string } {
  const t = /TITLE:\s*(.+)/i.exec(text)?.[1]?.trim() ?? text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  const b = /BODY:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim() ?? "";
  return { title: t.replace(/^["'`]|["'`]$/g, "").slice(0, 120), body: b.slice(0, 20_000) };
}
