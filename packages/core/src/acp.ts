import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { AgentApp, client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClientContext, ContentBlock, PermissionOption, SessionConfigOption, SessionUpdate, Stream, ToolCallContent } from "@agentclientprotocol/sdk";

/**
 * A client for coding agents that speak the Agent Client Protocol (ACP, https://agentclientprotocol.com) over
 * stdio, the way Zed and JetBrains host them: Antigravity CLI (`agy acp`), and others later. The agent keeps its
 * own sign-in, tools and files: KesherAI only sends prompts, shows what comes back, and answers the agent's
 * permission questions with the user's own choice. So no token or key ever passes through KesherAI (Google's
 * documented condition for hosting `agy`; see docs/RESEARCH_LOG.md).
 *
 * KesherAI advertises no file-system or terminal capability: the agent works on the folder with its own tools.
 */

/** What the agent sent, flattened for KesherAI's chat. */
export type AcpUpdate =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string; title?: string; toolKind?: string; status?: string; diffs?: Array<{ path: string; oldText?: string; newText: string }>; text?: string }
  | { kind: "plan"; entries: Array<{ content: string; status: string }> }
  | { kind: "mode"; mode: string }
  | { kind: "options"; options: AcpOption[] };

/** A permission question the agent asks before a tool runs. */
export interface AcpPermission {
  toolCallId: string;
  title: string;
  toolKind?: string;
  /** The change it asks to make, when it says (edits). */
  diffs?: Array<{ path: string; oldText?: string; newText: string }>;
  /** What the step gets (a command, a file and its text…), as the agent sent it. */
  rawInput?: string;
  options: Array<{ optionId: string; name: string; kind: PermissionOption["kind"] }>;
}

/** A choice the agent offers for its session (model, thinking level…), flattened. */
export interface AcpOption {
  id: string;
  name: string;
  category?: string;
  current: string;
  choices: Array<{ value: string; name: string; description?: string }>;
}

/** Select options only (booleans are not shown), groups flattened. */
export function flattenOptions(list: SessionConfigOption[] | null | undefined): AcpOption[] {
  return (list ?? []).flatMap((o) => {
    if (o.type !== "select") return [];
    const choices = o.options.flatMap((x) => ("group" in x ? x.options : [x])).map((c) => ({ value: c.value, name: c.name, ...(c.description ? { description: c.description } : {}) }));
    return [{ id: o.id, name: o.name, ...(o.category ? { category: o.category } : {}), current: o.currentValue, choices }];
  });
}

/** A model the agent offers, from either the session's model choice or ACP's `models` state (see {@link readModels}). */
export interface AcpModel {
  id: string;
  name: string;
  description?: string;
  /** False when the agent marks it unavailable for the user's plan (shown greyed, never picked). */
  available: boolean;
  /** Where it came from: a `configOptions` model select (set with `set_config_option`) or `models` (`set_model`). */
  via: "option" | "models";
}

/** Words an agent uses for a model the user's plan cannot use (Antigravity lists e.g. "Gemini 4 Neon (Unavailable)"). */
const UNAVAILABLE = /\b(unavailable|not available|upgrade|requires? (a )?(higher|paid|ultra|pro\+)|disabled)\b/i;

/**
 * The session's models, from whatever the agent sent at `session/new`: ACP's `models` state (`availableModels`,
 * `currentModelId`; set with `session/set_model`) and/or a `configOptions` select of category `model` (set with
 * `session/set_config_option`). Both are read so it works with either shape; `models` wins when both list one id.
 *
 * @param raw - The `session/new` (or `session/resume`) result, as untrusted JSON.
 * @param options - The flattened config options of the same result.
 * @returns The models and the current one (by id).
 */
export function readModels(raw: unknown, options: AcpOption[]): { models: AcpModel[]; current?: string } {
  const out = new Map<string, AcpModel>();
  const flag = (x: Record<string, unknown>): boolean => {
    const meta = (x._meta && typeof x._meta === "object" ? x._meta : {}) as Record<string, unknown>;
    if (x.available === false || x.disabled === true || meta.available === false || meta.disabled === true) return false;
    return !UNAVAILABLE.test(`${String(x.name ?? "")} ${String(x.description ?? "")}`);
  };
  const opt = options.find((o) => o.category === "model" || /model/i.test(o.id));
  for (const c of opt?.choices ?? []) out.set(c.value, { id: c.value, name: c.name, ...(c.description ? { description: c.description } : {}), available: flag(c as unknown as Record<string, unknown>), via: "option" });
  const st = raw && typeof raw === "object" ? ((raw as Record<string, unknown>).models as Record<string, unknown> | undefined) : undefined;
  const list = st && Array.isArray(st.availableModels) ? (st.availableModels as unknown[]) : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    const id = typeof r.modelId === "string" ? r.modelId : typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    const name = typeof r.name === "string" && r.name ? r.name : id;
    out.set(id, { id, name: name.slice(0, 80), ...(typeof r.description === "string" && r.description ? { description: r.description.slice(0, 200) } : {}), available: flag(r), via: "models" });
  }
  const current = typeof st?.currentModelId === "string" ? st.currentModelId : opt?.current;
  return { models: [...out.values()].slice(0, 30), ...(current ? { current } : {}) };
}

