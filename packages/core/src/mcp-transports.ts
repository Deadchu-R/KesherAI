/**
 * MCP's two connections: a program over stdin/stdout, and an online server over Streamable HTTP (with sign-in).
 * mcp.ts uses them and re-exports what is public.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "./mcp.js";

export const PROTOCOL = "2025-06-18";

/** Thrown when an online server needs the user to sign in first. */
export class McpNeedsSignIn extends Error {
  /** @param resourceMetadata - Where the server said its sign-in details are, if it said. */
  constructor(readonly resourceMetadata?: string) {
    super("This service needs you to sign in first.");
  }
}

/** A JSON-RPC params or result object. */
export type Json = Record<string, unknown>;
/** One JSON-RPC message from a server. */
export interface RpcReply {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
}

/** One live connection. */
export interface Transport {
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
  if (cfg.preset === "unity-mcp" && /Unity|connect|refused|bridge/i.test(error) && !/not recognized as an internal|ENOENT|command not found/i.test(error)) return "MCP for Unity is not reaching the editor. Open your project in Unity with the MCP for Unity package installed (Window → MCP for Unity shows it connected), then press Reconnect.";
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
export class StdioTransport implements Transport {
  private proc: ChildProcess;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private buf = "";
  private stderr = "";
  private closed = false;

  /** Starts the program; `onExit` is told why it ended. */
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
      // A program that writes without line ends never grows this without limit (16 MB: far above any message).
      if (this.buf.length > 16 * 1024 * 1024 && this.buf.indexOf("\n") < 0) this.buf = "";
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

  /** Sends a request and waits for its answer. */
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

  /** Sends a notification (no answer). */
  notify(method: string, params?: Json): Promise<void> {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    return Promise.resolve();
  }

  /** Ends the program. */
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
export class HttpTransport implements Transport {
  private next = 1;
  private session?: string;

  /** An online server; `token` gives the saved sign-in, `refresh` renews it once. */
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

  /** Sends a request and waits for its answer. */
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

  /** Sends a notification (no answer). */
  async notify(method: string, params?: Json): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }).catch(() => undefined);
  }

  /** Ends the session. */
  close() {
    if (this.session) void fetch(this.cfg.url!, { method: "DELETE", headers: { "mcp-session-id": this.session } }).catch(() => undefined);
  }
}
