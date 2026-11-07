import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ToolSpec } from "@kesher/shared";

/**
 * MCP (Model Context Protocol) client: lets every chat and agent use tools
 * from MCP servers: Notion, GitHub, Linear, Jira, Unity, a database, anything
 * that speaks MCP. Two kinds of server:
 *
 * - **Program** (stdio): KesherAI starts a command (`npx -y …`, `uvx …`) and
 *   talks to it over stdin/stdout.
 * - **Online** (Streamable HTTP): a URL. When it asks for sign-in (401),
 *   KesherAI does the MCP OAuth flow: it discovers the sign-in server,
 *   registers itself, and opens the browser on the service's own consent
 *   page; KesherAI never sees a password.
 *
 * Small and dependency-free: JSON-RPC 2.0 over newline-delimited stdio, or
 * over HTTP POST with a JSON or SSE answer.
 */

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "KesherAI", version: "1" };

/** One configured MCP server. */
export interface McpServerConfig {
  /** Short id, used in tool names (`mcp_<id>_<tool>`). */
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** stdio: the program and its arguments. */
  command?: string;
  args?: string[];
  /** stdio: extra environment variables (API keys go here). */
  env?: Record<string, string>;
  /** http: the server URL. */
  url?: string;
  /** http: extra headers, e.g. `Authorization: Bearer …` for services that take a token. */
  headers?: Record<string, string>;
  enabled: boolean;
  /** Which catalog entry it came from. */
  preset?: string;
  /** Tools the user turned off for this server. */
  disabledTools?: string[];
}

/** A tool an MCP server offers. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

/** What a tool call returned. */
export interface McpCallResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** How a server is doing, for the settings page. */
export interface McpServerStatus {
  id: string;
  state: "off" | "connecting" | "ready" | "needs-sign-in" | "error";
  error?: string;
  tools: McpTool[];
  /** The service's name and version, from its hello. */
  server?: string;
}

/** A sign-in that is waiting for the browser to come back. */
interface PendingAuth {
  serverId: string;
  verifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  at: number;
}

/** Saved sign-in for one online server. */
interface SavedAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
}

/** Thrown when an online server needs the user to sign in first. */
export class McpNeedsSignIn extends Error {
  /** @param resourceMetadata - Where the server said its sign-in details are, if it said. */
  constructor(readonly resourceMetadata?: string) {
    super("This service needs you to sign in first.");
  }
}

type Json = Record<string, unknown>;
interface RpcReply {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
}

/** One live connection. */
interface Transport {
  request(method: string, params?: Json, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: Json): Promise<void>;
  close(): void;
}

/**
 * Explains the usual reason a game-engine server is not answering.
 *
 * @param cfg - The server.
 * @param error - What went wrong.
 * @returns A clearer message, when there is one.
 */
export function presetHelp(cfg: McpServerConfig, error: string): string | undefined {
  if (cfg.preset === "unreal" && /fetch failed|ECONNREFUSED|Could not reach/i.test(error)) return "Unreal is not answering on 127.0.0.1:8000. Open your project in Unreal Engine 5.8 or newer, enable the Unreal MCP plugin and All Toolsets (Edit → Plugins), and turn on Auto Start Server (Editor Preferences → General → Model Context Protocol). Then press Reconnect.";
  if (cfg.preset === "unity" && /ENOENT|not recognized|not found|No such file/i.test(error)) return "Unity's MCP relay is not installed yet. In your Unity project add the AI Assistant package (com.unity.ai.assistant), open the editor and check Edit → Project Settings → AI → Unity MCP Server shows Running. Then press Reconnect, and accept KesherAI under Pending Connections.";
  return undefined;
}

/**
 * Says plainly what to install when a server's program is missing
 * (e.g. `npx` without Node.js on Windows: "is not recognized").
 *
 * @param command - The program the server runs.
 * @param error - What the system said.
 * @returns The message, or undefined when something else went wrong.
 */