/** What KesherAI does with an agent's updates and permission questions. */
export interface AcpHandlers {
  update: (u: AcpUpdate) => void;
  /** @returns The option the user chose, or undefined to cancel. */
  permission: (p: AcpPermission) => Promise<string | undefined>;
}

const textOf = (c: ContentBlock | undefined): string => (c && c.type === "text" ? c.text : "");
const contentText = (items: ToolCallContent[] | null | undefined): string =>
  (items ?? [])
    .flatMap((x) => (x.type === "content" ? [textOf(x.content)] : []))
    .filter(Boolean)
    .join("\n");
const diffsOf = (items: ToolCallContent[] | null | undefined) =>
  (items ?? []).flatMap((x) => (x.type === "diff" ? [{ path: x.path, ...(x.oldText != null ? { oldText: x.oldText } : {}), newText: x.newText }] : []));

/**
 * Turns one `session/update` into KesherAI's shape.
 *
 * @param u - The update.
 * @returns It, or undefined for updates the chat does not show.
 */
export function mapUpdate(u: SessionUpdate): AcpUpdate | undefined {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { kind: "text", text: textOf(u.content) };
    case "agent_thought_chunk":
      return { kind: "thought", text: textOf(u.content) };
    case "tool_call":
    case "tool_call_update": {
      const diffs = diffsOf(u.content);
      const text = contentText(u.content);
      return {
        kind: "tool",
        id: u.toolCallId,
        ...(u.title ? { title: u.title } : {}),
        ...(u.kind ? { toolKind: u.kind } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(diffs.length ? { diffs } : {}),
        ...(text ? { text } : {}),
      };
    }
    case "plan":
      return { kind: "plan", entries: u.entries.map((e) => ({ content: e.content, status: e.status })) };
    case "current_mode_update":
      return { kind: "mode", mode: u.currentModeId };
    case "config_option_update":
      return { kind: "options", options: flattenOptions(u.configOptions) };
    default:
      return undefined;
  }
}

/** Agents' processes, ended when KesherAI quits. */
const running = new Set<ChildProcess>();
process.once("exit", () => {
  for (const c of running) c.kill();
});

/** A connection to one ACP agent, with one session at a time. */
export class AcpAgent {
  private sessionId?: string;
  /** What `initialize` returned: the agent's name and sign-in methods. */
  info?: { name?: string; version?: string; authMethods: Array<{ id: string; name: string; description?: string }>; loadSession: boolean };

  private constructor(
    private readonly ctx: ClientContext,
    private readonly closeConn: () => void,
    private readonly child?: ChildProcess,
  ) {}

