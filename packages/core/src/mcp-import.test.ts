import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMcpServers, importMcpServer, mcpSources, serversIn } from "./mcp-import.js";

test("Claude Desktop/Cursor (mcpServers) and VS Code (servers) configs are read; http servers by url/serverUrl/httpUrl", () => {
  assert.deepEqual(serversIn({ mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/x"] } } }).map((s) => s.name), ["fs"]);
  assert.deepEqual(serversIn({ servers: { gh: { type: "http", url: "https://api.githubcopilot.com/mcp/" } } }).map((s) => s.name), ["gh"]);
  assert.deepEqual(serversIn({ mcpServers: { w: { serverUrl: "https://x.dev/mcp" }, broken: { args: ["x"] } } }).map((s) => s.name), ["w"]);
  assert.deepEqual(serversIn("nope"), []);
});

test("found servers show their command and only the names of their keys; import is off, without secrets unless asked", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-mcpimp-"));
  const appData = join(home, "AppData", "Roaming");
  await mkdir(join(appData, "Claude"), { recursive: true });
  await writeFile(join(appData, "Claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { "GitHub Tools": { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "ghp_secret" } } } }));
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer x" } }, bad: { url: "file:///etc/passwd" } } }));
  await writeFile(join(home, ".claude.json"), "{ not json");
  const sources = mcpSources(home, { APPDATA: appData });
  const found = await findMcpServers(sources);
  assert.deepEqual(found.map((f) => `${f.app}:${f.name}`).sort(), ["Claude Desktop:GitHub Tools", "Cursor:bad", "Cursor:linear"]);
  const gh = found.find((f) => f.name === "GitHub Tools")!;
  assert.deepEqual(gh.envNames, ["GITHUB_TOKEN"]);
  assert.ok(!JSON.stringify(found).includes("ghp_secret"), "no secret values in the list");

  const plain = await importMcpServer("Claude Desktop", "GitHub Tools", false, new Set(["github-tools"]), sources);
  assert.equal(plain?.id, "github-tools-2");
  assert.equal(plain?.enabled, false);
  assert.equal(plain?.env, undefined);
  const withKeys = await importMcpServer("Claude Desktop", "GitHub Tools", true, new Set(), sources);
  assert.deepEqual(withKeys?.env, { GITHUB_TOKEN: "ghp_secret" });
  assert.equal((await importMcpServer("Cursor", "linear", false, new Set(), sources))?.url, "https://mcp.linear.app/sse");
  assert.equal(await importMcpServer("Cursor", "bad", true, new Set(), sources), undefined, "only http(s) addresses");
  assert.equal(await importMcpServer("Cursor", "GitHub Tools", true, new Set(), sources), undefined, "a name is looked up in that app only");
});

test("Claude Desktop from the Microsoft Store is found in its package folder", async () => {
  const { storeAppSources } = await import("./mcp-import.js");
  const home = await mkdtemp(join(tmpdir(), "kesher-msix-"));
  await mkdir(join(home, "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc"), { recursive: true });
  await mkdir(join(home, "AppData", "Local", "Packages", "Microsoft.Other_1"), { recursive: true });
  const s = await storeAppSources(home, {});
  assert.equal(s.length, 1);
  assert.match(s[0]!.file, /Claude_pzs8sxrjxfjjc[\\/]LocalCache[\\/]Roaming[\\/]Claude[\\/]claude_desktop_config\.json$/);
});
