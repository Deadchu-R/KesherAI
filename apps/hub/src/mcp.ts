/**
 * The hub's remote MCP server (Streamable HTTP, JSON answers only): the tools Claude gets when the owner adds the hub
 * as a custom connector. Claude stays the lead; the hub is its hands for what the hub itself can see and do.
 *
 * End-to-end encryption stays whole: the hub holds no key that opens a device's messages, so every read tool returns
 * metadata the hub already keeps (devices, the agents they report, waiting counts, queued task ids) plus a link to the
 * hub page, where the owner's browser opens the sealed content. `send_task` is sealed by the hub with its own key (see
 * {@link Hub.sendConnectorTask}). Every call is written to the hub's activity log (tool name and connection only).
 */
import { CONNECTOR_ACTIONS, CONNECTOR_EXECUTORS, mapConnectorText, redactLeaks, type ConnectorAnswer } from "../../../packages/shared/src/hub.js";
import { MCP_APP_MIME, VIEW_URIS, VIEWS } from "./connector-views.js";
import { scrubSecrets } from "./diag.js";
import type { Hub } from "./hub.js";

/** MCP protocol versions this server speaks, newest first. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** A JSON-RPC answer. */
type RpcAnswer = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const rpcError = (id: string | number | null, code: number, message: string): RpcAnswer => ({ jsonrpc: "2.0", id, error: { code, message } });

/** A tool's text and structured answer (MCP `CallToolResult`). */
function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: data };
}

/** A tool's error in words (the model reads it and can try again; not a protocol error). */
function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

/** Why content is not here: said in each read tool's answer, so the model tells the owner where to look. */
const SEALED_NOTE = "Task text, results, approvals and agent steps are end-to-end encrypted between KesherAI's devices; the hub cannot read them. Open the link to see them on the hub page (the browser decrypts).";

const DEVICE_ARG = { type: "string", description: "The PC's id or name (optional when one PC lets the connector in)." } as const;
const TASK_ID_ARG = { type: "string", description: "The task's id (from kesher_tasks).", pattern: "^[\\w-]{1,64}$" } as const;