export function missingTool(command: string, error: string): string | undefined {
  if (!/not recognized as an internal or external command|ENOENT|command not found|No such file or directory/i.test(error)) return undefined;
  const c = command.replace(/\.(cmd|exe)$/i, "").split(/[\\/]/).pop()!.toLowerCase();
  if (["npx", "npm", "node"].includes(c)) return "This server needs Node.js, which is not installed on this computer. Press Install Node.js and KesherAI sets it up in its own folder.";
  if (["uvx", "uv"].includes(c)) return "This server needs uv, which is not installed on this computer. Press Install uv and KesherAI sets it up in its own folder.";
  if (["python", "python3", "py"].includes(c)) return "This server needs Python, which is not installed on this computer. Install it from python.org, then press Reconnect.";
  if (c === "docker") return "This server needs Docker, which is not installed or not running on this computer.";
  return `The program "${command}" was not found on this computer. Install it, then press Reconnect.`;
}

/** Talks JSON-RPC to a program over stdin/stdout. */
class StdioTransport implements Transport {
  private proc: ChildProcess;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private buf = "";
  private stderr = "";
  private closed = false;

  constructor(cfg: McpServerConfig, onExit: (why: string) => void, baseEnv: NodeJS.ProcessEnv = process.env) {
    const win = process.platform === "win32";
    this.proc = spawn(cfg.command!, cfg.args ?? [], {
      env: { ...baseEnv, ...cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
      // npx, uvx and friends are .cmd files on Windows (they need the shell); a full path to an .exe
      // (Unity's relay) runs directly, so spaces in the user's folder name are fine.
      shell: win && !/[\\/]/.test(cfg.command!),
      windowsHide: true,
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: RpcReply;
        try {
          msg = JSON.parse(line) as RpcReply;
        } catch {
          continue; // a server that logs to stdout
        }
        this.onMessage(msg);
      }
    });
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-2000)));
    const end = (why: string) => {
      if (this.closed) return;
      this.closed = true;
      for (const w of this.waiting.values()) w.fail(new Error(why));
      this.waiting.clear();
      onExit(why);
    };
    this.proc.on("error", (e) => end(presetHelp(cfg, e.message) ?? missingTool(cfg.command!, e.message) ?? `Could not start ${cfg.command}: ${e.message}`));
    this.proc.on("exit", (code) => end(presetHelp(cfg, this.stderr) ?? missingTool(cfg.command!, this.stderr) ?? `The program stopped (code ${code}). ${this.stderr.trim().split("\n").slice(-3).join(" ")}`.trim()));
  }

  private onMessage(msg: RpcReply) {
    if (msg.id !== undefined && !msg.method) {
      const w = this.waiting.get(Number(msg.id));
      if (!w) return;
      this.waiting.delete(Number(msg.id));
      if (msg.error) w.fail(new Error(msg.error.message));
      else w.ok(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      // A request from the server (ping, roots, sampling): answer what we can.
      const result = msg.method === "ping" ? {} : msg.method === "roots/list" ? { roots: [] } : undefined;
      this.write(result ? { jsonrpc: "2.0", id: msg.id, result } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Not supported" } });
    }
  }

  private write(m: Json) {
    if (!this.closed) this.proc.stdin!.write(JSON.stringify(m) + "\n");
  }

  request(method: string, params?: Json, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("The program is not running."));
    const id = this.next++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        fail(new Error(`${method} took too long.`));
      }, method === "tools/call" ? 300_000 : 60_000);
      const done = { ok: (v: unknown) => (clearTimeout(timer), ok(v)), fail: (e: Error) => (clearTimeout(timer), fail(e)) };
      this.waiting.set(id, done);
      signal?.addEventListener("abort", () => {
        this.waiting.delete(id);
        void this.notify("notifications/cancelled", { requestId: id, reason: "stopped" });
        done.fail(new Error("Stopped."));
      }, { once: true });
      this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Json): Promise<void> {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    this.proc.kill();
  }
}

/**
 * Reads the JSON-RPC answer from an SSE stream (Streamable HTTP servers may
 * answer a POST that way).
 *
 * @param text - The whole stream body.
 * @param id - The request id to find.
 * @returns The matching message.
 */
