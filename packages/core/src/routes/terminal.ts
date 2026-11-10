import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { stat, writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
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

  /**
   * A terminal in the conversation's folder. Messages from the browser are
   * JSON: `{ "type": "input", "data": "…" }` or `{ "type": "resize", "cols", "rows" }`;
   * the server sends the terminal's output as plain text.
   */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/terminal", { websocket: true }, async (socket, req) => {
    const cwd = await folderOf(req.params.id);
    if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
      socket.send("\r\nThis conversation has no folder.\r\n");
      socket.close();
      return;
    }
    const mod = loadPty();
    const sh = shell();
    const term: Pty = mod
      ? mod.spawn(sh.file, sh.args, { name: "xterm-256color", cols: 100, rows: 30, cwd, env: { ...process.env, TERM: "xterm-256color" } })
      : pipeShell(cwd);
    if (!mod) socket.send("(Simple terminal: interactive programs may not work.)\r\n");
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
