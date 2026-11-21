import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHubKeys, openEnvelope, sealMessage, type HubFrame, type HubKeyPair, type SealedEnvelope } from "../../../packages/shared/src/hub.js";
import { connectorOwnerRoute, connectorRoute } from "./connector.js";
import { Hub, isHubError, type DeviceSockets } from "./hub.js";
import { MCP_TOOLS } from "./mcp.js";
import { allowedRedirect, CONNECTOR, pkceS256, redirectMatches } from "./oauth.js";
import { MemoryStore } from "./store.js";

const ORIGIN = "https://hub.example";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(20);

/** Sockets in memory: which devices are on, and every frame each got. */
class FakeSockets implements DeviceSockets {
  on = new Set<string>();
  got = new Map<string, HubFrame[]>();
  send(id: string, f: HubFrame): boolean {
    if (!this.on.has(id)) return false;
    this.got.set(id, [...(this.got.get(id) ?? []), f]);
    return true;
  }
  isOnline(id: string): boolean {
    return this.on.has(id);
  }
  close(id: string): void {
    this.on.delete(id);
  }
  closeAll(): void {
    this.on.clear();
  }
}

function setup() {
  let now = 5_000_000;
  const store = new MemoryStore();
  const sockets = new FakeSockets();
  const hub = new Hub({ store, sockets, config: { allowedEmail: "owner@example.com" }, verifyIdToken: async () => Promise.reject(new Error("unused")), fireClaude: async () => ({ ok: true as const }), now: () => now });
  return { hub, store, sockets, tick: (ms: number) => (now += ms) };
}

async function pair(hub: Hub, kind: "pc" | "phone", name: string): Promise<{ id: string; keys: HubKeyPair; hubKey: string }> {
  const keys = await generateHubKeys(true);
  const start = await hub.pairStart("1.2.3.4", { publicKey: keys.publicKey, kind, name });
  assert.ok(!isHubError(start));
  assert.ok(!isHubError(await hub.pairApprove(start.code, name)));
  const done = await hub.pairPoll("1.2.3.4", start.pollSecret);
  assert.ok(!isHubError(done) && done.status === "paired");
  return { id: done.deviceId, keys, hubKey: done.hubKey };
}