export function rpcFromSse(text: string, id: number): RpcReply | undefined {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const m = JSON.parse(data) as RpcReply | RpcReply[];
      for (const x of Array.isArray(m) ? m : [m]) if (x.id === id || Number(x.id) === id) return x;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** Talks JSON-RPC to an online server (Streamable HTTP). */
class HttpTransport implements Transport {
  private next = 1;
  private session?: string;

  constructor(
    private readonly cfg: McpServerConfig,
    private readonly token: () => Promise<string | undefined>,
    private readonly refresh: () => Promise<boolean>,
  ) {}

  private async post(body: Json, signal?: AbortSignal, retried = false): Promise<Response> {
    const tok = await this.token();
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        ...this.cfg.headers,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(body.method === "tools/call" ? 300_000 : 60_000),
    });
    if (res.status === 401) {
      if (!retried && tok && (await this.refresh())) return this.post(body, signal, true);
      const meta = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];
      throw new McpNeedsSignIn(meta);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    return res;
  }

  async request(method: string, params?: Json, signal?: AbortSignal): Promise<unknown> {
    const id = this.next++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, signal);
    if (res.status === 404 && this.session && method !== "initialize") {
      this.session = undefined;
      throw new Error("The service forgot this session; reconnect it.");
    }
    if (!res.ok) throw new Error(`The service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const type = res.headers.get("content-type") ?? "";
    const msg = type.includes("text/event-stream") ? rpcFromSse(await res.text(), id) : ((await res.json()) as RpcReply);
    if (!msg) throw new Error("The service did not answer.");
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  }

  async notify(method: string, params?: Json): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }).catch(() => undefined);
  }

  close() {
    if (this.session) void fetch(this.cfg.url!, { method: "DELETE", headers: { "mcp-session-id": this.session } }).catch(() => undefined);
  }
}

/**
 * Turns a server id and tool name into a tool name models accept
 * (letters, digits, `_` and `-`, at most 64).
 *
 * @param serverId - The server's id.
 * @param tool - The tool's own name.
 * @returns e.g. `mcp_notion_search`.
 */
export function mcpToolName(serverId: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp_${clean(serverId)}_${clean(tool)}`.slice(0, 64);
}

/**
 * Turns a tool result into text for the model (and images for vision models).
 *
 * @param r - What the server returned.
 * @returns Text and images.
 */
export function mcpResultText(r: McpCallResult): { text: string; images: Array<{ mimeType: string; data: string }> } {
  const parts: string[] = [];
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && c.text) parts.push(c.text);
    else if (c.type === "image" && c.data && c.mimeType) images.push({ mimeType: c.mimeType, data: c.data });
    else if (c.type === "resource" && c.resource) parts.push(c.resource.text ?? c.resource.uri ?? "");
    else if (c.type === "resource_link") parts.push(JSON.stringify(c));
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return { text: parts.join("\n\n") || (images.length ? "(an image)" : "(no output)"), images };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Runs the configured MCP servers and their sign-ins. */
export class McpManager {
  private servers: McpServerConfig[] = [];
  private live = new Map<string, { t: Transport; status: McpServerStatus }>();
  private connecting = new Map<string, Promise<void>>();
  private auth: Record<string, SavedAuth> = {};
  private pending = new Map<string, PendingAuth>();
  private loaded?: Promise<void>;

