/**
 * The plain-text answers of the Claude connector's tools (what the model reads; the views draw the same data).
 * Shared by the hub's MCP server (apps/hub/src/mcp.ts) and KesherAI's own MCP server (the Claude Desktop extension),
 * so Claude sees the same words from both. Plain data in, a string out; no Node or browser API.
 */
import type { ConnectorAgent, ConnectorApproval, ConnectorTaskRow } from "./hub-connector.js";
import type { ConnectorAnswer } from "./hub-connector.js";
import type { ProviderQuota } from "./provider-quotas.js";

/**
 * The task list: one line per task.
 *
 * @param tasks - The rows.
 * @returns The lines, or "No tasks match."
 */
export function tasksText(tasks: readonly ConnectorTaskRow[]): string {
  return tasks.length ? tasks.map((t) => `${t.taskId} [${t.state}] ${t.title} (${t.executor}${t.queuePos ? `, #${t.queuePos} in line` : ""}${t.steps ? `, step ${t.steps}${t.estSteps ? ` of ~${t.estSteps}` : ""}` : ""})`).join("\n") : "No tasks match.";
}

/**
 * One task: a line of facts, the result, and the newest steps.
 *
 * @param a - An answer that holds a task.
 * @returns The text.
 */
export function taskText(a: ConnectorAnswer): string {
  const t = a.task!;
  const head = `${t.taskId} [${t.state}] ${t.title} (${[t.executor, t.model, t.branch, t.steps ? `step ${t.steps}${t.estSteps ? ` of ~${t.estSteps}` : ""}` : ""].filter(Boolean).join(", ")})`;
  const steps = t.stepLog.map((s) => `- ${s.tool}${s.target ? ` ${s.target}` : ""}${s.error ? " (failed)" : ""}`);
  return [head, t.result || t.cause ? `Result: ${t.result ?? t.cause}` : "", steps.length ? `Latest steps:\n${steps.join("\n")}` : ""].filter(Boolean).join("\n");
}

/**
 * What is left of each provider.
 *
 * @param quotas - The PC's quotas.
 * @returns One line per provider.
 */
export function quotasText(quotas: readonly ProviderQuota[]): string {
  return quotas.map((q) => `${q.name}: ${q.state}${q.bars.map((b) => ` · ${b.label} ${typeof b.left === "number" ? `${Math.round(b.left * 100)}% left` : typeof b.used === "number" ? `${b.used}${b.limit ? `/${b.limit}` : ""} used` : "?"}${b.resetAt ? ` (back ${new Date(b.resetAt).toISOString().slice(0, 16)}Z)` : ""}`).join("")}`).join("\n") || "No quotas reported.";
}

/**
 * The agents and the task each works on.
 *
 * @param agents - The PC's agents.
 * @returns One line per agent.
 */
export function agentsText(agents: readonly ConnectorAgent[]): string {
  return agents.map((g) => `${g.kind} ${g.state}${g.label ? ` (${g.label})` : ""}${g.task ? ` → ${g.task.taskId} ${g.task.title}${g.task.now ? ` · last step: ${g.task.now.tool}${g.task.now.target ? ` ${g.task.now.target}` : ""}` : ""}` : ""}`).join("\n") || "No agents reported.";
}

/**
 * The approval cards waiting, with what each would do.
 *
 * @param items - The waiting cards.
 * @param canAnswer - Whether the PC lets the connector answer them.
 * @returns The text.
 */
export function approvalsText(items: readonly ConnectorApproval[], canAnswer: boolean | undefined): string {
  if (!items.length) return "Nothing waits for approval.";
  const lines = items.map((a) => `${a.requestId} (chat ${a.conversationId}) ${a.tool}${a.who ? ` by ${a.who}` : ""} · ${a.reason}${a.locked ? " [only the user may allow this, in KesherAI]" : ""}\n${a.preview}`);
  return [...lines, canAnswer === false ? "The PC does not let the connector answer these (KesherAI › Settings › Use KesherAI from other apps › let the connected app answer approval cards)." : ""].filter(Boolean).join("\n\n");
}
