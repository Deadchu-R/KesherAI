/**
 * The Claude connector's tools on KesherAI's own MCP server (`/mcp`, used by the Claude Desktop extension): the same
 * names, arguments and answers as the hub's connector (apps/hub/src/mcp.ts), answered by the same desk (hub-connector.ts)
 * with the same allow-list, rate limit, scrub and opt-in ("Claude connector may read and run", Settings › Kesher Cloud).
 * With the opt-in off every tool says so, as the hub's do. Nothing here reaches approvals (the server's own
 * `kesher_approve` does that, behind its own switch), settings or files.
 */
import { agentsText, parseConnectorQuery, quotasText, taskText, tasksText, CONNECTOR_ACTIONS, CONNECTOR_EXECUTORS, type ConnectorAnswer, type ConnectorQuery } from "@kesher/shared";
import { randomUUID } from "node:crypto";

/** One tool of the MCP server (the shape routes/mcp-server.ts lists and calls). */
export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<Array<{ type: "text"; text: string }>>;
}

/** Asks the PC's connector desk (HubClient.askConnector); undefined when the hub client does not exist. */
export type ConnectorAsk = (q: ConnectorQuery) => Promise<ConnectorAnswer>;

const READ_ONLY = { readOnlyHint: true };
const TASK_ID = { type: "string", description: "The task's id (from kesher_tasks).", pattern: "^[\\w-]{1,64}$" } as const;

/**
 * Asks the desk one question and turns its answer into text.
 *
 * @param ask - The desk.
 * @param query - The query without `queryId` and `at` (made here, then checked like the hub's).
 * @param shape - The answer's text.
 * @returns The text, or an error in words (thrown) when the request is not allowed or the desk refuses.
 */
async function viaDesk(ask: ConnectorAsk | undefined, query: Record<string, unknown>, shape: (a: ConnectorAnswer) => string): Promise<Array<{ type: "text"; text: string }>> {
  if (!ask) throw new Error("KesherAI's task inbox is not available yet; try again in a moment.");
  const q = parseConnectorQuery({ ...query, queryId: randomUUID(), at: Date.now() });
  if (!q) throw new Error("That request is not allowed.");
  const a = await ask(q);
  if (!a.ok) throw new Error(a.text ?? "KesherAI refused.");
  return [{ type: "text", text: shape(a) }];
}

/**
 * The connector's tools for the local MCP server.
 *
 * @param ask - The PC's connector desk.
 * @returns kesher_tasks, kesher_task, kesher_add_task, kesher_task_action, kesher_quotas, kesher_agents.
 */
export function connectorTools(ask: ConnectorAsk | undefined): ConnectorTool[] {
  return [
    {
      name: "kesher_tasks",
      description: "Lists KesherAI's task inbox: id, title, state, executor, queue place and steps. filter: open (waiting/queued), running, ended, or all (default). Needs \"Claude connector may read and run\" (KesherAI › Settings › Kesher Cloud).",
      inputSchema: { type: "object", properties: { filter: { type: "string", enum: ["open", "running", "ended", "all"] }, executor: { type: "string", description: "Only this executor's tasks: antigravity, local, opencode, ghostcli, gemini, claude." } }, additionalProperties: false },
      annotations: READ_ONLY,
      run: (args) => viaDesk(ask, { op: "tasks", filter: args.filter, executor: args.executor }, (a) => tasksText(a.tasks ?? [])),
    },
    {
      name: "kesher_task",
      description: "One task of KesherAI's inbox in full: state, executor, model, branch, steps so far, the latest steps, and its result or why it failed.",
      inputSchema: { type: "object", properties: { taskId: TASK_ID }, required: ["taskId"], additionalProperties: false },
      annotations: READ_ONLY,
      run: (args) => viaDesk(ask, { op: "task", taskId: args.taskId }, (a) => (a.task ? taskText(a) : a.text ?? "No such task.")),
    },
    {
      name: "kesher_add_task",
      description: "Adds a task to KesherAI's inbox, as its \"+ Task\" does. executor auto (default) lets KesherAI pick; antigravity waits for Run.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", maxLength: 200 }, goal: { type: "string", description: "What to do and how to check it (up to 6000 characters).", maxLength: 6000 }, executor: { type: "string", enum: [...CONNECTOR_EXECUTORS] } },
        required: ["title", "goal"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: (args) => viaDesk(ask, { op: "add", title: args.title, goal: args.goal, executor: args.executor }, (a) => (a.task ? `${a.text ?? "Added."}\n${taskText(a)}` : a.text ?? "Added.")),
    },
    {
      name: "kesher_task_action",
      description: "Does what the task buttons do: run (start it now), queue / unqueue (its executor's line), stop (stops a running task, cancels a waiting one), assign (give it to another executor: to).",
      inputSchema: {
        type: "object",
        properties: {
          taskId: TASK_ID,
          action: { type: "string", enum: [...CONNECTOR_ACTIONS] },
          to: { type: "string", description: "assign only: antigravity, local, opencode, ghostcli, gemini, claude or claude-code." },
          confirm: { type: "boolean", description: "assign only: yes to stopping a running task (or re-running an ended one) first." },
        },
        required: ["taskId", "action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: (args) => viaDesk(ask, { op: "action", taskId: args.taskId, action: args.action, to: args.to, confirm: args.confirm }, (a) => a.text ?? "Done."),
    },
    {
      name: "kesher_quotas",
      description: "What is left of each provider KesherAI's agents use (Antigravity, GhostCLI, OpenCode Go, Gemini, Claude, the local model): share or count left per window, and when it fills again.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      run: () => viaDesk(ask, { op: "quotas" }, (a) => quotasText(a.quotas ?? [])),
    },
    {
      name: "kesher_agents",
      description: "KesherAI's agents (local model, Antigravity, OpenCode Go, GhostCLI…): on/off/busy, and the task each works on with its last step.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      run: () => viaDesk(ask, { op: "agents" }, (a) => agentsText(a.agents ?? [])),
    },
  ];
}
