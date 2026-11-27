import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { strFromU8, unzipSync } from "fflate";
import { buildManifest, buildMcpb, findBridgeFile, mcpbFromDisk } from "./claude-extension.js";

const TOOLS = [
  { name: "kesher_tasks", description: "Lists the task inbox." },
  { name: "kesher_task_action", description: "Run, queue, stop or assign a task. ".repeat(20) },
];
const URL_ = "http://127.0.0.1:7420/mcp";

test("extension manifest: MCPB shape, the address as a default, the key a sensitive field the user pastes, no secret inside", () => {
  const m = buildManifest({ version: "0.6.499", url: URL_, tools: TOOLS }) as { manifest_version: string; name: string; version: string; server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } }; user_config: Record<string, { default?: string; sensitive?: boolean; required?: boolean }>; tools: Array<{ name: string; description: string }>; compatibility: { platforms: string[] } };
  assert.equal(m.manifest_version, "0.2");
  assert.equal(m.name, "kesherai");
  assert.equal(m.version, "0.6.499");
  assert.equal(m.server.type, "node");
  assert.equal(m.server.entry_point, "server/index.js");
  assert.equal(m.server.mcp_config.command, "node");
  assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/server/index.js"]);
  assert.deepEqual(m.server.mcp_config.env, { KESHER_MCP_URL: "${user_config.server_url}", KESHER_TOKEN: "${user_config.access_key}" });
  assert.equal(m.user_config.server_url.default, URL_);
  assert.equal(m.user_config.access_key.sensitive, true);
  assert.equal(m.user_config.access_key.required, false);
  assert.ok(!("default" in m.user_config.access_key), "no key is shipped");
  assert.deepEqual(m.tools.map((t: { name: string }) => t.name), ["kesher_tasks", "kesher_task_action"]);
  assert.ok(m.tools.every((t: { description: string }) => t.description.length <= 240));
  assert.ok(m.compatibility.platforms.includes("win32") && m.compatibility.platforms.includes("darwin"));
  assert.equal((buildManifest({ version: "dev", url: URL_, tools: [] }) as { version: string }).version, "0.0.0", "a version that is not semver is replaced");
  assert.doesNotMatch(JSON.stringify(m), /Bearer|kh_|sk-|\/home\/|C:\\\\Users/);
});

test("extension file: a zip with the manifest and the bridge, the same bytes every time", async () => {
  const bridge = "// bridge\n";
  const a = buildMcpb({ version: "0.6.499", url: URL_, tools: TOOLS, bridge });
  const files = unzipSync(a);
  assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "server/index.js"]);
  assert.equal(strFromU8(files["server/index.js"]!), bridge);
  assert.equal(JSON.parse(strFromU8(files["manifest.json"]!)).name, "kesherai");
  assert.deepEqual(buildMcpb({ version: "0.6.499", url: URL_, tools: TOOLS, bridge }), a);
  // From the repo's real bridge file.
  const file = findBridgeFile();
  assert.ok(file, "the bridge file is in the repo");
  const real = unzipSync((await mcpbFromDisk({ version: "0.6.499", url: URL_, tools: TOOLS }))!);
  assert.equal(strFromU8(real["server/index.js"]!), readFileSync(file!, "utf8"));
});

/** Runs the bridge program against a fake KesherAI; sends the lines, returns what it printed and what the server got. */
async function runBridge(env: Record<string, string>, lines: string[], args: string[] = []) {
  const got: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      const msg = JSON.parse(body) as { id?: number; method?: string };
      if (msg.id === undefined) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const child = spawn(process.execPath, [findBridgeFile()!, ...args], { env: { PATH: process.env.PATH ?? "", KESHER_MCP_URL: url, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.stdin.end(lines.map((l) => `${l}\n`).join(""));
  const [code] = (await once(child, "close")) as [number];
  server.close();
  return { code, out: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), err, got };
}

test("bridge: forwards each line to the server and prints its answer; a notification prints nothing", async () => {
  const r = await runBridge({}, [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "not json"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.length, 2);
  assert.deepEqual(r.out.find((m) => m.id === 1), { jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } });
  assert.equal((r.out.find((m) => m.id === null)!.error as { code: number }).code, -32700, "a bad line is a parse error, not a crash");
  assert.equal(r.got.length, 2, "both valid messages reached the server");
  assert.equal(r.got[0]!.headers.authorization, undefined, "no key, no header");
});

test("bridge: the connection key goes as a bearer token; an empty or unfilled setting counts as not set", async () => {
  const msg = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
  const keyed = await runBridge({ KESHER_TOKEN: "abc123" }, [msg]);
  assert.equal(keyed.got[0]!.headers.authorization, "Bearer abc123");
  for (const unset of ["", "  ", "${user_config.access_key}"]) {
    const r = await runBridge({ KESHER_TOKEN: unset }, [msg]);
    assert.equal(r.got[0]!.headers.authorization, undefined, JSON.stringify(unset));
  }
});

test("bridge: an address that is not http(s) stops it with a message", async () => {
  const r = await runBridge({ KESHER_MCP_URL: "file:///etc/passwd" }, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /must start with http/);
});
