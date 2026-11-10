import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { stat, writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveInWorkspace } from "@kesher/agent";
import type { KesherServices } from "../services.js";

/**
 * The code session's IDE side: a real terminal (over a WebSocket), reading
 * and saving files for the editor, and `git diff` for the Changes tab.
 *
 * The terminal uses node-pty (a real console, so colours, prompts and
 * interactive programs work). If it cannot load, a plain shell over pipes
 * is used instead.
 */

interface Pty {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): Pty };

const require = createRequire(import.meta.url);
let ptyModule: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require("@lydell/node-pty") as PtyModule;
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** Where Antigravity CLI's Windows installer puts `agy` (KesherAI's own PATH is older than the install). */
export function agyPath(): string | undefined {
  return process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : undefined;
}

/**
 * Commands the code page can start in its terminal by name (never a command from the request).
 *
 * Antigravity CLI (`agy`) is Google's own coding agent. Since June 18, 2026 it is the one a Google AI Pro or
 * Ultra subscription signs in to (Gemini CLI kept only paid API keys and business accounts). It signs in with
 * the user's Google account itself and KesherAI only shows its terminal, so the sign-in never passes through
 * KesherAI (Google forbids third-party apps from using the subscription's sign-in themselves; see
 * docs/RESEARCH_LOG.md). Its installer is Google's PowerShell script (Windows only here).
 */
export const AGENT_CLIS: Record<string, string> = {
  agy: "agy",
  "agy-install": "irm https://antigravity.google/cli/install.ps1 | iex",
  "agy-update": "agy update",
  // Claude Code (Anthropic's CLI agent) on KesherAI's own model, like `ollama launch claude`: its requests go to
  // KesherAI's Anthropic-compatible /v1/messages (any model name it sends goes to the active chat model), so no
  // Anthropic account or key is used. The environment comes from LOCAL_ENV.
  "claude-local": "claude",
};

/**
 * Environment for the commands that run on KesherAI's own model.
 *
 * @param run - The command's name.
 * @param port - KesherAI's port on this computer.
 */
export function agentEnv(run: string, port: number, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (run.startsWith("agy")) {
    // A fresh install is not on KesherAI's PATH yet: put the installer's folder first (Windows names it "Path").
    const exe = agyPath();
    if (!exe) return {};
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    return { [key]: `${dirname(exe)};${env[key] ?? ""}` };
  }
  if (run !== "claude-local") return {};
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    // Local requests need no key; Claude Code only wants one set (and must not fall back to the user's own key).
    ANTHROPIC_AUTH_TOKEN: "kesher-local",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** The user's shell. */
function shell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.ComSpec?.toLowerCase().includes("powershell") ? process.env.ComSpec : "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.SHELL || "bash", args: ["-l"] };
}

/** A shell over pipes, when node-pty is not available. */
function pipeShell(cwd: string): Pty {
  const sh = shell();
  const child = spawn(sh.file, process.platform === "win32" ? ["-NoLogo", "-NoExit", "-Command", "-"] : ["-i"], { cwd, env: process.env, windowsHide: true });
  return {
    onData: (cb) => {
      child.stdout.on("data", (b: Buffer) => cb(b.toString()));
      child.stderr.on("data", (b: Buffer) => cb(b.toString()));
    },
    onExit: (cb) => child.on("exit", (code) => cb({ exitCode: code ?? 0 })),
    write: (d) => child.stdin.write(d.replace(/\r/g, "\n")),
    resize: () => undefined,
    kill: () => child.kill(),
  };
}

/**
 * @param app - Fastify instance (with @fastify/websocket registered).
 * @param s - Services.
 */
export async function terminalRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const folderOf = async (id: string) => {
    const c = await s.library.getConversation(id);
    return c ? s.conversations.workspaceOf(c) : undefined;
  };

  /** Whether Antigravity CLI and Claude Code are on this computer, for the terminal's buttons. */
  app.get("/api/agent-clis", async () => {
    const find = (cmd: string) =>
      new Promise<string | undefined>((resolve) => {
        const p = spawn(process.platform === "win32" ? "where" : "which", [cmd], { windowsHide: true });
        let out = "";
        p.stdout.on("data", (b: Buffer) => (out += b.toString()));
        p.on("error", () => resolve(undefined));
        p.on("close", (code) => resolve(code === 0 ? out.split(/\r?\n/)[0]?.trim() || undefined : undefined));
      });
    const local = agyPath();
    const [agy, claude, agyLocal] = await Promise.all([find("agy"), find("claude"), local ? stat(local).then(() => true, () => false) : false]);
    return { agy: { installed: !!agy || agyLocal, canInstall: process.platform === "win32" }, claude: { installed: !!claude } };
  });

  /**
   * A terminal in the conversation's folder. Messages from the browser are
   * JSON: `{ "type": "input", "data": "…" }` or `{ "type": "resize", "cols", "rows" }`;
   * the server sends the terminal's output as plain text.
   */
  app.get<{ Params: { id: string }; Querystring: { run?: string } }>("/api/conversations/:id/terminal", { websocket: true }, async (socket, req) => {
    const cwd = await folderOf(req.params.id);
    const run = req.query.run ? AGENT_CLIS[req.query.run] : undefined;
    if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
      socket.send("\r\nThis conversation has no folder.\r\n");
      socket.close();
      return;
    }
    const mod = loadPty();
    const sh = shell();
    const port = Number(/:(\d+)$/.exec(String(req.headers.host ?? ""))?.[1] ?? 7420);
    const extra = run && req.query.run ? agentEnv(req.query.run, port) : {};
    const term: Pty = mod
      ? mod.spawn(sh.file, sh.args, { name: "xterm-256color", cols: 100, rows: 30, cwd, env: { ...process.env, TERM: "xterm-256color", ...extra } })
      : pipeShell(cwd);
    if (!mod) socket.send("(Simple terminal: interactive programs may not work.)\r\n");
    // A coding agent's own CLI (Antigravity CLI): typed into the shell as if the user did, so it signs in and runs as itself.
    if (run) setTimeout(() => term.write(`${run}\r`), 400);
    term.onData((d) => {
      if (socket.readyState === 1) socket.send(d);
    });
    term.onExit(({ exitCode }) => {
      if (socket.readyState === 1) {
        socket.send(`\r\n[exited with code ${exitCode}]\r\n`);
        socket.close();
      }
    });
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
        if (msg.type === "input" && typeof msg.data === "string") term.write(msg.data);
        if (msg.type === "resize" && msg.cols && msg.rows) term.resize(Math.max(10, msg.cols), Math.max(4, msg.rows));
      } catch {
        // ignore malformed messages
      }
    });
    socket.on("close", () => term.kill());
  });

  /** One file's text, for the editor. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/conversations/:id/files/text", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const full = await resolveInWorkspace(root, req.query.path ?? "");
      const st = await stat(full);
      if (st.size > 2 * 1024 ** 2) return reply.code(413).send({ error: "This file is too big to open in the editor (over 2 MB)." });
      const buf = await readFile(full);
      if (buf.includes(0)) return reply.code(415).send({ error: "This is not a text file." });
      return { path: req.query.path, text: buf.toString("utf8") };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Saves a file from the editor. */
  app.put<{ Params: { id: string }; Body: { path?: string; text?: string } }>("/api/conversations/:id/files/text", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const full = await resolveInWorkspace(root, req.body?.path ?? "");
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, req.body?.text ?? "");
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
