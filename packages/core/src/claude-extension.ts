/**
 * The Claude Desktop extension (`.mcpb`, the MCP Bundle format) for KesherAI's own MCP server: a direct connection
 * from Claude Desktop on the same PC, no hub. A `.mcpb` is a zip with a `manifest.json` and the program Claude Desktop
 * starts (here the stdio-to-HTTP bridge `apps/desktop/resources/mcp-bridge.cjs`, run by Claude Desktop's own Node).
 *
 * Nothing secret is packed: the user's settings sit in `user_config`. The address defaults to this PC's KesherAI
 * (`http://127.0.0.1:<port>/mcp`, which needs no key from this PC); the optional connection key is a `sensitive` field
 * the user pastes (Claude Desktop keeps it in the system keychain) and is passed to the bridge as `KESHER_TOKEN`.
 * The bundle is built on request from the files in the repo (or the installed app's resources), not stored.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

/** One tool, as the manifest lists it. */
export interface ExtensionTool {
  name: string;
  description: string;
}

/**
 * The bridge program's file: the installed app's resources first, then the repo copy.
 *
 * @returns Its path, or undefined when neither exists.
 */
export function findBridgeFile(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return [resources && join(resources, "mcp-bridge.cjs"), resolve(here, "../../../apps/desktop/resources/mcp-bridge.cjs")].find((p): p is string => !!p && existsSync(p));
}

/**
 * The extension's `manifest.json` (MCPB manifest version 0.2, server type `node`).
 *
 * @param o - The app's version, the MCP server's default address and its tools.
 * @returns The manifest object.
 */
export function buildManifest(o: { version: string; url: string; tools: readonly ExtensionTool[] }): Record<string, unknown> {
  return {
    manifest_version: "0.2",
    name: "kesherai",
    display_name: "KesherAI",
    version: /^\d+\.\d+\.\d+/.test(o.version) ? o.version : "0.0.0",
    description: "Use KesherAI on this computer from Claude Desktop: its task inbox, quotas and agents, its local models, knowledge bases and chats.",
    long_description:
      "Connects Claude Desktop straight to KesherAI running on the same computer (no cloud hub). Claude can list and run your KesherAI tasks, see what is left of each AI provider, give KesherAI a task in a chat, and use its local models and knowledge. KesherAI must be running, with Settings › Use KesherAI from other apps turned on; the task tools also need Settings › Kesher Cloud › Claude connector may read and run.",
    author: { name: "KesherAI" },
    keywords: ["kesherai", "local-ai", "tasks", "agents"],
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.js"],
        env: { KESHER_MCP_URL: "${user_config.server_url}", KESHER_TOKEN: "${user_config.access_key}" },
      },
    },
    tools: o.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 240) })),
    user_config: {
      server_url: {
        type: "string",
        title: "KesherAI address",
        description: "Where KesherAI's MCP server listens. The default is right when KesherAI runs on this computer.",
        default: o.url,
        required: false,
      },
      access_key: {
        type: "string",
        title: "Connection key (only for another computer)",
        description: "Leave empty when KesherAI runs on this computer. Otherwise paste the key KesherAI gave you for this app.",
        sensitive: true,
        required: false,
      },
    },
    compatibility: { platforms: ["win32", "darwin", "linux"], runtimes: { node: ">=18.0.0" } },
  };
}

/**
 * The `.mcpb` file: the manifest and the bridge, zipped (fixed file times, so the same input gives the same bytes).
 *
 * @param o - What {@link buildManifest} takes, and the bridge program's source.
 * @returns The zip's bytes.
 */
export function buildMcpb(o: { version: string; url: string; tools: readonly ExtensionTool[]; bridge: Uint8Array | string }): Uint8Array {
  const mtime = new Date(Date.UTC(2026, 0, 1));
  const bridge = typeof o.bridge === "string" ? strToU8(o.bridge) : o.bridge;
  return zipSync({
    "manifest.json": [strToU8(`${JSON.stringify(buildManifest(o), null, 2)}\n`), { mtime }],
    "server/index.js": [bridge, { mtime }],
  });
}

/**
 * Reads the bridge from disk and builds the `.mcpb`.
 *
 * @param o - The app's version, the default address and the tools.
 * @returns The zip's bytes, or undefined when the bridge file is missing.
 */
export async function mcpbFromDisk(o: { version: string; url: string; tools: readonly ExtensionTool[] }): Promise<Uint8Array | undefined> {
  const file = findBridgeFile();
  return file ? buildMcpb({ ...o, bridge: await readFile(file) }) : undefined;
}
