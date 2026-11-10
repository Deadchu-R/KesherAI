import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./mcp.js";

/**
 * Importing MCP servers other apps already set up (Claude Desktop, Claude
 * Code, Cursor, VS Code, Windsurf, Gemini CLI, Jan), so they need not be typed
 * again. Their config files are only read. Imported servers start turned off:
 * a config file can name any program, so the user turns each on after seeing
 * its command. Values of environment variables (often API keys) are copied
 * only when the user asks; otherwise just their names are shown.
 */

/** One app's config file. */
export interface McpSource {
  app: string;
  file: string;
}

/** A server found in another app's config. */
export interface FoundMcpServer {
  app: string;
  file: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Names of its environment variables (values are not shown). */
  envNames: string[];
  /** Names of its HTTP headers (values are not shown). */
  headerNames: string[];
}

/**
 * Where apps keep their MCP config on this computer.
 *
 * @param home - Home folder (tests pass a temp folder).
 * @param env - Environment (`APPDATA`).
 * @returns Candidate files; they may not exist.
 */
export function mcpSources(home = homedir(), env: NodeJS.ProcessEnv = process.env): McpSource[] {
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const mac = join(home, "Library", "Application Support");
  return [
    { app: "Claude Desktop", file: join(appData, "Claude", "claude_desktop_config.json") },
    { app: "Claude Desktop", file: join(mac, "Claude", "claude_desktop_config.json") },
    { app: "Claude Code", file: join(home, ".claude.json") },
    { app: "Cursor", file: join(home, ".cursor", "mcp.json") },
    { app: "VS Code", file: join(appData, "Code", "User", "mcp.json") },
    { app: "VS Code", file: join(mac, "Code", "User", "mcp.json") },
    { app: "Windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json") },
    { app: "Gemini CLI", file: join(home, ".gemini", "settings.json") },
    { app: "Jan", file: join(appData, "Jan", "data", "extensions", "mcp", "servers.json") },
    { app: "Jan", file: join(mac, "Jan", "data", "extensions", "mcp", "servers.json") },
    { app: "Copilot CLI", file: join(home, ".copilot", "mcp-config.json") },
    { app: "Antigravity", file: join(home, ".gemini", "antigravity", "mcp_config.json") },
    { app: "Antigravity CLI", file: join(home, ".gemini", "antigravity-cli", "mcp_config.json") },
  ];
}

/**
 * Claude Desktop installed from the Microsoft Store keeps its config inside
 * its package folder (`Packages\Claude_<id>\LocalCache\Roaming\Claude`),
 * found on Roee's PC.
 *
 * @param home - Home folder.
 * @param env - Environment (`LOCALAPPDATA`).
 * @returns Those files; they may not exist.
 */
export async function storeAppSources(home = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<McpSource[]> {
  const packages = join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Packages");
  const dirs = await readdir(packages).catch(() => [] as string[]);
  return dirs.filter((d) => /^Claude_/i.test(d)).map((d) => ({ app: "Claude Desktop", file: join(packages, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json") }));
}

async function allSources(): Promise<McpSource[]> {
  return [...mcpSources(), ...(await storeAppSources())];
}

type Entry = { command?: unknown; args?: unknown; env?: unknown; url?: unknown; serverUrl?: unknown; httpUrl?: unknown; headers?: unknown; type?: unknown };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

/**
 * Reads the servers in one config file's JSON: `mcpServers` (Claude, Cursor,
 * Windsurf, Gemini, Jan) or `servers` (VS Code), each with a command
 * (stdio) or a URL (`url`, `serverUrl`, `httpUrl`).
 *
 * @param json - The file's parsed JSON.
 * @returns Servers as KesherAI would add them (off), with their names.
 */
export function serversIn(json: unknown): Array<{ name: string; entry: Entry }> {
  if (!json || typeof json !== "object") return [];
  const o = json as { mcpServers?: unknown; servers?: unknown };
  const map = (o.mcpServers ?? o.servers) as Record<string, Entry> | undefined;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map)
    .filter(([name, e]) => name && e && typeof e === "object" && (typeof e.command === "string" || typeof (e.url ?? e.serverUrl ?? e.httpUrl) === "string"))
    .map(([name, entry]) => ({ name, entry }));
}

function describe(app: string, file: string, name: string, e: Entry): FoundMcpServer {
  const url = [e.url, e.serverUrl, e.httpUrl].find((u): u is string => typeof u === "string");
  return {
    app,
    file,
    name,
    transport: typeof e.command === "string" ? "stdio" : "http",
    ...(typeof e.command === "string" ? { command: e.command, args: strings(e.args) } : {}),
    ...(typeof e.command !== "string" && url ? { url } : {}),
    envNames: Object.keys(record(e.env)),
    headerNames: Object.keys(record(e.headers)),
  };
}

/**
 * Looks in every known app's config for MCP servers.
 *
 * @param sources - Files to read (default: {@link mcpSources}).
 * @returns What was found, per server.
 */
export async function findMcpServers(given?: McpSource[]): Promise<FoundMcpServer[]> {
  const sources = given ?? (await allSources());
  const out: FoundMcpServer[] = [];
  for (const s of sources) {
    const text = await readFile(s.file, "utf8").catch(() => undefined);
    if (!text) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    for (const { name, entry } of serversIn(json)) out.push(describe(s.app, s.file, name, entry));
  }
  return out;
}

/**
 * The KesherAI server for one found server, read again from its file (the
 * page only names it), turned off.
 *
 * @param app - Which app.
 * @param name - Its name there.
 * @param withSecrets - Copy env values and header values too.
 * @param taken - Ids already used in KesherAI.
 * @param sources - Files to read.
 * @returns The config to add, or undefined when it is not there.
 */
export async function importMcpServer(app: string, name: string, withSecrets: boolean, taken: ReadonlySet<string>, given?: McpSource[]): Promise<McpServerConfig | undefined> {
  const sources = given ?? (await allSources());
  for (const s of sources.filter((x) => x.app === app)) {
    const json = await readFile(s.file, "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);
    const hit = serversIn(json).find((x) => x.name === name);
    if (!hit) continue;
    const e = hit.entry;
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "server";
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    const env = record(e.env);
    const headers = record(e.headers);
    const url = [e.url, e.serverUrl, e.httpUrl].find((u): u is string => typeof u === "string");
    if (typeof e.command !== "string" && !(url && /^https?:\/\//i.test(url))) return undefined;
    return typeof e.command === "string"
      ? { id, name: `${name} (${app})`, transport: "stdio", command: e.command, args: strings(e.args), ...(withSecrets && Object.keys(env).length ? { env } : {}), enabled: false }
      : { id, name: `${name} (${app})`, transport: "http", url: url!, ...(withSecrets && Object.keys(headers).length ? { headers } : {}), enabled: false };
  }
  return undefined;
}
