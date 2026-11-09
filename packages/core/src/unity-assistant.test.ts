import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectUnityAssistant } from "./unity-assistant.js";

test("adds KesherAI to Unity AI Assistant's MCP servers, keeping the others", async () => {
  const p = await mkdtemp(join(tmpdir(), "uproj-"));
  await mkdir(join(p, "Assets"));
  await mkdir(join(p, "UserSettings"));
  await writeFile(join(p, "UserSettings", "mcp.json"), JSON.stringify({ enabled: false, mcpServers: { git: { type: "stdio", command: "uvx", args: ["mcp-server-git"] } } }));
  await connectUnityAssistant(p, "http://127.0.0.1:7420/mcp", "kd_x");
  const cfg = JSON.parse(await readFile(join(p, "UserSettings", "mcp.json"), "utf8"));
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.mcpServers.git, "the user's server is kept");
  assert.deepEqual(cfg.mcpServers.kesherai, { type: "http", url: "http://127.0.0.1:7420/mcp", headers: { Authorization: "Bearer kd_x" } });
  await assert.rejects(connectUnityAssistant(p, "https://evil.example/mcp", "k"), /this computer/);
  await assert.rejects(connectUnityAssistant(await mkdtemp(join(tmpdir(), "x-")), "http://127.0.0.1:7420/mcp", "k"), /not a Unity project/);
});
