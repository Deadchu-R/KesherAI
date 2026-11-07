import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { join } from "node:path";
import { MCP_PRESETS, McpManager, mcpResultText, mcpToolName, migratePreset, missingTool, presetHelp, rpcFromSse, unityRelay } from "./mcp.js";

const FAKE_STDIO = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") { console.log("a log line on stdout"); reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } }); }
    else if (m.method === "tools/list") reply({ tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }] });
    else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "you said " + m.params.arguments.text + " (" + process.env.SECRET + ")" }] });
  }
});
`;

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), "kesher-mcp-"));
  return { dir, mcp: new McpManager(join(dir, "mcp.json"), join(dir, "mcp-auth.json")) };
}

test("stdio server: connects, lists tools, calls them, hides secrets", async () => {
  const { dir, mcp } = await manager();
  const script = join(dir, "server.mjs");
  await writeFile(script, FAKE_STDIO);
  await mcp.load();
  await mcp.upsert({ id: "fake", name: "Fake", transport: "stdio", command: process.execPath, args: [script], env: { SECRET: "s3" }, enabled: true });
  await mcp.connect("fake");
  const st = mcp.statusOf("fake");
  assert.equal(st.state, "ready");
  assert.equal(st.server, "fake 1.0");
  const tools = mcp.tools();
  assert.equal(tools[0]!.name, "mcp_fake_echo");
  assert.match(tools[0]!.spec.description, /\[Fake\] Echoes/);
  const r = await mcp.call("fake", "echo", { text: "hi" });
  assert.equal(mcpResultText(r).text, "you said hi (s3)");
  assert.equal(mcp.list()[0]!.env!.SECRET, "••••");
  // Saving back the hidden value keeps the real one.
  await mcp.upsert({ ...mcp.list()[0]!, transport: "stdio", enabled: true });
  await mcp.connect("fake");
  assert.equal(mcpResultText(await mcp.call("fake", "echo", { text: "x" })).text, "you said x (s3)");
  mcp.close();
});

test("a program that does not exist reports an error", async () => {
  const { mcp } = await manager();
  await mcp.load();
  await mcp.upsert({ id: "nope", name: "Nope", transport: "stdio", command: "/definitely/not/here", enabled: false });
  await assert.rejects(mcp.connect("nope"));
  assert.equal(mcp.statusOf("nope").state, "error");
});

test("online server: asks to sign in, OAuth with PKCE, then SSE answers", async () => {
  const body = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => ok(b)); });
  let registered = 0;
  const srv = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const url = new URL(req.url!, base);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return void res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    if (url.pathname === "/.well-known/oauth-authorization-server") return void res.end(JSON.stringify({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }));
    if (url.pathname === "/register") { registered++; return void res.end(JSON.stringify({ client_id: "cid" })); }
    if (url.pathname === "/token") {
      const p = new URLSearchParams(await body(req));
      assert.equal(p.get("code_verifier")?.length, 43);
      return void res.end(JSON.stringify({ access_token: "tok", refresh_token: "r", expires_in: 3600 }));
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer tok") { res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }); return void res.end(); }
      const m = JSON.parse(await body(req)) as { id?: number; method: string };
      if (m.id === undefined) { res.writeHead(202); return void res.end(); }
      const result = m.method === "initialize" ? { serverInfo: { name: "online" } } : m.method === "tools/list" ? { tools: [{ name: "search" }] } : { content: [{ type: "text", text: "found" }] };
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess" });
      return void res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const { mcp } = await manager();
  await mcp.load();
  await mcp.upsert({ id: "online", name: "Online", transport: "http", url: `${base}/mcp`, enabled: false });
  await assert.rejects(mcp.connect("online"));
  assert.equal(mcp.statusOf("online").state, "needs-sign-in");
  const consent = new URL(await mcp.signInUrl("online", "http://127.0.0.1:7420/api/mcp/callback"));
  assert.equal(consent.pathname, "/authorize");
  assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
  assert.equal(registered, 1);
  await mcp.finishSignIn(consent.searchParams.get("state")!, "code1");
  await assert.rejects(mcp.finishSignIn(consent.searchParams.get("state")!, "code1"), /expired/);
  await mcp.connect("online");
  assert.equal(mcp.statusOf("online").state, "ready");
  assert.equal(mcpResultText(await mcp.call("online", "search", {})).text, "found");
  mcp.close();
  srv.close();
});

test("imports a Claude Desktop config", async () => {
  const { mcp } = await manager();
  await mcp.load();
  const added = await mcp.importConfig(JSON.stringify({ mcpServers: { "My Notes": { command: "npx", args: ["-y", "x"], env: { K: "v" } }, Remote: { url: "https://example.com/mcp" } } }));
  assert.deepEqual(added, ["my-notes", "remote"]);
  assert.equal(mcp.list()[1]!.transport, "http");
  mcp.close();
});

test("names and SSE parsing", () => {
  assert.equal(mcpToolName("notion", "notion-search.pages"), "mcp_notion_notion-search_pages");
  assert.ok(mcpToolName("a", "x".repeat(100)).length <= 64);
  assert.deepEqual(rpcFromSse(`data: {"jsonrpc":"2.0","method":"note"}\n\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":1}}\n\n`, 3)?.result, { ok: 1 });
});

test("says what to install when a program is missing", () => {
  assert.match(missingTool("npx", "'npx' is not recognized as an internal or external command,")!, /Node\.js/);
  assert.match(missingTool("uvx", "spawn uvx ENOENT")!, /uv/);
  assert.equal(missingTool("npx", "some other failure"), undefined);
});

test("Unity and Unreal use their official servers; old entries are updated", () => {
  assert.equal(unityRelay("win32", "x64", "C:\\Users\\Roee Tal"), "C:\\Users\\Roee Tal/.unity/relay/relay_win.exe".replace(/\//g, sep));
  assert.match(unityRelay("darwin", "arm64", "/Users/r"), /relay_mac_arm64\.app\/Contents\/MacOS\/relay_mac_arm64$/);
  const unreal = MCP_PRESETS.find((p) => p.id === "unreal")!;
  assert.equal(unreal.url, "http://127.0.0.1:8000/mcp");
  const old = migratePreset({ id: "unreal", name: "Unreal", preset: "unreal", transport: "stdio", command: "uvx", args: ["unreal-mcp"], enabled: true });
  assert.equal(old.transport, "http");
  assert.equal(old.url, "http://127.0.0.1:8000/mcp");
  const u = migratePreset({ id: "unity", name: "Unity", preset: "unity", transport: "stdio", command: "npx", args: ["-y", "mcp-unity"], enabled: true });
  assert.deepEqual(u.args, ["--mcp"]);
  assert.match(presetHelp(old, "fetch failed")!, /Unreal MCP plugin/);
});