/** One request to the connector's open routes. */
async function call(hub: Hub, method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Headers; data: Record<string, unknown> }> {
  const r = await connectorRoute(new Request(`${ORIGIN}${path}`, { method, headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) }), hub, "iphash");
  assert.ok(r, `${path} is a connector route`);
  const text = await r.text();
  return { status: r.status, headers: r.headers, data: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** A signed-in owner route (the object checked the session already). */
async function owner(hub: Hub, path: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await connectorOwnerRoute(path, body, hub, ORIGIN);
  assert.ok(r);
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
}

const form = (fields: Record<string, string>) => ({ body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

/** Register, approve as the owner, exchange the code: a connection's tokens. */
async function connect(hub: Hub): Promise<{ clientId: string; access: string; refresh: string }> {
  const reg = await call(hub, "POST", "/oauth/register", { body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }), headers: { "content-type": "application/json" } });
  assert.equal(reg.status, 201);
  const clientId = String(reg.data.client_id);
  const params = { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: await pkceS256(VERIFIER), code_challenge_method: "S256", state: "st1", scope: "hub offline_access", resource: `${ORIGIN}/mcp` };
  const auth = await call(hub, "GET", `/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(auth.status, 302);
  assert.equal(auth.headers.get("location"), `/connect?${new URLSearchParams(params)}`);
  const check = await owner(hub, "/api/oauth/check", { params });
  assert.deepEqual(check.data, { clientName: "Claude", redirectHost: "claude.ai", loopback: false });
  const decide = await owner(hub, "/api/oauth/decide", { params, allow: true });
  const back = new URL(String(decide.data.redirect));
  assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
  assert.equal(back.searchParams.get("state"), "st1");
  assert.equal(back.searchParams.get("iss"), ORIGIN);
  const code = back.searchParams.get("code")!;
  const wrong = await call(hub, "POST", "/oauth/token", form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: "x".repeat(43) }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.error, "invalid_grant", "a wrong PKCE verifier fails (and uses the code up)");
  // A fresh code, the right verifier.
  const again = new URL(String((await owner(hub, "/api/oauth/decide", { params, allow: true })).data.redirect)).searchParams.get("code")!;
  const tok = await call(hub, "POST", "/oauth/token", form({ grant_type: "authorization_code", code: again, client_id: clientId, redirect_uri: CALLBACK, code_verifier: VERIFIER }));
  assert.equal(tok.status, 200, JSON.stringify(tok.data));
  assert.equal(tok.data.token_type, "Bearer");
  assert.equal(tok.data.expires_in, CONNECTOR.access / 1000);
  const reuse = await call(hub, "POST", "/oauth/token", form({ grant_type: "authorization_code", code: again, client_id: clientId, redirect_uri: CALLBACK, code_verifier: VERIFIER }));
  assert.equal(reuse.data.error, "invalid_grant", "a code works once");
  return { clientId, access: String(tok.data.access_token), refresh: String(tok.data.refresh_token) };
}

/** One JSON-RPC call to /mcp. */
async function rpc(hub: Hub, access: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await call(hub, "POST", "/mcp", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  return { status: r.status, data: r.data };
}

async function tool(hub: Hub, access: string, name: string, args: Record<string, unknown> = {}): Promise<{ data: Record<string, unknown>; isError: boolean; text: string }> {
  const r = await rpc(hub, access, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200);
  const result = r.data.result as { structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }> };
  return { data: result.structuredContent ?? {}, isError: result.isError === true, text: result.content[0]!.text };
}

test("discovery: protected resource and authorization server metadata; /mcp without a token asks to sign in", async () => {
  const { hub } = setup();
  const prm = await call(hub, "GET", "/.well-known/oauth-protected-resource/mcp");
  assert.equal(prm.data.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(prm.data.authorization_servers, [ORIGIN]);
  assert.deepEqual((await call(hub, "GET", "/.well-known/oauth-protected-resource")).data, prm.data);
  const as = await call(hub, "GET", "/.well-known/oauth-authorization-server");
  assert.equal(as.data.issuer, ORIGIN);
  assert.deepEqual(as.data.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.data.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.data.registration_endpoint, `${ORIGIN}/oauth/register`);
  const r = await call(hub, "POST", "/mcp", { body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata="https:\/\/hub\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  const forged = await call(hub, "POST", "/mcp", { body: "{}", headers: { authorization: "Bearer kc_forged" } });
  assert.equal(forged.status, 401);
  assert.match(forged.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.equal(await connectorRoute(new Request(`${ORIGIN}/api/state`), hub, "x"), undefined, "other paths are not the connector's");
});

test("registration: only Claude's callback or Claude Code's loopback; public clients only", async () => {
  const { hub } = setup();
  assert.ok(allowedRedirect(CALLBACK) && allowedRedirect("http://localhost:3118/callback") && allowedRedirect("http://127.0.0.1/callback"));
  for (const bad of ["https://evil.example/cb", "http://localhost:1/other", "https://claude.ai/api/mcp/auth_callback?x=1", "http://10.0.0.1/callback", "javascript:alert(1)"]) assert.equal(allowedRedirect(bad), false, bad);
  assert.ok(redirectMatches(["http://localhost/callback"], "http://localhost:4000/callback"), "loopback matches on any port");
  assert.equal(redirectMatches(["http://localhost/callback"], "http://127.0.0.1:4000/callback"), false);
  const reg = (body: unknown) => call(hub, "POST", "/oauth/register", { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  assert.equal((await reg({ redirect_uris: ["https://evil.example/cb"] })).data.error, "invalid_redirect_uri");
  assert.equal((await reg({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_basic" })).status, 400);
  assert.equal((await reg({ redirect_uris: [CALLBACK], grant_types: ["client_credentials"] })).status, 400);
  const ok = await reg({ client_name: "Claude\u0007 Code", redirect_uris: ["http://localhost/callback"] });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.client_name, "Claude Code", "control characters are dropped from the name");
  assert.equal(ok.data.token_endpoint_auth_method, "none");
});

test("registration: a full client table makes room from unused registrations older than ten minutes (scan 169)", () => {
  const { hub, store, tick } = setup();
  for (let i = 0; i < CONNECTOR.maxClients; i++) assert.ok(!("error" in hub.connector.register({ redirect_uris: [CALLBACK] })));
  const full = hub.connector.register({ redirect_uris: [CALLBACK] });
  assert.ok("error" in full && full.status === 429, "fresh registrations are kept while an approval may be under way");
  tick(CONNECTOR.clientFresh + 1);
  const ok = hub.connector.register({ redirect_uris: [CALLBACK] });
  assert.ok(!("error" in ok), "old unused ones made room");
  assert.equal(store.oauthClientCount(), 1);
});

test("authorization: unknown clients and foreign redirects are shown on the hub, never redirected; refusing sends access_denied", async () => {
  const { hub } = setup();
  const challenge = await pkceS256(VERIFIER);
  const unknown = await owner(hub, "/api/oauth/check", { params: { client_id: "cl_nope", redirect_uri: CALLBACK } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.redirect, undefined);
  const reg = await call(hub, "POST", "/oauth/register", { body: JSON.stringify({ redirect_uris: [CALLBACK] }), headers: { "content-type": "application/json" } });
  const client_id = String(reg.data.client_id);
  const foreign = await owner(hub, "/api/oauth/check", { params: { client_id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" } });
  assert.equal(foreign.data.redirect, undefined, "never sent to an address the client did not register");
  const noPkce = await owner(hub, "/api/oauth/check", { params: { client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge_method: "plain", code_challenge: challenge } });
  assert.match(String(noPkce.data.redirect), /error=invalid_request/);
  const otherResource = await owner(hub, "/api/oauth/check", { params: { client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" } });
  assert.match(String(otherResource.data.redirect), /error=invalid_target/);
  const badScope = await owner(hub, "/api/oauth/check", { params: { client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "hub admin" } });
  assert.match(String(badScope.data.redirect), /error=invalid_scope/);
  const deny = await owner(hub, "/api/oauth/decide", { params: { client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s" }, allow: false });
  const u = new URL(String(deny.data.redirect));
  assert.equal(u.searchParams.get("error"), "access_denied");
  assert.equal(u.searchParams.get("code"), null);
});

test("tokens: the code flow gives a working access token; refresh rotates; an old refresh token ends the connection; access expires in an hour", async () => {
  const { hub, store, tick } = setup();
  const c = await connect(hub);
  assert.ok(c.access.startsWith("kc_") && c.refresh.startsWith("kr_"));
  assert.ok(!JSON.stringify(store.grants()).includes(c.access) && !JSON.stringify(store.grants()).includes(c.refresh), "only hashes are kept");
  assert.equal((await rpc(hub, c.access, "ping")).status, 200);
  const otherClient = await call(hub, "POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: "cl_other" }));
  assert.equal(otherClient.data.error, "invalid_grant");
  const r1 = await call(hub, "POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId }));
  assert.equal(r1.status, 200);
  const access2 = String(r1.data.access_token);
  assert.notEqual(String(r1.data.refresh_token), c.refresh, "the refresh token rotates");
  assert.equal((await rpc(hub, c.access, "ping")).status, 401, "the old access token stops");
  assert.equal((await rpc(hub, access2, "ping")).status, 200);
  tick(CONNECTOR.access + 1);
  assert.equal((await rpc(hub, access2, "ping")).status, 401, "an access token lives an hour");
  // The first refresh token comes back (stolen?): the whole connection ends.
  const reused = await call(hub, "POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId }));
  assert.equal(reused.data.error, "invalid_grant");
  assert.equal(store.grants().length, 0);
  const r2 = await call(hub, "POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: String(r1.data.refresh_token), client_id: c.clientId }));
  assert.equal(r2.data.error, "invalid_grant", "the newest refresh token died with it");
  assert.ok(store.auditList(50).some((a) => a.action === "mcp-refresh-reused"));
  assert.equal((await call(hub, "POST", "/oauth/token", { body: "grant_type=password" })).status, 400, "form content type required");
  assert.equal((await call(hub, "POST", "/oauth/token", form({ grant_type: "client_credentials" }))).data.error, "unsupported_grant_type");
});

test("revocation: Connected apps lists the connection; Revoke and Disconnect-all stop its tokens at once", async () => {
  const { hub, tick } = setup();
  const c = await connect(hub);
  const list = (await hub.state()).connections;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, "Claude");
  assert.ok(!JSON.stringify(list).includes("kc_"), "no token in the list");
  assert.equal((await owner(hub, `/api/connections/${list[0]!.id}/revoke`, {})).status, 200);
  assert.equal((await rpc(hub, c.access, "ping")).status, 401);
  assert.equal((await call(hub, "POST", "/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId }))).data.error, "invalid_grant");
  assert.equal((await owner(hub, `/api/connections/${list[0]!.id}/revoke`, {})).status, 404);
  const c2 = await connect(hub);
  hub.killAll();
  assert.equal((await rpc(hub, c2.access, "ping")).status, 401);
  // At most a few connections: one more ends the oldest.
  for (let i = 0; i < CONNECTOR.maxGrants + 1; i++) {
    tick(60_000); // registration is rate limited per IP
    await connect(hub);
  }
  assert.equal((await hub.state()).connections.length, CONNECTOR.maxGrants);
});

test("mcp: initialize, tools/list, notifications, bad requests, a foreign Origin", async () => {
  const { hub } = setup();
  const { access } = await connect(hub);
  const init = await rpc(hub, access, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } });
  const result = init.data.result as { protocolVersion: string; capabilities: { tools: unknown } };
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.capabilities.tools);
  assert.equal(((await rpc(hub, access, "initialize", { protocolVersion: "1999-01-01" })).data.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
  const tools = ((await rpc(hub, access, "tools/list")).data.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.deepEqual(tools, ["list_devices", "get_agent_status", "waiting_for_approval", "list_tasks", "send_task"]);
  assert.ok(MCP_TOOLS.filter((t) => t.name !== "send_task").every((t) => t.annotations.readOnlyHint));
  const note = await call(hub, "POST", "/mcp", { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers: { authorization: `Bearer ${access}` } });
  assert.equal(note.status, 202);
  const batch = await call(hub, "POST", "/mcp", { body: "[]", headers: { authorization: `Bearer ${access}` } });
  assert.equal(batch.status, 400);
  assert.equal(((await rpc(hub, access, "resources/list")).data.error as { code: number }).code, -32601);
  assert.equal(((await rpc(hub, access, "tools/call", { name: "rm_rf" })).data.error as { code: number }).code, -32602);
  const foreign = await call(hub, "POST", "/mcp", { body: "{}", headers: { authorization: `Bearer ${access}`, origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const get = await call(hub, "GET", "/mcp", { headers: { authorization: `Bearer ${access}` } });
  assert.equal(get.status, 405);
});

test("tools: devices, agents, waiting count and tasks as metadata with a hub link; every call is in the activity log", async () => {
  const { hub, store, sockets } = setup();
  const { access } = await connect(hub);
  const pc = await pair(hub, "pc", "Desk");
  const phone = await pair(hub, "phone", "Pixel");
  sockets.on.add(pc.id);
  await hub.onOpen(pc.id);
  await hub.onFrame(pc.id, JSON.stringify({ t: "hello", version: "0.6.413", busy: true, optIn: { appear: true, acceptTasks: true, acceptAntigravity: true }, agents: [{ kind: "local-model", state: "busy", label: "Qwen 3 8B" }] }));
  const devs = await tool(hub, access, "list_devices");
  const desk = (devs.data.devices as Array<Record<string, unknown>>).find((d) => d.name === "Desk")!;
  assert.deepEqual(desk.accepts, { tasks: true, localModel: false, antigravity: true });
  assert.equal(desk.online, true);
  assert.ok(!devs.text.includes(pc.keys.publicKey), "no keys in the answer");
  assert.equal(devs.data.hubUrl, `${ORIGIN}/#devices`);
  const agents = await tool(hub, access, "get_agent_status", { device: "desk" });
  assert.deepEqual((agents.data.devices as Array<{ agents: unknown }>)[0]!.agents, [{ kind: "local-model", state: "busy", label: "Qwen 3 8B" }]);
  assert.equal((await tool(hub, access, "get_agent_status", { device: "nope" })).isError, true);
  // The PC's approvals snapshot reaches the phone; the hub keeps only the count it already sees in clear.
  const env = await sealMessage({ from: pc.id, to: phone.id, kind: "approvals" }, { type: "approvals", at: 1, items: [] }, pc.keys.privateKey, phone.keys.publicKey);
  env.waiting = 3;
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env }));
  const waiting = await tool(hub, access, "waiting_for_approval");
  assert.equal(waiting.data.total, 3);
  assert.match(String(waiting.data.note), /end-to-end encrypted/);
  const tasks = await tool(hub, access, "list_tasks");
  assert.deepEqual(tasks.data.queuedForPcs, [{ deviceId: pc.id, name: "Desk", tasks: 0, other: 0 }]);
  assert.equal(tasks.data.hubUrl, `${ORIGIN}/#tasks`);
  const log = store.auditList(100).map((a) => a.action);
  for (const t of ["list_devices", "get_agent_status", "waiting_for_approval", "list_tasks"]) assert.ok(log.includes(`mcp-${t}`), t);
  hub.setPaused(true);
  assert.equal((await tool(hub, access, "list_devices")).isError, true, "a paused hub answers nothing");
});