  /**
   * Connects to an agent: a stream (a child process's stdio) or, in tests, an in-process agent.
   *
   * @param target - Where the agent is.
   * @param h - What to do with its updates and permission questions.
   * @param child - The agent's process, killed on close.
   */
  static async connect(target: Stream | AgentApp, h: AcpHandlers, child?: ChildProcess): Promise<AcpAgent> {
    // Set below; updates that come later (new options) are written to it.
    const ref: { agent?: AcpAgent } = {};
    const app = client()
      .onNotification("session/update", ({ params }) => {
        const u = mapUpdate(params.update);
        if (u?.kind === "options" && ref.agent) ref.agent.options = u.options;
        if (u) h.update(u);
      })
      .onRequest("session/request_permission", async ({ params }) => {
        const optionId = await h.permission({
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? params.toolCall.name ?? "",
          ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
          ...(diffsOf(params.toolCall.content).length ? { diffs: diffsOf(params.toolCall.content) } : {}),
          ...(params.toolCall.rawInput != null ? { rawInput: JSON.stringify(params.toolCall.rawInput, null, 1).slice(0, 6000) } : {}),
          options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        }).catch(() => undefined);
        return { outcome: optionId && params.options.some((o) => o.optionId === optionId) ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
      });
    const conn = target instanceof AgentApp ? app.connect(target) : app.connect(target);
    const agent = new AcpAgent(conn.agent, () => conn.close(), child);
    ref.agent = agent;
    const init = await conn.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "KesherAI", version: "1" },
    });
    agent.info = {
      ...(init.agentInfo?.name ? { name: init.agentInfo.name } : {}),
      ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}),
      authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) })),
      loadSession: !!init.agentCapabilities?.loadSession,
    };
    return agent;
  }

  /**
   * Starts an agent's own CLI and connects to it.
   *
   * @param command - The program (e.g. `agy`).
   * @param args - Its arguments (e.g. `["acp"]`).
   * @param cwd - The project folder.
   * @param h - Handlers.
   * @param env - Its environment.
   */
  static async spawn(command: string, args: string[], cwd: string, h: AcpHandlers, env: NodeJS.ProcessEnv = process.env): Promise<AcpAgent> {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    running.add(child);
    child.once("exit", () => running.delete(child));
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    try {
      return await AcpAgent.connect(stream, h, child);
    } catch (e) {
      child.kill();
      throw e;
    }
  }

  /** Signs in with one of the agent's own methods (the agent opens its sign-in itself). */
  async authenticate(methodId: string): Promise<void> {
    await this.ctx.request("authenticate", { methodId });
  }

  /**
   * Starts a session in a folder.
   *
   * @param cwd - Absolute path of the project.
   * @returns The session's id.
   */
  async newSession(cwd: string): Promise<string> {
    const r = await this.ctx.request("session/new", { cwd, mcpServers: [] });
    this.sessionId = r.sessionId;
    this.modes = (r.modes?.availableModes ?? []).map((m) => m.id);
    this.options = flattenOptions(r.configOptions);
    this.mode = r.modes?.currentModeId;
    this.setModels(r);
    return r.sessionId;
  }

  /**
   * Opens an earlier session again without replaying it (`session/resume`), e.g. after KesherAI restarted.
   *
   * @param sessionId - From {@link newSession}.
   * @param cwd - The project.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    const r = await this.ctx.request("session/resume", { sessionId, cwd, mcpServers: [] });
    this.sessionId = sessionId;
    this.modes = (r.modes?.availableModes ?? []).map((m) => m.id);
    this.mode = r.modes?.currentModeId;
    this.options = flattenOptions(r.configOptions);
    this.setModels(r);
  }

  /** The models the agent offers (see {@link readModels}) and the one in use. */
  models: AcpModel[] = [];
  model?: string | undefined;
  /** The top-level keys of the last `session/new` result (logged by the inbox, to see what an agent version sends). */
  sessionKeys: string[] = [];

  private setModels(r: unknown): void {
    const m = readModels(r, this.options);
    this.models = m.models;
    this.model = m.current;
    this.sessionKeys = r && typeof r === "object" ? Object.keys(r).slice(0, 20) : [];
  }

  /**
   * Switches the session's model: through `session/set_model` when the agent listed it in `models`, otherwise
   * through its model choice (`session/set_config_option`). Only a model the agent listed as available.
   *
   * @param id - A model id from {@link models}.
   * @returns The model now in use.
   */
  async setModel(id: string): Promise<string | undefined> {
    if (!this.sessionId) throw new Error("No session yet.");
    const m = this.models.find((x) => x.id === id);
    if (!m || !m.available) throw new Error("The agent does not offer that model.");
    if (this.model === id) return id;
    if (m.via === "models") {
      await this.ctx.request("session/set_model", { sessionId: this.sessionId, modelId: id });
    } else {
      const opt = this.options.find((o) => o.category === "model" || /model/i.test(o.id));
      if (!opt) throw new Error("The agent has no model choice.");
      await this.setOption(opt.id, id);
    }
    this.model = id;
    return id;
  }

  /** The session's choices (model, thinking level…), as the agent last sent them. */
  options: AcpOption[] = [];

  /**
   * Picks a value for one of the session's choices.
   *
   * @returns The choices after it.
   */
  async setOption(configId: string, value: string): Promise<AcpOption[]> {
    if (!this.sessionId) throw new Error("No session yet.");
    const o = this.options.find((x) => x.id === configId);
    if (!o || !o.choices.some((c) => c.value === value)) throw new Error("The agent does not offer that.");
    const r = await this.ctx.request("session/set_config_option", { sessionId: this.sessionId, configId, value });
    this.options = r.configOptions ? flattenOptions(r.configOptions) : this.options.map((x) => (x.id === configId ? { ...x, current: value } : x));
    return this.options;
  }

  /** The session's modes (Antigravity: default, accept-edits, plan) and the current one. */
  modes: string[] = [];
  mode?: string | undefined;

  /**
   * Switches the session's mode when the agent has it.
   *
   * @returns Whether it switched.
   */
  async setMode(modeId: string): Promise<boolean> {
    if (!this.sessionId || !this.modes.includes(modeId) || this.mode === modeId) return false;
    await this.ctx.request("session/set_mode", { sessionId: this.sessionId, modeId });
    this.mode = modeId;
    return true;
  }

  /**
   * Sends the user's message and waits for the turn to end (updates arrive meanwhile).
   *
   * @returns Why it stopped ("end_turn", "cancelled", "max_tokens"…).
   */
  async prompt(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("No session yet.");
    const r = await this.ctx.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    return r.stopReason;
  }

  /** Stops the current turn. */
  async cancel(): Promise<void> {
    if (this.sessionId) await this.ctx.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** Closes the connection and the agent's process. */
  close(): void {
    this.closeConn();
    this.child?.kill();
  }
}
