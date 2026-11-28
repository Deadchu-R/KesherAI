/**
 * Chat checks' fixtures: a tiny web server on this computer (127.0.0.1, a free port) with fake pages for the browser
 * scenarios, the files a scenario puts in its chat's folder, and the auto-answer for approval cards, which allows
 * only what touches those fixtures (the fixture server's own pages, the scenario's folder, its listed commands) and
 * denies everything else. Real sites are never approved; "Always" is never given (no standing permission is saved).
 */
import { createServer, type Server } from "node:http";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import type { AgentEvent } from "@kesher/shared";

/** The fake pages, by path. Each has one fact a scenario asks about, so the answer proves the page was read. */
export const FIXTURE_PAGES: Record<string, string> = {
  "/article": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The North Point Lighthouse</title></head>
<body><main><h1>The North Point Lighthouse</h1>
<p>Built in 1871, the lighthouse stands on a granite spit north of the harbour.</p>
<p>Its last keeper was <strong>Ada Marlow</strong>, who kept the lamp lit for 31 years until it was automated in 1964.</p>
<p>Today the tower is a small museum, open on weekends.</p></main></body></html>`,
  "/login": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in · Example Portal</title></head>
<body><main><h1>Sign in to Example Portal</h1>
<form action="/login" method="post" autocomplete="off">
<label>Email <input type="email" name="email" aria-label="Email"></label>
<label>Password <input type="password" name="password" aria-label="Password"></label>
<button type="submit">Sign in</button></form></main></body></html>`,
};

/** A running fixture server. */
export interface FixtureServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** @returns The full address of a fixture page, e.g. `url("/article")`. */
  url(path: string): string;
  close(): Promise<void>;
}

/**
 * Starts the fixture server on 127.0.0.1 (never on other interfaces), on a free port.
 *
 * @param pages - Paths and their HTML (default: {@link FIXTURE_PAGES}).
 * @returns The server; close it when the run ends.
 */
export async function startFixtureServer(pages: Record<string, string> = FIXTURE_PAGES): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const page = Object.hasOwn(pages, path) ? pages[path] : undefined;
    // Only GET of a known page; a form post (the login page) gets the same page back, so nothing is ever "signed in".
    if (!page || (req.method !== "GET" && req.method !== "HEAD" && path !== "/login")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : page);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (path) => origin + path,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/** A file a scenario puts in its folder: its text, or a function that makes it (big files). */
export type FixtureFile = string | (() => string);

/**
 * Writes a scenario's files into its chat's folder.
 *
 * @param folder - The chat's folder (created if missing).
 * @param files - Relative names and their contents.
 */
export async function writeFixtureFiles(folder: string, files: Record<string, FixtureFile>): Promise<void> {
  await mkdir(folder, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = join(folder, name);
    if (!inside(folder, path)) throw new Error(`Fixture file outside its folder: ${name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof body === "function" ? body() : body, "utf8");
  }
}

/**
 * Lists a folder's files (two levels deep), for the checks that look at what the turn made.
 *
 * @param folder - The folder.
 * @returns Relative names with `/`, or [] when it is missing.
 */
export async function listFixtureFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 2) await walk(path, depth + 1);
      else if (e.isFile()) out.push(relative(folder, path).replace(/\\/g, "/"));
    }
  };
  await walk(folder, 0);
  return out.sort();
}

/** @returns Whether `path` is `folder` or inside it. */
function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** @returns Whether two folders are the same (letter case ignored on Windows). */
function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/** What one scenario's approvals may touch. */
export interface FixtureScope {
  /** The fixture server's origin (`http://127.0.0.1:<port>`); browser steps elsewhere are denied. */
  origin?: string;
  /** The scenario's folder; file tools must stay in it and commands must run there. */
  folder?: string;
  /** Whole commands the scenario allows (each must match the full command), e.g. `/^node build\.js$/`. */
  commands?: readonly RegExp[];
}

type ApprovalRequest = Pick<Extract<AgentEvent, { type: "approval_request" }>, "name" | "input" | "folder" | "scope">;

/**
 * Decides an approval card during a chat check: "allow" only for the scenario's fixtures, "deny" for the rest.
 *
 * @param req - The approval request (its tool, input, folder and site scope).
 * @param scope - What the scenario's fixtures are.
 * @returns The decision and why (the reason goes back to the model with a denial).
 */
export function fixtureDecision(req: ApprovalRequest, scope: FixtureScope): { decision: "allow" | "deny"; why: string } {
  const deny = (why: string) => ({ decision: "deny" as const, why: `Chat check: ${why}` });
  const allow = (why: string) => ({ decision: "allow" as const, why });
  if (req.name.startsWith("browser_")) {
    if (!scope.origin) return deny("this scenario has no web pages.");
    const fixtureHost = new URL(scope.origin).host;
    const url = typeof req.input.url === "string" ? req.input.url : undefined;
    if (url !== undefined) {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return deny("not a valid address.");
      }
      return origin === scope.origin ? allow("fixture page") : deny("only the local fixture pages are allowed.");
    }
    // A step on the page already open (click, type, read): the card's site must be the fixture server.
    return req.scope === fixtureHost ? allow("fixture page") : deny("only the local fixture pages are allowed.");
  }
  // A confirm card for a scheduled task (schedule_task): the call itself is what the check judges. Nothing is saved
  // during a check (a real schedule would keep running on the PC), so the card is always answered with "no".
  if (req.name === "schedule_task") return deny("nothing is saved during a check; the call was seen, that is enough.");
  if (req.name === "run_command") {
    if (!scope.folder || !req.folder || !sameFolder(req.folder, scope.folder)) return deny("commands may run only in the check's folder.");
    const command = String(req.input.command ?? "").trim();
    return scope.commands?.some((c) => c.test(command)) ? allow("fixture command") : deny("this command is not one the check allows.");
  }
  const path = typeof req.input.path === "string" ? req.input.path : undefined;
  if (path !== undefined && scope.folder) {
    return inside(scope.folder, isAbsolute(path) ? path : join(scope.folder, path)) ? allow("fixture folder") : deny("only files in the check's folder.");
  }
  return deny("only the check's fixtures are allowed.");
}
