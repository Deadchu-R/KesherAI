import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { AgentApp, client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClientContext, ContentBlock, PermissionOption, SessionUpdate, Stream, ToolCallContent } from "@agentclientprotocol/sdk";

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
  | { kind: "mode"; mode: string };

/** A permission question the agent asks before a tool runs. */
export interface AcpPermission {
  toolCallId: string;
  title: string;
  toolKind?: string;
  options: Array<{ optionId: string; name: string; kind: PermissionOption["kind"] }>;
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
    const app = client()
      .onNotification("session/update", ({ params }) => {
        const u = mapUpdate(params.update);
        if (u) h.update(u);
      })
      .onRequest("session/request_permission", async ({ params }) => {
        const optionId = await h.permission({
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? params.toolCall.name ?? "",
          ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
          options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        }).catch(() => undefined);
        return { outcome: optionId && params.options.some((o) => o.optionId === optionId) ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
      });
    const conn = target instanceof AgentApp ? app.connect(target) : app.connect(target);
    const agent = new AcpAgent(conn.agent, () => conn.close(), child);
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
    return r.sessionId;
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