/** The tools, as `tools/list` returns them. */
export const MCP_TOOLS = [
  {
    name: "list_devices",
    title: "List devices",
    description: "The owner's paired KesherAI devices on the hub: name, kind (pc, phone, claude-chat), online, last seen, busy, version, and what each PC accepts (tasks, local-model tasks, Antigravity tasks).",
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
  },
  {
    name: "get_agent_status",
    title: "Agent status",
    description: "The agents each device reports (local model, Antigravity, vendor sessions such as Claude Remote Control): kind, on/off/busy and label, and whether the device is busy. Live steps are encrypted: the answer links to the hub page's Agents tab.",
    inputSchema: { type: "object", properties: { device: { type: "string", description: "A device's id or name (optional; all devices when empty)." } }, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "waiting_for_approval",
    title: "Waiting for approval",
    description: "How many things wait for the owner's approval or Run press on each PC (the count each PC last reported). What waits is encrypted: the answer links to the hub page, where the owner approves.",
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description: "What the hub can see of tasks: sealed task messages still waiting for each PC, and the tasks sent through this connector (id, PC, executor, time, whether the PC took it). Titles, status and results are encrypted: the answer links to the hub page's Tasks tab.",
    inputSchema: NO_INPUT,
    annotations: READ_ONLY,
  },
  {
    name: "send_task",
    title: "Send a task to a PC",
    description:
      "Sends a task to one of the owner's PCs, sealed to it. The PC adds it to its task board as 'from the cloud hub'. executor 'pc-antigravity' (default) waits for the owner's Run press; 'pc-local' runs on the PC's local model. Only a PC that opted in to that kind of task takes it. The result shows on the PC and the hub page, not here.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (up to 200 characters).", maxLength: 200 },
        spec: { type: "string", description: "What to do, in full (up to 8000 characters).", maxLength: 8000 },
        device: { type: "string", description: "The PC's id or name (optional when only one PC takes this kind of task)." },
        executor: { type: "string", enum: ["pc-antigravity", "pc-local"], description: "Who does it on the PC (default pc-antigravity)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  // ---- through the PC (hub-connector.ts): only while the PC's "Claude connector may read and run" is on ----
  {
    name: "kesher_tasks",
    title: "Task inbox",
    description: "Lists the PC's task inbox: id, title, state, executor, queue place and steps. filter: open (waiting/queued), running, ended, or all (default). Needs the PC's \"Claude connector may read and run\" setting.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["open", "running", "ended", "all"], description: "Which tasks (default all)." },
        executor: { type: "string", description: "Only this executor's tasks: antigravity, local, opencode, ghostcli, gemini, claude." },
        device: DEVICE_ARG,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: VIEW_URIS.board } },
  },
  {
    name: "kesher_task",
    title: "One task",
    description: "One task of the PC's inbox in full: state, executor, model, branch, steps so far, the latest steps, and its result or why it failed.",
    inputSchema: { type: "object", properties: { taskId: TASK_ID_ARG, device: DEVICE_ARG }, required: ["taskId"], additionalProperties: false },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: VIEW_URIS.task } },
  },
  {
    name: "kesher_add_task",
    title: "Add a task",
    description: "Adds a task to the PC's task inbox, as the app's \"+ Task\" does. executor auto (default) lets the PC pick; antigravity waits for Run.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (up to 200 characters).", maxLength: 200 },
        goal: { type: "string", description: "What to do and how to check it (up to 6000 characters).", maxLength: 6000 },
        executor: { type: "string", enum: [...CONNECTOR_EXECUTORS], description: "Who does it (default auto)." },
        device: DEVICE_ARG,
      },
      required: ["title", "goal"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: VIEW_URIS.task } },
  },
  {
    name: "kesher_task_action",
    title: "Run, queue, assign or stop a task",
    description: "Does what the hub page's task buttons do: run (start it now; Antigravity too), queue / unqueue (its executor's line), stop (stops a running task, cancels a waiting one), assign (give it to another executor: to).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: TASK_ID_ARG,
        action: { type: "string", enum: [...CONNECTOR_ACTIONS] },
        to: { type: "string", description: "assign only: antigravity, local, opencode, ghostcli, gemini, claude or claude-code." },
        confirm: { type: "boolean", description: "assign only: yes to stopping a running task (or re-running an ended one) first." },
        device: DEVICE_ARG,
      },
      required: ["taskId", "action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "kesher_quotas",
    title: "Provider quotas",
    description: "What is left of each provider the PC's agents use (Antigravity, GhostCLI, OpenCode Go, Gemini, Claude, the local model): share or count left per window, and when it fills again.",
    inputSchema: { type: "object", properties: { device: DEVICE_ARG }, additionalProperties: false },
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: VIEW_URIS.quotas } },
  },
  {
    name: "kesher_agents",
    title: "Running agents",
    description: "The PC's agents (local model, Antigravity, OpenCode Go, GhostCLI…): on/off/busy, and the task each works on with its last step.",
    inputSchema: { type: "object", properties: { device: DEVICE_ARG }, additionalProperties: false },
    annotations: READ_ONLY,
  },
] as const;

type ToolName = (typeof MCP_TOOLS)[number]["name"];

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Runs one tool for a connection.
 *
 * @param hub - The hub.
 * @param name - The tool.
 * @param args - Its arguments.
 * @param hubUrl - The hub page's address (for the "open in hub" links).
 * @param grantId - The connection that calls.
 * @returns The tool's result.
 */
