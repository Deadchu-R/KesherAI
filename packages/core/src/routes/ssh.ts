import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocalRequest } from "../auth.js";
import type { KesherServices } from "../services.js";

/**
 * A project on another computer over SSH (RESEARCH_LOG "SSH targets"): SSHFS-Win shows its files as a Windows path,
 * commands run there over Windows' own ssh (agent/shell.ts). These routes check what is ready, make the key once, and
 * install SSHFS-Win (an optional component, on the user's click). All for this computer only; a password is never typed.
 */

const SSHFS = ["C:\\Program Files\\SSHFS-Win\\bin\\sshfs.exe", "C:\\Program Files (x86)\\SSHFS-Win\\bin\\sshfs.exe"];
const keyFile = () => join(homedir(), ".ssh", "id_rsa");

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (e, stdout, stderr) => ok({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}`.slice(-2000) }));
  });
}

/** user@host with a port, checked (letters, digits, dots and dashes only). */
export function sshLogin(target: string, port?: number): { login: string; port: number } | undefined {
  const m = /^([\w.-]{1,64})@([\w.-]{1,253})$/.exec(target.trim());
  const p = Math.round(Number(port ?? 22));
  if (!m || !(p > 0 && p < 65536)) return undefined;
  return { login: `${m[1]}@${m[2]}`, port: p };
}

/**
 * SSHFS-Win's path for a folder on another computer (key sign-in; `.kr` from the root for an absolute folder).
 *
 * @example sshfsPath("roee@box", 22, "/home/roee/game") → \\sshfs.kr\roee@box\home\roee\game
 */
export function sshfsPath(login: string, port: number, folder: string): string {
  const abs = folder.trim().startsWith("/");
  const rest = folder.trim().replace(/^~\/?/, "").replace(/^\/+|\/+$/g, "").replace(/\//g, "\\");
  return `\\\\sshfs.k${abs ? "r" : ""}\\${login}${port === 22 ? "" : `!${port}`}${rest ? `\\${rest}` : ""}`;
}

/** The SSH routes (this computer only). */
export async function sshRoutes(app: FastifyInstance, _s: KesherServices): Promise<void> {
  const local = (req: Parameters<typeof isLocalRequest>[0]) => isLocalRequest(req);
  /** What is ready: SSHFS-Win, the key (and its public line to add on the server). */
  app.get("/api/ssh", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Only on this computer." });
    const pub = await readFile(`${keyFile()}.pub`, "utf8").catch(() => "");
    return { windows: process.platform === "win32", sshfs: SSHFS.some((p) => existsSync(p)), key: existsSync(keyFile()), publicKey: pub.trim() };
  });
  /** Makes the key once (RSA, the one SSHFS-Win's key paths use); an existing key is never replaced. */
  app.post("/api/ssh/key", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Only on this computer." });
    if (!existsSync(keyFile())) {
      await mkdir(join(homedir(), ".ssh"), { recursive: true });
      const r = await run("ssh-keygen", ["-q", "-t", "rsa", "-b", "4096", "-N", "", "-C", "kesherai", "-f", keyFile()], 60_000);
      if (r.code) return reply.code(500).send({ error: `ssh-keygen could not make the key: ${r.out.trim().slice(0, 300)}` });
    }
    return { publicKey: (await readFile(`${keyFile()}.pub`, "utf8")).trim() };
  });
  /** Tries the connection with the key only (BatchMode: never asks for a password). */
  app.post<{ Body: { target?: string; port?: number } }>("/api/ssh/check", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Only on this computer." });
    const t = sshLogin(String(req.body?.target ?? ""), req.body?.port);
    if (!t) return reply.code(400).send({ error: "Write it as user@host." });
    const r = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-p", String(t.port), t.login, "echo kesher-ok"], 20_000);
    if (r.out.includes("kesher-ok")) return { ok: true };
    const why = /permission denied|publickey/i.test(r.out) ? "key" : /could not resolve|timed out|refused|unreachable|no route/i.test(r.out) ? "reach" : /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(r.out) ? "hostkey" : "other";
    return { ok: false, why, detail: r.out.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300) };
  });
  /** Installs WinFsp and SSHFS-Win with winget (the user clicked Install). */
  app.post("/api/ssh/install", async (req, reply) => {
    if (!local(req) || process.platform !== "win32") return reply.code(403).send({ error: "Only on this Windows computer." });
    for (const id of ["WinFsp.WinFsp", "SSHFS-Win.SSHFS-Win"]) {
      const r = await run("winget", ["install", "--id", id, "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"], 10 * 60_000);
      if (r.code && !/already installed|no newer/i.test(r.out)) return reply.code(500).send({ error: `${id} did not install: ${r.out.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? ""}` });
    }
    return { sshfs: SSHFS.some((p) => existsSync(p)) };
  });
  /** The project folder path for a folder there. */
  app.post<{ Body: { target?: string; port?: number; folder?: string } }>("/api/ssh/path", async (req, reply) => {
    const t = sshLogin(String(req.body?.target ?? ""), req.body?.port);
    if (!t) return reply.code(400).send({ error: "Write it as user@host." });
    const folder = String(req.body?.folder ?? "");
    if (/[\\\0]|\.\.\//.test(folder)) return reply.code(400).send({ error: "A folder like /home/me/game or ~/game." });
    return { path: sshfsPath(t.login, t.port, folder) };
  });
}