test("send_task: sealed by the hub to the PC that opted in, opened by the PC with the hub's key, never stored in plain form", async () => {
  const { hub, store, sockets } = setup();
  const { access } = await connect(hub);
  const pc = await pair(hub, "pc", "Desk");
  assert.match((await tool(hub, access, "send_task", { title: "Fix the build" })).text, /No PC takes/);
  await hub.onFrame(pc.id, JSON.stringify({ t: "hello", busy: false, optIn: { appear: true, acceptTasks: true, acceptAntigravity: true }, agents: [] }));
  assert.match((await tool(hub, access, "send_task", { title: "Run it", executor: "pc-local" })).text, /No PC takes/, "local tasks need their own opt-in");
  assert.equal((await tool(hub, access, "send_task", { title: "x", executor: "shell" })).isError, true);
  assert.equal((await tool(hub, access, "send_task", { title: "x", spec: "y".repeat(8001) })).isError, true);
  const sent = await tool(hub, access, "send_task", { title: "Fix the build", spec: "pnpm -s typecheck fails in apps/hub", device: "Desk" });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(sent.data.delivered, false, "the PC is off: queued");
  assert.equal(sent.data.waitsForRun, true);
  assert.ok(!JSON.stringify(store.auditList(100)).includes("Fix the build"), "no task text in the log");
  assert.ok(!(store.getSetting("connectorTasks") ?? "").includes("Fix the build"), "no task text kept");
  const listed = await tool(hub, access, "list_tasks");
  assert.equal((listed.data.sentByConnector as Array<{ takenByPc: boolean }>)[0]!.takenByPc, false);
  // The PC comes on, gets the envelope, opens it with the hub's key, acks it.
  sockets.on.add(pc.id);
  await hub.onOpen(pc.id);
  const deliver = (sockets.got.get(pc.id) ?? []).find((f): f is Extract<HubFrame, { t: "deliver" }> => f.t === "deliver")!;
  const envOut: SealedEnvelope = deliver.env;
  assert.equal(envOut.from, "hub");
  assert.ok(!envOut.ct.includes("Fix"), "sealed");
  const body = await openEnvelope(envOut, pc.keys.privateKey, pc.hubKey);
  assert.ok(body.type === "task" && body.title === "Fix the build" && body.executor === "pc-antigravity" && body.spec.startsWith("pnpm"));
  await hub.onFrame(pc.id, JSON.stringify({ t: "ack", id: envOut.id }));
  assert.equal((((await tool(hub, access, "list_tasks")).data.sentByConnector as Array<{ takenByPc: boolean }>)[0]!).takenByPc, true);
  // The PC's progress back "to the hub" is taken and dropped, unread and unrefused.
  const progress = await sealMessage({ from: pc.id, to: "hub", kind: "progress" }, { type: "progress", taskId: body.taskId, line: "On the board" }, pc.keys.privateKey, pc.hubKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: progress }));
  assert.ok(!(sockets.got.get(pc.id) ?? []).some((f) => f.t === "refused"));
  assert.equal(store.queueCount(), 0);
  assert.ok(store.auditList(100).some((a) => a.action === "mcp-send_task"));
});
