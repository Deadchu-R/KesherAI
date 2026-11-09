import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Connects Unity AI Assistant (Unity 6's built-in assistant) to KesherAI: it
 * adds KesherAI's MCP server to the project's `UserSettings/mcp.json` (Unity's
 * own place for external MCP servers, kept out of source control), so the
 * Assistant can use KesherAI's local models (`ask_model`), image generation,
 * knowledge search and transcription as tools. Other servers in the file are
 * kept; KesherAI's entry is replaced.
 *
 * @param project - The Unity project folder.
 * @param url - KesherAI's MCP address on this computer (http://127.0.0.1:<port>/mcp).
 * @param key - A connector key that opens only the MCP server.
 * @returns The file written.
 */
export async function connectUnityAssistant(project: string, url: string, key: string): Promise<string> {
  if (!existsSync(join(project, "Assets"))) throw new Error("That is not a Unity project folder.");
  if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) throw new Error("Only KesherAI on this computer.");
  const dir = join(project, "UserSettings");
  const file = join(dir, "mcp.json");
  let cfg: { enabled?: boolean; path?: string; mcpServers?: Record<string, unknown> } = {};
  const raw = await readFile(file, "utf8").catch(() => "");
  if (raw) {
    try {
      cfg = JSON.parse(raw) as typeof cfg;
    } catch {
      throw new Error("UserSettings/mcp.json is not valid JSON: fix or remove it, then try again.");
    }
  }
  cfg.enabled = true;
  cfg.path ??= "";
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), kesherai: { type: "http", url, headers: { Authorization: `Bearer ${key}` } } };
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}