export async function callTool(hub: Hub, name: ToolName, args: Record<string, unknown>, hubUrl: string, grantId: string): Promise<Record<string, unknown>> {
  switch (name) {
    case "kesher_tasks":
      return viaPc(hub, grantId, args, { op: "tasks", filter: args.filter, executor: args.executor }, (a, pc) => ({
        data: { pc, tasks: a.tasks ?? [], ...(a.text ? { text: a.text } : {}) },
        text: (a.tasks ?? []).length ? (a.tasks ?? []).map((t) => `${t.taskId} [${t.state}] ${t.title} (${t.executor}${t.queuePos ? `, #${t.queuePos} in line` : ""}${t.steps ? `, step ${t.steps}${t.estSteps ? ` of ~${t.estSteps}` : ""}` : ""})`).join("\n") : "No tasks match.",
      }));
    case "kesher_task":
      return viaPc(hub, grantId, args, { op: "task", taskId: args.taskId }, (a, pc) => ({ data: { pc, ...(a.task ? { task: a.task } : {}) }, text: a.task ? taskText(a) : a.text ?? "No such task." }));
    case "kesher_add_task":
      return viaPc(hub, grantId, args, { op: "add", title: args.title, goal: args.goal, executor: args.executor }, (a, pc) => ({ data: { pc, text: a.text ?? "Added.", ...(a.task ? { task: a.task } : {}) }, text: a.task ? `${a.text ?? "Added."}\n${taskText(a)}` : a.text ?? "Added." }));
    case "kesher_task_action":
      return viaPc(hub, grantId, args, { op: "action", taskId: args.taskId, action: args.action, to: args.to, confirm: args.confirm }, (a, pc) => ({ data: { pc, ok: a.ok, text: a.text ?? "" }, text: a.text ?? "Done." }));
    case "kesher_quotas":
      return viaPc(hub, grantId, args, { op: "quotas" }, (a, pc) => ({
        data: { pc, quotas: a.quotas ?? [] },
        text: (a.quotas ?? []).map((q) => `${q.name}: ${q.state}${q.bars.map((b) => ` · ${b.label} ${typeof b.left === "number" ? `${Math.round(b.left * 100)}% left` : typeof b.used === "number" ? `${b.used}${b.limit ? `/${b.limit}` : ""} used` : "?"}${b.resetAt ? ` (back ${new Date(b.resetAt).toISOString().slice(0, 16)}Z)` : ""}`).join("")}`).join("\n") || "No quotas reported.",
      }));
    case "kesher_agents":
      return viaPc(hub, grantId, args, { op: "agents" }, (a, pc) => ({
        data: { pc, agents: a.agents ?? [] },
        text: (a.agents ?? []).map((g) => `${g.kind} ${g.state}${g.label ? ` (${g.label})` : ""}${g.task ? ` → ${g.task.taskId} ${g.task.title}${g.task.now ? ` · last step: ${g.task.now.tool}${g.task.now.target ? ` ${g.task.now.target}` : ""}` : ""}` : ""}`).join("\n") || "No agents reported.",
      }));
    case "list_devices":
      return toolResult({
        devices: hub.presence().map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          online: d.online,
          ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}),
          busy: d.busy,
          ...(d.version ? { version: d.version } : {}),
          ...(d.kind === "pc" ? { accepts: { tasks: d.optIn.acceptTasks, localModel: d.optIn.acceptTasks && d.optIn.acceptLocal, antigravity: d.optIn.acceptTasks && d.optIn.acceptAntigravity } } : {}),
        })),
        hubUrl: `${hubUrl}/#devices`,
      });
    case "get_agent_status": {
      const want = str(args.device, 64).trim().toLowerCase();
      const devs = hub.presence().filter((d) => !want || d.id.toLowerCase() === want || d.name.toLowerCase() === want);
      if (want && !devs.length) return toolError(`No device is called "${want}". Use list_devices to see them.`);
      return toolResult({ devices: devs.map((d) => ({ id: d.id, name: d.name, online: d.online, busy: d.busy, agents: d.agents.map((a) => ({ kind: a.kind, state: a.state, ...(a.label ? { label: a.label } : {}) })) })), note: SEALED_NOTE, hubUrl: `${hubUrl}/#agents` });
    }
    case "waiting_for_approval": {
      const pcs = hub.waitingCounts();
      return toolResult({ total: pcs.reduce((n, p) => n + p.waiting, 0), pcs: pcs.map((p) => ({ id: p.deviceId, name: p.name, waiting: p.waiting, reportedAt: new Date(p.at).toISOString() })), note: SEALED_NOTE, hubUrl: `${hubUrl}/#dash` });
    }
    case "list_tasks": {
      const { queued, sent } = hub.connectorTasks();
      return toolResult({
        queuedForPcs: queued,
        sentByConnector: sent.map((s) => ({ taskId: s.taskId, pc: s.name, executor: s.executor, sentAt: new Date(s.at).toISOString(), takenByPc: s.taken })),
        note: SEALED_NOTE,
        hubUrl: `${hubUrl}/#tasks`,
      });
    }
    case "send_task": {
      const title = str(args.title, 1000);
      const spec = typeof args.spec === "string" ? args.spec : "";
      const executor = args.executor === "pc-local" ? "pc-local" : args.executor === undefined || args.executor === "pc-antigravity" ? "pc-antigravity" : undefined;
      if (!executor) return toolError("executor must be pc-antigravity or pc-local.");
      const r = await hub.sendConnectorTask({ title, spec, device: str(args.device, 64), executor }, grantId);
      if ("error" in r) return toolError(r.error);
      return toolResult({ taskId: r.taskId, pc: r.name, delivered: r.delivered, waitsForRun: executor === "pc-antigravity", hubUrl: `${hubUrl}/#tasks` });
    }
  }
}