  /**
   * @param file - Where the server list is saved (`mcp.json`).
   * @param authFile - Where sign-ins are saved (`mcp-auth.json`, kept on this computer).
   */
  constructor(
    private readonly file: string,
    private readonly authFile: string,
    /** A sign-in KesherAI already has for a well-known server (e.g. "Connect with GitHub"). */
    private readonly presetToken: (cfg: McpServerConfig) => string | undefined = () => undefined,
    /** The environment for server programs (adds KesherAI's own Node.js and uv to PATH). */
    private readonly spawnEnv: (env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv> = async (env) => env,
  ) {}

  /** Loads the saved list and connects the enabled servers in the background. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.servers = ((JSON.parse(await readFile(this.file, "utf8")) as { servers?: McpServerConfig[] }).servers ?? []).map(migratePreset);
      } catch {
        this.servers = [];
      }
      try {
        this.auth = JSON.parse(await readFile(this.authFile, "utf8")) as Record<string, SavedAuth>;
      } catch {
        this.auth = {};
      }
      for (const s of this.servers) if (s.enabled) void this.connect(s.id).catch(() => undefined);
    })();
    return this.loaded;
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ servers: this.servers }, null, 2));
  }

  private async saveAuth() {
    await mkdir(dirname(this.authFile), { recursive: true });
    await writeFile(this.authFile, JSON.stringify(this.auth, null, 2), { mode: 0o600 });
  }

  /** @returns The servers, with secrets hidden. */
  list(): Array<McpServerConfig & { status: McpServerStatus; signedIn: boolean }> {
    const hide = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.keys(o).map((k) => [k, o[k] ? "••••" : ""])) : undefined);
    return this.servers.map((s) => ({
      ...s,
      ...(s.env ? { env: hide(s.env) } : {}),
      ...(s.headers ? { headers: hide(s.headers) } : {}),
      status: this.statusOf(s.id),
      signedIn: !!this.auth[s.id],
    }));
  }

  /** @returns The status of one server. */
  statusOf(id: string): McpServerStatus {
    const s = this.servers.find((x) => x.id === id);
    return this.live.get(id)?.status ?? { id, state: s?.enabled ? "connecting" : "off", tools: [] };
  }

  /**
   * Adds or replaces a server. Secret fields sent back as `••••` keep their saved value.
   *
   * @param cfg - The server.
   * @returns The saved server.
   */
  async upsert(cfg: McpServerConfig): Promise<McpServerConfig> {
    await this.load();
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(cfg.id)) throw new Error("The id must be short: lowercase letters, digits and dashes.");
    if (cfg.transport === "stdio" && !cfg.command?.trim()) throw new Error("Enter the program to run.");
    if (cfg.transport === "http" && !/^https?:\/\//.test(cfg.url ?? "")) throw new Error("Enter the server's address (https://…).");
    const old = this.servers.find((s) => s.id === cfg.id);
    const keep = (next?: Record<string, string>, prev?: Record<string, string>) =>
      next ? Object.fromEntries(Object.entries(next).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v === "••••" ? (prev?.[k] ?? "") : v])) : undefined;
    const merged: McpServerConfig = {
      id: cfg.id,
      name: cfg.name?.trim() || cfg.id,
      transport: cfg.transport,
      enabled: cfg.enabled !== false,
      ...(cfg.transport === "stdio" ? { command: cfg.command!.trim(), args: cfg.args ?? [], env: keep(cfg.env, old?.env) ?? {} } : { url: cfg.url!.trim(), headers: keep(cfg.headers, old?.headers) ?? {} }),
      ...(cfg.preset ? { preset: cfg.preset } : {}),
      ...(cfg.disabledTools?.length ? { disabledTools: cfg.disabledTools } : {}),
    };
    this.servers = old ? this.servers.map((s) => (s.id === cfg.id ? merged : s)) : [...this.servers, merged];
    await this.save();
    this.disconnect(cfg.id);
    if (merged.enabled) void this.connect(cfg.id).catch(() => undefined);
    return merged;
  }

  /** Removes a server and its sign-in. */
  async remove(id: string): Promise<void> {
    await this.load();
    this.disconnect(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    delete this.auth[id];
    await Promise.all([this.save(), this.saveAuth()]);
  }

  /** Forgets a server's sign-in. */
  async signOut(id: string): Promise<void> {
    delete this.auth[id];
    await this.saveAuth();
    this.disconnect(id);
    if (this.servers.find((s) => s.id === id)?.enabled) void this.connect(id).catch(() => undefined);
  }

  private disconnect(id: string) {
    this.live.get(id)?.t.close();
    this.live.delete(id);
    this.connecting.delete(id);
  }

  private setStatus(id: string, status: Omit<McpServerStatus, "id">, t?: Transport) {
    const cur = this.live.get(id);
    this.live.set(id, { t: t ?? cur?.t ?? { request: () => Promise.reject(new Error("Not connected.")), notify: async () => undefined, close: () => undefined }, status: { id, ...status } });
  }

  /** Connects (or reconnects) a server and reads its tools. */
  connect(id: string): Promise<void> {
    const existing = this.connecting.get(id);
    if (existing) return existing;
    const p = (async () => {
      const cfg = this.servers.find((s) => s.id === id);
      if (!cfg) throw new Error("No such server.");
      this.live.get(id)?.t.close();
      this.setStatus(id, { state: "connecting", tools: [] });
      const baseEnv = cfg.transport === "stdio" ? await this.spawnEnv(process.env) : process.env;
      const t: Transport =
        cfg.transport === "stdio"
          ? new StdioTransport(cfg, (why) => {
              if (this.live.get(id)?.t === t) this.setStatus(id, { state: "error", error: why, tools: [] });
            }, baseEnv)
          : new HttpTransport(cfg, async () => (await this.tokenFor(id)) ?? (cfg.headers?.Authorization || cfg.headers?.authorization ? undefined : this.presetToken(cfg)), () => this.refreshToken(id));
      this.setStatus(id, { state: "connecting", tools: [] }, t);
      try {
        const hello = (await t.request("initialize", { protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: CLIENT })) as { serverInfo?: { name?: string; version?: string } };
        await t.notify("notifications/initialized");
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const page = (await t.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
          tools.push(...(page.tools ?? []));
          cursor = page.nextCursor;
        } while (cursor && tools.length < 500);
        const server = [hello.serverInfo?.name, hello.serverInfo?.version].filter(Boolean).join(" ");
        this.setStatus(id, { state: "ready", tools, ...(server ? { server } : {}) }, t);
      } catch (e) {
        t.close();
        if (e instanceof McpNeedsSignIn) this.setStatus(id, { state: "needs-sign-in", tools: [] }, t);
        else {
          const msg = presetHelp(cfg, (e as Error).message) ?? (e as Error).message;
          this.setStatus(id, { state: "error", error: msg === "fetch failed" ? `Could not reach ${cfg.url}. Check the address and your internet connection.` : msg, tools: [] }, t);
        }
        throw e;
      }
    })().finally(() => this.connecting.delete(id));
    this.connecting.set(id, p);
    return p;
  }

  /** Every tool from every ready server, as tools for the agent. */
  tools(): Array<{ server: McpServerConfig; tool: McpTool; name: string; spec: ToolSpec }> {
    const out: Array<{ server: McpServerConfig; tool: McpTool; name: string; spec: ToolSpec }> = [];
    for (const s of this.servers) {
      if (!s.enabled) continue;
      const st = this.live.get(s.id)?.status;
      if (st?.state !== "ready") continue;
      for (const tool of st.tools) {
        if (s.disabledTools?.includes(tool.name)) continue;
        const name = mcpToolName(s.id, tool.name);
        out.push({
          server: s,
          tool,
          name,
          spec: { name, description: `[${s.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`.slice(0, 1024), inputSchema: (tool.inputSchema as ToolSpec["inputSchema"]) ?? { type: "object", properties: {} } },
        });
      }
    }
    return out;
  }

  /**
   * Calls a tool.
   *
   * @param serverId - The server.
   * @param tool - The tool's own name.
   * @param args - Its input.
   * @param signal - Stops the call.
   * @returns The result.
   */
  async call(serverId: string, tool: string, args: Json, signal?: AbortSignal): Promise<McpCallResult> {
    let entry = this.live.get(serverId);
    if (entry?.status.state !== "ready") {
      await this.connect(serverId);
      entry = this.live.get(serverId);
    }
    try {
      return (await entry!.t.request("tools/call", { name: tool, arguments: args }, signal)) as McpCallResult;
    } catch (e) {
      // The program may have restarted or the online session expired: reconnect once.
      if (signal?.aborted || e instanceof McpNeedsSignIn) throw e;
      await this.connect(serverId);
      return (await this.live.get(serverId)!.t.request("tools/call", { name: tool, arguments: args }, signal)) as McpCallResult;
    }
  }

  // ---------- sign-in for online servers (MCP authorization: OAuth 2.1 + PKCE, dynamic registration) ----------

  private async tokenFor(id: string): Promise<string | undefined> {
    const a = this.auth[id];
    if (!a) return undefined;
    if (a.expiresAt && a.expiresAt < Date.now() + 30_000 && a.refreshToken) await this.refreshToken(id);
    return this.auth[id]?.accessToken;
  }

  private async refreshToken(id: string): Promise<boolean> {
    const a = this.auth[id];
    if (!a?.refreshToken) return false;
    const res = await fetch(a.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: a.clientId, resource: a.resource, ...(a.clientSecret ? { client_secret: a.clientSecret } : {}) }),
    }).catch(() => undefined);
    if (!res?.ok) return false;
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    this.auth[id] = { ...a, accessToken: j.access_token, refreshToken: j.refresh_token ?? a.refreshToken, ...(j.expires_in ? { expiresAt: Date.now() + j.expires_in * 1000 } : {}) };
    await this.saveAuth();
    return true;
  }

  /**
   * Starts signing in to an online server.
   *
   * @param id - The server.
   * @param redirectUri - KesherAI's callback on this computer.
   * @returns The service's consent page to open in the browser.
   */
  async signInUrl(id: string, redirectUri: string): Promise<string> {
    const cfg = this.servers.find((s) => s.id === id);
    if (!cfg?.url) throw new Error("Only online servers sign in.");
    const url = new URL(cfg.url);
    // 1. Where does this server send people to sign in?
    let metaUrl: string | undefined;
    try {
      await new HttpTransport({ ...cfg, headers: {} }, async () => undefined, async () => false).request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
    } catch (e) {
      if (e instanceof McpNeedsSignIn) metaUrl = e.resourceMetadata;
    }
    const getJson = async (u: string) => {
      const r = await fetch(u, { headers: { accept: "application/json", "mcp-protocol-version": PROTOCOL } }).catch(() => undefined);
      return r?.ok ? ((await r.json()) as Json) : undefined;
    };
    const resourceMeta =
      (metaUrl ? await getJson(metaUrl) : undefined) ??
      (await getJson(`${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`)) ??
      (await getJson(`${url.origin}/.well-known/oauth-protected-resource`));
    const issuer = String((resourceMeta?.authorization_servers as string[] | undefined)?.[0] ?? url.origin).replace(/\/$/, "");
    const iu = new URL(issuer);
    const path = iu.pathname === "/" ? "" : iu.pathname;
    const as =
      (await getJson(`${iu.origin}/.well-known/oauth-authorization-server${path}`)) ??
      (await getJson(`${iu.origin}/.well-known/openid-configuration${path}`)) ??
      (await getJson(`${issuer}/.well-known/openid-configuration`));
    if (!as?.authorization_endpoint || !as.token_endpoint) throw new Error("This service does not say how to sign in. If it gives you a token, add it as a header (Authorization: Bearer …) instead.");
    // 2. Register KesherAI with the service (dynamic client registration).
    let clientId: string;
    let clientSecret: string | undefined;
    if (as.registration_endpoint) {
      const r = await fetch(String(as.registration_endpoint), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_name: "KesherAI", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      if (!r.ok) throw new Error(`The service refused to register KesherAI (${r.status}).`);
      const j = (await r.json()) as { client_id: string; client_secret?: string };
      clientId = j.client_id;
      clientSecret = j.client_secret;
    } else {
      throw new Error("This service needs an app registration KesherAI cannot do by itself. If it gives you a token, add it as a header (Authorization: Bearer …).");
    }
    // 3. The consent page, with PKCE.
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const scopes = (resourceMeta?.scopes_supported as string[] | undefined) ?? undefined;
    const auth = new URL(String(as.authorization_endpoint));
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource: cfg.url,
      ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
    }).toString();
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60_000) this.pending.delete(k);
    this.pending.set(state, { serverId: id, verifier, redirectUri, tokenEndpoint: String(as.token_endpoint), clientId, ...(clientSecret ? { clientSecret } : {}), resource: cfg.url, at: Date.now() });
    return auth.toString();
  }

  /**
   * Finishes a sign-in when the browser comes back.
   *
   * @param state - The `state` the service echoed.
   * @param code - The one-time code.
   * @returns The server's name.
   */
  async finishSignIn(state: string, code: string): Promise<string> {
    const p = this.pending.get(state);
    if (!p) throw new Error("This sign-in expired or was not started here. Start it again from KesherAI.");
    this.pending.delete(state);
    const res = await fetch(p.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}) }),
    });
    if (!res.ok) throw new Error(`The service refused the sign-in (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    this.auth[p.serverId] = {
      accessToken: j.access_token,
      ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
      ...(j.expires_in ? { expiresAt: Date.now() + j.expires_in * 1000 } : {}),
      tokenEndpoint: p.tokenEndpoint,
      clientId: p.clientId,
      ...(p.clientSecret ? { clientSecret: p.clientSecret } : {}),
      resource: p.resource,
    };
    await this.saveAuth();
    this.disconnect(p.serverId);
    void this.connect(p.serverId).catch(() => undefined);
    return this.servers.find((s) => s.id === p.serverId)?.name ?? p.serverId;
  }

  /**
   * Imports servers from a Claude Desktop / Cursor style config
   * (`{"mcpServers": {"name": {"command", "args", "env"} | {"url", "headers"}}}`).
   *
   * @param json - The pasted config.
   * @returns The ids added.
   */
  async importConfig(json: string): Promise<string[]> {
    let parsed: { mcpServers?: Record<string, Json>; servers?: Record<string, Json> };
    try {
      parsed = JSON.parse(json) as typeof parsed;
    } catch {
      throw new Error("That is not valid JSON.");
    }
    const entries = Object.entries(parsed.mcpServers ?? parsed.servers ?? {});
    if (!entries.length) throw new Error('No servers found. Paste a config with "mcpServers".');
    const added: string[] = [];
    for (const [name, v] of entries) {
      const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || `server-${added.length + 1}`;
      const url = (v.url ?? v.serverUrl) as string | undefined;
      await this.upsert(
        url
          ? { id, name, transport: "http", url, headers: (v.headers as Record<string, string>) ?? {}, enabled: true }
          : { id, name, transport: "stdio", command: String(v.command ?? ""), args: (v.args as string[]) ?? [], env: (v.env as Record<string, string>) ?? {}, enabled: true },
      );
      added.push(id);
    }
    return added;
  }

  /** Reconnects every enabled server that is in error (e.g. after installing Node.js). */
  async retryFailed(): Promise<void> {
    await Promise.all(this.servers.filter((s) => s.enabled && this.live.get(s.id)?.status.state === "error").map((s) => this.connect(s.id).catch(() => undefined)));
  }

  /** Stops every server program. */
  close(): void {
    for (const id of [...this.live.keys()]) this.disconnect(id);
  }
}

/**
 * Where Unity's AI Assistant package installs its MCP relay on this computer.
 *
 * @returns The program's full path.
 */
export function unityRelay(platform = process.platform, arch = process.arch, home = homedir()): string {
  if (platform === "win32") return join(home, ".unity", "relay", "relay_win.exe");
  if (platform === "darwin") {
    const a = arch === "arm64" ? "arm64" : "x64";
    return join(home, ".unity", "relay", `relay_mac_${a}.app`, "Contents", "MacOS", `relay_mac_${a}`);
  }
  return join(home, ".unity", "relay", "relay_linux");
}

/**
 * Updates servers added from older presets that pointed at packages which
 * do not exist (npx mcp-unity, uvx unreal-mcp) to the official servers.
 *
 * @param s - A saved server.
 * @returns The server, updated when needed.
 */
export function migratePreset(s: McpServerConfig): McpServerConfig {
  const p = MCP_PRESETS.find((x) => x.id === s.preset);
  if (!p) return s;
  const old = (s.preset === "unity" && s.command === "npx" && s.args?.includes("mcp-unity")) || (s.preset === "unreal" && s.command === "uvx" && s.args?.includes("unreal-mcp"));
  if (!old) return s;
  const { command: _c, args: _a, env: _e, url: _u, headers: _h, ...rest } = s;
  return p.transport === "http" ? { ...rest, transport: "http", url: p.url!, headers: {} } : { ...rest, transport: "stdio", command: p.command!, args: p.args ?? [], env: {} };
}

/** A ready-made server the user can add with one click. */
export interface McpPreset {
  id: string;
  name: string;
  he: string;
  en: string;
  transport: "stdio" | "http";
  url?: string;
  command?: string;
  args?: string[];
  /** Fields the user fills in (API keys, folders); `env:` or `header:` or `arg:` says where each goes. */
  fields?: Array<{ key: string; label: string; secret?: boolean; target: `env:${string}` | `header:${string}` | "arg"; help?: string; prefix?: string }>;
  /** Online sign-in in the browser (no key to paste). */
  signIn?: boolean;
  /** What must be installed for a program server. */
  needs?: "node" | "uv";
  link?: string;
}

/** Well-known MCP servers, official where the service has one. */
export const MCP_PRESETS: McpPreset[] = [
  { id: "notion", name: "Notion", he: "חיפוש, קריאה וכתיבה של דפים ומסדי נתונים ב-Notion.", en: "Search, read and write Notion pages and databases.", transport: "http", url: "https://mcp.notion.com/mcp", signIn: true, link: "https://developers.notion.com/docs/mcp" },
  { id: "linear", name: "Linear", he: "משימות, פרויקטים ותגובות ב-Linear.", en: "Issues, projects and comments in Linear.", transport: "http", url: "https://mcp.linear.app/mcp", signIn: true, link: "https://linear.app/docs/mcp" },
  { id: "atlassian", name: "Jira & Confluence", he: "Jira (משימות) ו-Confluence (דפים) של Atlassian.", en: "Atlassian Jira (issues) and Confluence (pages).", transport: "http", url: "https://mcp.atlassian.com/v1/mcp", signIn: true, link: "https://support.atlassian.com/atlassian-rovo-mcp-server/" },
  { id: "github", name: "GitHub", he: "מאגרים, Issues ו-Pull Requests. צריך טוקן אישי (PAT).", en: "Repositories, issues and pull requests. Needs a personal access token.", transport: "http", url: "https://api.githubcopilot.com/mcp/", fields: [{ key: "token", label: "GitHub token", secret: true, target: "header:Authorization", prefix: "Bearer ", help: "https://github.com/settings/personal-access-tokens" }], link: "https://github.com/github/github-mcp-server" },
  { id: "vercel", name: "Vercel", he: "פרויקטים, פריסות ולוגים ב-Vercel.", en: "Projects, deployments and logs on Vercel.", transport: "http", url: "https://mcp.vercel.com", signIn: true, link: "https://vercel.com/docs/mcp/vercel-mcp" },
  { id: "sentry", name: "Sentry", he: "שגיאות ותקלות מהאפליקציות שלך.", en: "Errors and issues from your apps.", transport: "http", url: "https://mcp.sentry.dev/mcp", signIn: true, link: "https://docs.sentry.io/product/sentry-mcp/" },
  { id: "unity", name: "Unity", he: "שליטה בעורך Unity (סצנות, אובייקטים, סקריפטים, הקונסול) דרך השרת הרשמי של Unity. צריך בפרויקט את החבילה AI Assistant ‏(com.unity.ai.assistant), והעורך פתוח.", en: "Control the Unity Editor (scenes, objects, scripts, console) through Unity's official server. Needs the AI Assistant package (com.unity.ai.assistant) in your project, with the editor open.", transport: "stdio", command: unityRelay(), args: ["--mcp"], link: "https://docs.unity3d.com/Packages/com.unity.ai.assistant@latest/index.html?subfolder=/manual/integration/unity-mcp-get-started.html" },
  { id: "unreal", name: "Unreal Engine", he: "שליטה בעורך Unreal דרך שרת ה-MCP המובנה של Unreal Engine 5.8: מפעילים את הפלאגין Unreal MCP ואת All Toolsets, ואת Auto Start Server.", en: "Control the Unreal Editor through Unreal Engine 5.8's built-in MCP server: enable the Unreal MCP plugin and All Toolsets, and Auto Start Server.", transport: "http", url: "http://127.0.0.1:8000/mcp", link: "https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor" },
  { id: "filesystem", name: "Files", he: "גישה לתיקייה שתבחר במחשב.", en: "Access to a folder you choose on this computer.", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], needs: "node", fields: [{ key: "folder", label: "Folder", target: "arg" }] },
  { id: "memory", name: "Memory graph", he: "זיכרון ארוך-טווח למודלים (גרף של עובדות).", en: "Long-term memory for models (a graph of facts).", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], needs: "node" },
];
