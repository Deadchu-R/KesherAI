import type { FastifyInstance } from "fastify";
import { claudeWindowPercent } from "@kesher/shared";
import type { ClaudeUsageWatch } from "../claude-usage.js";

/**
 * The Claude plan's usage on this PC (claude-usage.ts): the last reading, and "check now".
 * Both work from the phone and the hub too: they only read the plan's percents (no prompt text, no account data).
 *
 * @param app - Fastify instance.
 * @param watch - The usage watch.
 */
export async function claudeUsageRoutes(app: FastifyInstance, watch: ClaudeUsageWatch): Promise<void> {
  const view = (q: Awaited<ReturnType<ClaudeUsageWatch["read"]>>, now = Date.now()) => ({
    at: q?.at,
    fiveHour: q?.fiveHour ? { percent: claudeWindowPercent(q.fiveHour, now), resetsAt: q.fiveHour.resetsAt } : undefined,
    sevenDay: q?.sevenDay ? { percent: claudeWindowPercent(q.sevenDay, now), resetsAt: q.sevenDay.resetsAt } : undefined,
  });
  /** The last reading (a check or a real Claude run). */
  app.get("/api/claude/usage", async () => view(await watch.read()));
  /** Checks now (one very short answer on the smallest model; at most once every 10 minutes). */
  app.post("/api/claude/usage/check", async () => {
    const r = await watch.check(true);
    return { ok: r.ok, ...(r.why ? { why: r.why } : {}), ...view(r.quota) };
  });
}
