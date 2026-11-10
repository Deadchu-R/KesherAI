import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";

/** Something an agent waits for the user to approve, wherever it runs. */
export interface InboxApproval {
  /** "chat": a conversation in this app; "self-work": the run in the worker (its own chats). */
  kind: "chat" | "self-work";
  conversationId: string;
  title: string;
  requestId: string;
  tool: string;
  preview: string;
  reason: string;
  purpose?: string;
  at: string;
}

/**
 * Notifications in the app: everything waiting for approval (chats and self-work, which runs in its own
 * worker and so was missing from "Watch and approve") with Allow / Deny, and the latest notifications that
 * went out (the same ones the phone and this computer got).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function inboxRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const fromWorker = async (): Promise<InboxApproval[]> => {
    const url = s.workerHost?.url();
    if (!url) return [];
    try {
      const r = await fetch(`${url}/api/approvals`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return [];
      const list = (await r.json()) as Array<Omit<InboxApproval, "kind">>;
      return Array.isArray(list) ? list.map((p) => ({ ...p, kind: "self-work" as const, title: p.title || "Self-work" })) : [];
    } catch {
      return [];
    }
  };
  /** Chats here first, then self-work; each list oldest first. */
  const approvals = async (): Promise<InboxApproval[]> => {
    const here = s.conversations.pendingApprovals().map((p) => ({ ...p, kind: (s.selfWork?.current?.convId === p.conversationId ? "self-work" : "chat") as InboxApproval["kind"] }));
    return [...here, ...(await fromWorker())].sort((a, b) => a.at.localeCompare(b.at));
  };

  /** Everything waiting for the user's approval, in every conversation and the self-work run. */
  app.get("/api/approvals", async () => approvals());

  /** The notifications page: approvals and the last notifications (newest first; bodies as they were sent). */
  app.get("/api/inbox", async () => ({
    approvals: await approvals(),
    notes: s.notifier.sent
      .slice()
      .reverse()
      .map((n) => ({ title: n.title, body: n.body, path: n.path, at: n.at, channels: n.channels, ...(n.resolved ? { resolved: n.resolved } : {}) })),
  }));

  /** Allow or deny one approval from the notifications page (or the phone app). */
  app.post<{ Body: { kind?: string; conversationId?: string; requestId?: string; decision?: string } }>("/api/inbox/answer", async (req, reply) => {
    const b = req.body ?? {};
    const requestId = String(b.requestId ?? "");
    const decision = b.decision === "allow" ? "allow" : "deny";
    if (!/^[\w-]{8,64}$/.test(requestId)) return reply.code(400).send({ error: "Which request?" });
    const conversationId = String(b.conversationId ?? "");
    if (b.kind === "self-work" && s.workerHost?.url()) {
      const r = await fetch(`${s.workerHost.url()}/api/self-work/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (!r) return reply.code(502).send({ error: "Self-work did not answer. Is it still running?" });
      if (!r.ok) return reply.code(r.status).send(await r.json().catch(() => ({ error: "That request is no longer waiting." })));
      return { ok: true };
    }
    const opened = conversationId ? await s.conversations.open(conversationId) : undefined;
    if (!opened?.session.approve(requestId, decision)) return reply.code(404).send({ error: "That request is no longer waiting." });
    return { ok: true };
  });
}
