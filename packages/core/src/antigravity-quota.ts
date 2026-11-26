/**
 * Antigravity's model quota, read on this PC from Antigravity's own local language server (read-only), the way the
 * open-source "Antigravity quota" watchers do (research r-20261126-09): find the `language_server` process, take its
 * CSRF token from its command line, find the ports it listens on, and ask `GetUserStatus`. Each model in the answer
 * has `quotaInfo { remainingFraction, resetTime }`.
 *
 * Nothing leaves the PC: the requests go to 127.0.0.1 only. When anything is missing (Antigravity closed, a new
 * version with another shape) the reading is `undefined` and the inbox keeps its old guess from error texts.
 */
import { execFile } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { AntigravityQuota, AntigravityModelQuota } from "@kesher/shared";

/** Runs a program and returns what it printed (empty on any failure). */
export type RunText = (file: string, args: string[]) => Promise<string>;

/** Sends one POST to 127.0.0.1 and returns the body, or undefined. */
export type PostLocal = (port: number, path: string, body: string, headers: Record<string, string>, tls: boolean) => Promise<string | undefined>;

const runText: RunText = (file, args) =>
  new Promise((res) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => res(String(out ?? "")));
  });

/** The longest answer read from the language server. */
const MAX_BODY = 1024 * 1024;

const postLocal: PostLocal = (port, path, body, headers, tls) =>
  new Promise((res) => {
    const opts = { host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) }, timeout: 5000 };
    // The language server's certificate is its own (self-signed); the host is fixed to 127.0.0.1, so nothing else is trusted.
    const req = tls ? httpsRequest({ ...opts, rejectUnauthorized: false }) : httpRequest(opts);
    req.on("response", (r) => {
      let s = "";
      r.setEncoding("utf8");
      // A status answer is a few KB: anything past MAX_BODY is not one (and must not fill memory).
      r.on("data", (c: string) => {
        s += c;
        if (s.length > MAX_BODY) {
          req.destroy();
          res(undefined);
        }
      });
      r.on("end", () => res(r.statusCode && r.statusCode < 300 ? s : undefined));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => res(undefined));
    req.end(body);
  });

/** One running language server: its process id, CSRF token, and the port its command line names (if any). */
export interface LangServer {
  pid: number;
  csrf: string;
  port?: number;
}

/**
 * The Antigravity language servers in a process list.
 *
 * @param lines - `pid<TAB or space>command line` per line.
 * @returns Those that are Antigravity's (`language_server…` with `--csrf_token`).
 */
export function parseServers(lines: string): LangServer[] {
  const out: LangServer[] = [];
  for (const line of lines.split(/\r?\n/)) {
    const m = /^\s*(\d+)[\s,]+(.*)$/.exec(line);
    if (!m || !/language_server/i.test(m[2]!) || !/antigravity/i.test(m[2]!)) continue;
    const csrf = /--csrf_token[= ]"?([\w-]+)/.exec(m[2]!)?.[1];
    if (!csrf) continue;
    const port = Number(/--extension_server_port[= ]"?(\d+)/.exec(m[2]!)?.[1]) || undefined;
    out.push({ pid: Number(m[1]), csrf, ...(port ? { port } : {}) });
  }
  return out;
}

/**
 * The TCP ports a process listens on, from `netstat -ano` (Windows) or `lsof -nP -iTCP -sTCP:LISTEN` (macOS, Linux).
 *
 * @param text - The tool's output.
 * @param pid - The process.
 * @returns The ports.
 */
export function listeningPorts(text: string, pid: number): number[] {
  const ports = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const win = /^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (win && Number(win[2]) === pid) ports.add(Number(win[1]));
    const lsof = /^\S+\s+(\d+)\s.*TCP\s+(?:127\.0\.0\.1|\*|\[::1\]|localhost):(\d+)\s+\(LISTEN\)/.exec(line);
    if (lsof && Number(lsof[1]) === pid) ports.add(Number(lsof[2]));
  }
  return [...ports];
}

/**
 * The models' quota in a `GetUserStatus` answer, wherever it sits (the shape moved between versions): every object
 * with a `quotaInfo` and a label or model name.
 *
 * @param json - The parsed answer.
 * @param now - The time (ms), for `at`.
 * @returns The reading, or undefined when no model has quota info.
 */
export function readQuota(json: unknown, now: number): AntigravityQuota | undefined {
  const models: AntigravityModelQuota[] = [];
  const seen = new Set<string>();
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== "object" || depth > 12) return;
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    const o = x as Record<string, unknown>;
    const q = o.quotaInfo as { remainingFraction?: unknown; resetTime?: unknown } | undefined;
    const name = typeof o.label === "string" ? o.label : typeof o.modelName === "string" ? o.modelName : typeof o.model === "string" ? o.model : undefined;
    if (q && typeof q === "object" && name && !seen.has(name) && models.length < 40) {
      seen.add(name);
      // An exhausted model has no `remainingFraction` in the answer (proto3 drops a zero).
      const left = typeof q.remainingFraction === "number" ? Math.max(0, Math.min(1, q.remainingFraction)) : 0;
      const reset = typeof q.resetTime === "string" ? Date.parse(q.resetTime) : NaN;
      models.push({ name: name.slice(0, 80), left, ...(Number.isFinite(reset) ? { resetAt: reset } : {}) });
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json, 0);
  return models.length ? { at: now, models } : undefined;
}

const PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const BODY = JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } });

/**
 * Reads Antigravity's quota now.
 *
 * @param o.platform - `process.platform` (tests pass another).
 * @param o.run - Runs a program (tests pass a fake).
 * @param o.post - Sends the local request (tests pass a fake).
 * @param o.now - The time.
 * @returns The reading, or undefined (Antigravity is not running, or its answer has no quota).
 */
export async function readAntigravityQuota(o: { platform?: NodeJS.Platform; run?: RunText; post?: PostLocal; now?: number } = {}): Promise<AntigravityQuota | undefined> {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? runText;
  const post = o.post ?? postLocal;
  const now = o.now ?? Date.now();
  const list =
    platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name like 'language_server%'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"])
      : // `-x` without `-a`: this user's own processes only (another account's fake "language_server" is never asked).
        await run("ps", ["-x", "-o", "pid=,command="]);
  const servers = parseServers(list);
  if (!servers.length) return undefined;
  const net = platform === "win32" ? await run("netstat", ["-ano", "-p", "TCP"]) : await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  for (const s of servers) {
    // Only ports the server's own process listens on: the command line's `--extension_server_port` belongs to another
    // process (or to whoever bound it), and the request carries the language server's CSRF token.
    const ports = listeningPorts(net, s.pid);
    for (const port of ports) {
      for (const tls of [true, false]) {
        const text = await post(port, PATH, BODY, { "content-type": "application/json", "connect-protocol-version": "1", "x-codeium-csrf-token": s.csrf }, tls);
        if (!text) continue;
        try {
          const q = readQuota(JSON.parse(text), now);
          if (q) return q;
        } catch {
          /* not this port */
        }
      }
    }
  }
  return undefined;
}

/**
 * When Antigravity can run again: undefined while any model has quota left; else the earliest reset among the
 * models (or undefined when none says).
 *
 * @param q - The reading.
 * @returns The time (ms), or undefined.
 */
export function quotaBackAt(q: AntigravityQuota): number | undefined {
  if (q.models.some((m) => m.left > 0)) return undefined;
  const r = q.models.map((m) => m.resetAt).filter((x): x is number => x !== undefined);
  return r.length ? Math.min(...r) : undefined;
}
