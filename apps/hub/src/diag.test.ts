import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { CfWebSocket, DurableObjectState, HubEnvBindings, SqlStorage } from "./cf.js";
import { DIAG_MAX, DiagRing, diagPath, scrub, stackHead, type DiagSnapshot } from "./diag.js";
import { HubObject } from "./hub-do.js";
import { sha256Hex } from "../../../packages/shared/src/hub-crypto.js";
import { DEFAULT_OPT_IN } from "../../../packages/shared/src/hub.js";
import { SqlStore } from "./sql-store.js";

test("scrub hides tokens, tickets, e-mails and IPs", () => {
  const out = scrub("bad kh_abcDEF123-xyz ticket kt1.dabc.123.nonce.sig mail roee@example.com from 203.0.113.9 and 2001:db8::1 eyJhbGciOi.eyJzdWIi.sig");
  for (const secret of ["kh_abc", "kt1.", "roee@", "example.com", "203.0.113", "2001:db8", "eyJ"]) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  assert.equal(scrub("x".repeat(500)).length <= 200, true);
});

test("diagPath drops the query and replaces ids", () => {
  assert.equal(diagPath("/api/devices/d12345678901234567890/revoke"), "/api/devices/:id/revoke");
  assert.equal(diagPath("/api/ticket"), "/api/ticket");
});

test("stackHead keeps 5 scrubbed lines", () => {
  const e = new Error("boom");
  assert.ok(stackHead(e).length <= 5);
  assert.deepEqual(stackHead("not an error"), []);
});

test("the ring keeps the last 200 entries, counts repeats and starts empty", () => {
  let t = 1_000;
  const ring = new DiagRing(() => (t += 1000));
  assert.deepEqual(ring.snapshot().entries, []);
  for (let i = 0; i < DIAG_MAX + 25; i++) ring.add({ kind: "http", where: "http", method: "GET", path: "/p", status: 500, code: `c${i}` });
  const snap = ring.snapshot();
  assert.equal(snap.entries.length, DIAG_MAX);
  assert.equal(snap.entries[0]!.code, "c25");
  assert.equal(snap.total, DIAG_MAX + 25);
  for (let i = 0; i < 4; i++) ring.add({ kind: "http", where: "http", method: "GET", path: "/p", status: 401, code: "same" });
  const last = ring.snapshot().entries.at(-1)!;
  assert.equal(last.count, 4);
  assert.equal(ring.snapshot().entries.length, DIAG_MAX);
});

test("an error entry has its message and at most 5 stack lines, scrubbed", () => {
  const ring = new DiagRing();
  ring.error("socket-message", new Error("failed for kh_secretsecretsecret"));
  const e = ring.snapshot().entries[0]!;
  assert.equal(e.kind, "error");
  assert.equal(e.where, "socket-message");
  assert.ok(e.message!.includes("<token>") && !e.message!.includes("kh_secret"));
  assert.ok(e.stack!.length <= 5);
});

// ---- the Durable Object's route ----

/** The Durable Object's SQL on node:sqlite; `refuse` makes every write throw like the daily quota does. */
function fakeSql(state: { refuse: boolean }): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (state.refuse && /^\s*(INSERT|UPDATE|DELETE)/i.test(query)) throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      if (bindings.length === 0 && /^\s*CREATE/i.test(query)) {
        db.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows, rowsWritten: 0 };
    },
  };
}

async function setup() {
  const state = { refuse: false, socketsThrow: false };
  const sql = fakeSql(state);
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {};
  const ctx = {
    storage: { sql },
    acceptWebSocket() {},
    getWebSockets: () => {
      if (state.socketsThrow) throw new Error("sockets exploded");
      return [] as CfWebSocket[];
    },
    setWebSocketAutoResponse() {},
  } as unknown as DurableObjectState;
  const token = "kh_testtokentesttokentesttokentest123";
  new SqlStore(sql).putDevice({ id: "dpc1", name: "PC", kind: "pc", publicKey: "k", tokenHash: await sha256Hex(token), tokenIssuedAt: Date.now(), createdAt: Date.now(), busy: false, optIn: { ...DEFAULT_OPT_IN }, agents: [] });
  const obj = new HubObject(ctx, {} as HubEnvBindings);
  const get = (path: string, auth = true) => obj.fetch(new Request(`https://hub.test${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} }));
  return { state, obj, get, token };
}

test("GET /api/diag needs a device token, lists non-2xx answers without query or token, and writes nothing", async () => {
  const { get, state } = await setup();
  assert.equal((await get("/api/diag", false)).status, 401);
  assert.equal((await get("/api/ticket?ticket=kt1.secret", true)).status, 401);
  state.refuse = true; // from here every write throws: the route must not need one
  const res = await get("/api/diag");
  assert.equal(res.status, 200);
  const snap = (await res.json()) as DiagSnapshot;
  assert.equal(snap.entries.length, 2);
  assert.deepEqual(snap.entries.map((e) => [e.method, e.path, e.status]), [["GET", "/api/diag", 401], ["GET", "/api/ticket", 401]]);
  assert.equal(snap.entries[0]!.code, "Unknown device.");
  assert.ok(!JSON.stringify(snap).includes("secret"));
  assert.ok(!JSON.stringify(snap).includes("kh_"));
});

test("GET /api/diag is rate limited", async () => {
  const { get } = await setup();
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await get("/api/diag")).status);
  assert.deepEqual(codes.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.equal(codes[7], 429);
});

test("with writes refused a ticket is still issued, and a rotate is a recorded 503", async () => {
  const { obj, get, state, token } = await setup();
  state.refuse = true;
  const post = (path: string) => obj.fetch(new Request(`https://hub.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
  assert.equal((await post("/api/ticket")).status, 200);
  const rot = await post("/api/rotate");
  assert.equal(rot.status, 503);
  assert.equal(((await rot.json()) as { error: string }).error, "hub-storage-limit");
  const snap = (await (await get("/api/diag")).json()) as DiagSnapshot;
  const e = snap.entries.find((x) => x.path === "/api/rotate")!;
  assert.equal(e.kind, "storage");
  assert.equal(e.status, 503);
  assert.equal(e.code, "hub-storage-limit");
  assert.ok(e.ms !== undefined);
});

test("a socket handler's failure is recorded before it propagates", async () => {
  const { obj, get, state } = await setup();
  const ws = { deserializeAttachment: () => ({ deviceId: "dpc1" }), serializeAttachment() {}, send() {}, close() {} } as unknown as CfWebSocket;
  state.socketsThrow = true;
  await assert.rejects(obj.webSocketMessage(ws, "not json"), /sockets exploded/);
  state.socketsThrow = false;
  const snap = (await (await get("/api/diag")).json()) as DiagSnapshot;
  const e = snap.entries.find((x) => x.where === "socket-message");
  assert.equal(e?.kind, "error");
  assert.match(e!.message!, /sockets exploded/);
  assert.ok(e!.stack!.length > 0 && e!.stack!.length <= 5);
});
