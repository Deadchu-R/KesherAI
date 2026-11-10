import type { FastifyInstance, FastifyReply } from "fastify";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { cleanMessage, commitPrompt, git, gitBranches, gitCommit, gitDiff, gitPull, gitPush, gitState, gitSwitch, recentMessages } from "../git-panel.js";

/**
 * The code page's Changes panel: the project's git state, a diff per file, a
 * commit message written by the chat's model, commit, push, pull and
 * branches, and the GitHub Actions runs of a commit. Only on a code chat's own
 * project folder (looked up from the chat, never a path from the request), so
 * the phone can use it too.
 */
export async function gitRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const repoOf = async (id: string, reply: FastifyReply): Promise<{ repo: string; modelId?: string } | undefined> => {
    const c = await s.library.getConversation(id);
    const repo = c ? s.conversations.workspaceOf(c) : undefined;
    if (!c || !repo) {
      void reply.code(404).send({ error: "This chat has no project folder." });
      return undefined;
    }
    return { repo, ...(c.modelId ? { modelId: c.modelId } : {}) };
  };
  // One git write at a time per project (a double tap on the phone must not commit twice).
  const busy = new Set<string>();
  const once = async <T>(repo: string, reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.has(repo)) {
      void reply.code(409).send({ error: "Git is still busy with the last step." });
      return undefined;
    }
    busy.add(repo);
    try {
      return await fn();
    } finally {
      busy.delete(repo);
    }
  };

  app.get<{ Params: { id: string } }>("/api/conversations/:id/git", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    return r ? gitState(r.repo) : undefined;
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; untracked?: string } }>("/api/conversations/:id/git/diff", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    if (!r) return;
    const path = String(req.query.path ?? "");
    if (path.length > 1000 || path.startsWith("-")) return reply.code(400).send({ error: "Which file?" });
    if (req.query.untracked === "1") {
      // `git diff --no-index` reads any path, so only a new file git itself lists in this project (scan 38).
      const state = await gitState(r.repo);
      if (!state.files.some((f) => f.state === "?" && f.path === path)) return reply.code(400).send({ error: "That is not a new file in this project." });
      return gitDiff(r.repo, path, true);
    }
    return gitDiff(r.repo, path || undefined);
  });

  app.post<{ Params: { id: string }; Body: { model?: string } }>("/api/conversations/:id/git/message", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    if (!r) return;
    const model = (typeof req.body?.model === "string" && req.body.model) || r.modelId || s.config.activeModels.codeInline;
    if (!model) return reply.code(400).send({ error: "Choose a model for this chat first." });
    const [{ diff }, recent] = await Promise.all([gitDiff(r.repo), recentMessages(r.repo)]);
    const state = await gitState(r.repo);
    const untracked = state.files.filter((f) => f.state === "?").map((f) => `new file: ${f.path} (${f.added} lines)`);
    if (!diff.trim() && !untracked.length) return reply.code(400).send({ error: "Nothing to commit." });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 120_000);
    req.raw.on("close", () => stop.abort());
    try {
      const res = await modelTurnFor(s.registry, model)({ messages: [{ role: "user", content: commitPrompt([diff, ...untracked].join("\n"), recent) }], tools: [] }, stop.signal, () => undefined);
      const message = cleanMessage(res.text);
      return message ? { message, model } : reply.code(502).send({ error: "The model wrote no message." });
    } catch (err) {
      return reply.code(502).send({ error: stop.signal.aborted ? "The model took too long." : (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>("/api/conversations/:id/git/commit", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    if (!r) return;
    const message = String(req.body?.message ?? "");
    if (!message.trim() || message.length > 20_000) return reply.code(400).send({ error: "Write a commit message." });
    return once(r.repo, reply, () => gitCommit(r.repo, message));
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/git/push", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    return r ? once(r.repo, reply, () => gitPush(r.repo)) : undefined;
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/git/pull", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    return r ? once(r.repo, reply, () => gitPull(r.repo)) : undefined;
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/git/branches", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    return r ? gitBranches(r.repo) : undefined;
  });

  app.post<{ Params: { id: string }; Body: { name?: string; create?: boolean } }>("/api/conversations/:id/git/switch", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    if (!r) return;
    const name = String(req.body?.name ?? "").trim();
    return once(r.repo, reply, () => gitSwitch(r.repo, name, req.body?.create === true));
  });

  // The GitHub Actions runs of a commit (after a push), with the connected GitHub account's token.
  app.get<{ Params: { id: string }; Querystring: { sha?: string } }>("/api/conversations/:id/git/runs", async (req, reply) => {
    const r = await repoOf(req.params.id, reply);
    if (!r) return;
    const state = await gitState(r.repo);
    if (!state.github) return { runs: [], reason: "not-github" };
    const token = s.github.token();
    const sha = String(req.query.sha ?? "");
    if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) return reply.code(400).send({ error: "Which commit?" });
    const full = sha || (await git(r.repo, ["rev-parse", "HEAD"])).out.trim();
    const res = await fetch(`https://api.github.com/repos/${state.github}/actions/runs?head_sha=${full}&per_page=20`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    if (!res?.ok) return { runs: [], reason: res?.status === 404 ? (token ? "no-access" : "connect-github") : "offline" };
    const data = (await res.json()) as { workflow_runs?: Array<{ id: number; name?: string; status?: string; conclusion?: string | null; html_url?: string; head_branch?: string; created_at?: string }> };
    return {
      runs: (data.workflow_runs ?? []).map((w) => ({ id: w.id, name: w.name ?? "", status: w.status ?? "", conclusion: w.conclusion ?? null, url: w.html_url ?? "", branch: w.head_branch ?? "", at: w.created_at ?? "" })),
    };
  });
}