/**
 * Hides secrets and personal paths in the connector's answers (again: the PC already did, with its own user name and
 * home folder): keys, e-mails, home folders (leak-guard), and the hub's own tokens and addresses (diag.ts).
 *
 * @param text - A text field of an answer.
 * @returns The same text, safe to show Claude.
 */
export function connectorScrub(text: string): string {
  return scrubSecrets(redactLeaks(text).text);
}

/** A task's text answer: one line of facts, the result, and the newest steps. */
function taskText(a: ConnectorAnswer): string {
  const t = a.task!;
  const head = `${t.taskId} [${t.state}] ${t.title} (${[t.executor, t.model, t.branch, t.steps ? `step ${t.steps}${t.estSteps ? ` of ~${t.estSteps}` : ""}` : ""].filter(Boolean).join(", ")})`;
  const steps = t.stepLog.map((s) => `- ${s.tool}${s.target ? ` ${s.target}` : ""}${s.error ? " (failed)" : ""}`);
  return [head, t.result || t.cause ? `Result: ${t.result ?? t.cause}` : "", steps.length ? `Latest steps:\n${steps.join("\n")}` : ""].filter(Boolean).join("\n");
}

/**
 * Runs one of the kesher_* tools through the PC (Hub.connectorAsk): the answer is scrubbed, then shaped by `shape`.
 * Refusals (opt-in off, offline, rate limit, a disallowed request) come back as tool errors in words.
 */
async function viaPc(hub: Hub, grantId: string, args: Record<string, unknown>, query: Record<string, unknown>, shape: (a: ConnectorAnswer, pc: string) => { data: Record<string, unknown>; text: string }): Promise<Record<string, unknown>> {
  const r = await hub.connectorAsk(query, grantId, str(args.device, 64));
  if ("error" in r) return toolError(r.error);
  const a = mapConnectorText(r.answer, connectorScrub);
  if (!a.ok) return { ...toolError(a.text ?? "The PC refused."), structuredContent: { pc: r.pc, ok: false, error: a.text ?? "" } };
  const { data, text } = shape(a, r.pc);
  return { content: [{ type: "text", text }], structuredContent: data };
}

/**
 * One JSON-RPC message from Claude to `/mcp` (no batches: removed in MCP 2025-06-18).
 *
 * @param hub - The hub.
 * @param msg - The parsed body.
 * @param hubUrl - The hub page's address.
 * @param grantId - The connection that calls (from its access token).
 * @returns The answer, or undefined for a notification (HTTP 202, no body).
 */
export async function handleRpc(hub: Hub, msg: unknown, hubUrl: string, grantId: string): Promise<RpcAnswer | undefined> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "One JSON-RPC request per POST.");
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(id, -32600, "Not a JSON-RPC 2.0 request.");
  // A notification (no id) or a response to us: nothing to answer.
  if (m.id === undefined) return undefined;
  const params = m.params && typeof m.params === "object" && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};
  const ok = (result: unknown): RpcAnswer => ({ jsonrpc: "2.0", id, result });
  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "kesher-hub", title: "Kesher Cloud hub", version: "1.0.0" },
        instructions: "The owner's KesherAI hub. list_devices, get_agent_status, waiting_for_approval and list_tasks return metadata only (contents are end-to-end encrypted; share the hubUrl). The kesher_* tools ask the PC itself (tasks, one task, quotas, agents; add, run, queue, assign or stop a task) and work only while the PC's \"Claude connector may read and run\" setting is on.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: MCP_TOOLS });
    case "resources/list":
      return ok({ resources: VIEWS.map((v) => ({ uri: v.uri, name: v.name, description: v.description, mimeType: MCP_APP_MIME })) });
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    case "resources/read": {
      const view = VIEWS.find((v) => v.uri === params.uri);
      if (!view) return rpcError(id, -32002, "Resource not found.");
      // No outside loads at all (an empty CSP allow-list), and a border around the view.
      return ok({ contents: [{ uri: view.uri, mimeType: MCP_APP_MIME, text: view.html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] });
    }
    case "tools/call": {
      const name = params.name;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, "Unknown tool.");
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      hub.noteToolCall(tool.name, grantId);
      if (hub.paused) return ok(toolError("The hub is paused (hub page › Settings)."));
      return ok(await callTool(hub, tool.name, args, hubUrl, grantId));
    }
    default:
      return rpcError(id, -32601, "Method not found.");
  }
}
