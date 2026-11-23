import { test } from "node:test";
import assert from "node:assert/strict";
import { hubStart, keepPcs, moduleImports, rememberedPresence, SHELL_CORE, SHELL_ENTRY, shellDown, shellKey, shellModules, useRemembered } from "./hub-offline.js";
import { RelayRouter } from "./relay-failover.js";
import { chooseRoute } from "./hub-route.js";
import { DEFAULT_OPT_IN, type HubPresence } from "./hub-protocol.js";

const O = "https://hub.example.com";

test("the shell cache list: the page, its files and modules; never an API answer or another site", () => {
  assert.equal(shellKey(`${O}/`, O), "/");
  assert.equal(shellKey(`${O}/index.html`, O), "/");
  assert.equal(shellKey(`${O}/?app=https%3A%2F%2Flocalhost#tasks`, O), "/", "the app's query opens the same kept page");
  assert.equal(shellKey(`${O}/connect.html`, O), "/connect.html");
  assert.equal(shellKey(`${O}/app.css?v=2`, O), "/app.css", "a static file's query is dropped");
  assert.equal(shellKey(`${O}/js/apps/hub/page/app.js`, O), "/js/apps/hub/page/app.js");
  assert.equal(shellKey(`${O}/icon-maskable-512.png`, O), "/icon-maskable-512.png");
  for (const p of ["/api/config", "/api/state", "/ws/device?ticket=x", "/sw.js", "/oauth/authorize", "/mcp", "/js/../api/state", "/js/x.json"]) assert.equal(shellKey(`${O}${p}`, O), undefined, p);
  assert.equal(shellKey("https://rest.ably.io/channels", O), undefined, "another origin");
  assert.equal(shellKey(`${O}/`, O, "POST"), undefined, "only GET");
  assert.equal(shellKey("not a url", O), undefined);
  for (const p of SHELL_CORE) assert.equal(shellKey(`${O}${p}`, O), p, `the core list is cacheable: ${p}`);
  assert.ok(SHELL_CORE.includes(SHELL_ENTRY));
});

test("module imports are read from the compiled code and followed once each", async () => {
  const code = 'import { a } from "./device.js";\nimport { b, c } from "../../../packages/shared/src/hub-crypto.js";\nexport * from "./kv.js";\nimport "./side.js";\nconst x = await import("./lazy.js");\nimport z from "react";';
  assert.deepEqual(moduleImports(code, "/js/apps/hub/page/app.js"), ["/js/apps/hub/page/device.js", "/js/packages/shared/src/hub-crypto.js", "/js/apps/hub/page/kv.js", "/js/apps/hub/page/side.js", "/js/apps/hub/page/lazy.js"]);
  assert.deepEqual(moduleImports('import a from "../../../../../x.js"', "/js/apps/hub/page/app.js"), [], "nothing outside /js/");

  const files: Record<string, string> = {
    "/js/apps/hub/page/app.js": 'import "./a.js"; import "./b.js";',
    "/js/apps/hub/page/a.js": 'import "./b.js"; import "../../../packages/shared/src/s.js";',
    "/js/apps/hub/page/b.js": 'import "./a.js";',
    "/js/packages/shared/src/s.js": "export const s = 1;",
  };
  const reads: string[] = [];
  const all = await shellModules(async (p) => (reads.push(p), files[p]));
  assert.deepEqual(all, ["/js/apps/hub/page/app.js", "/js/apps/hub/page/a.js", "/js/apps/hub/page/b.js", "/js/packages/shared/src/s.js"]);
  assert.equal(reads.length, 4, "each module read once (a cycle does not loop)");
  assert.deepEqual(await shellModules(async () => undefined), [SHELL_ENTRY], "offline at install: only the entry is listed");
});

test("the kept copy is served when the hub does not answer or Cloudflare answers 5xx", () => {
  for (const s of [undefined, 0, 500, 502, 503, 504, 521, 522, 530]) assert.equal(shellDown(s), true, String(s));
  for (const s of [200, 304, 401, 404]) assert.equal(shellDown(s), false, String(s));
});

/** A clock the test moves by hand. */
function clock(start = Date.UTC(2026, 10, 23, 9)) {
  let t = start;
  return { now: () => t, add: (ms: number) => void (t += ms) };
}

test("start order: the hub first; when it is down at the start, the backup relays at once", () => {
  const relays = [{ kind: "ably" as const, healthy: true }, { kind: "supabase" as const, healthy: true }];
  // Before any answer the hub keeps its place (the 20-second rule has not run out).
  const c = clock();
  const r = new RelayRouter(c.now);
  assert.equal(r.hubDown(), false);
  // Cloudflare unreachable at the start: no answer, or its own 5xx page (no `error` field).
  for (const [status, error] of [[undefined, undefined], [522, undefined], [503, undefined], [500, undefined]] as const) assert.equal(hubStart(status, error, false), "down", String(status));
  r.hubFailed();
  assert.deepEqual(r.order(relays, undefined), ["ably", "supabase", "hub"], "Ably, then Supabase, the hub last");
  // The hub back: open for 2 minutes, then first again.
  r.hubOpen();
  for (let i = 0; i < 4; i++) {
    c.add(30_000);
    r.hubHeard();
  }
  assert.equal(r.pick(relays, undefined), "hub");
});

test("the hub's own answers are not read as down", () => {
  assert.equal(hubStart(200, undefined, false), "ok");
  assert.equal(hubStart(401, "unauthorized", false), "revoked");
  assert.equal(hubStart(503, "hub-storage-limit", false), "storage");
  assert.equal(hubStart(503, "The hub is paused.", false), "paused", "the owner's kill switch: no failover");
  assert.equal(hubStart(503, "The hub is switched off.", false), "paused");
  assert.equal(hubStart(503, "hub-unavailable", false), "down", "the Worker could not reach its storage object");
  assert.equal(hubStart(429, "rate", false), "retry");
  assert.equal(hubStart(undefined, undefined, true), "retry", "a blip after the hub was open waits the normal 20 s");
});

const pc = (id: string, over: Partial<HubPresence> = {}): HubPresence => ({ id, name: id, kind: "pc", publicKey: `pk-${id}`, online: true, busy: false, agents: [], optIn: { ...DEFAULT_OPT_IN, appear: true, acceptTasks: true, acceptLocal: true }, ...over });

test("the last known device list: public data only, and a task can be routed from it", () => {
  const kept = keepPcs([pc("Home"), { ...pc("phone"), kind: "phone" }]);
  assert.deepEqual(Object.keys(kept), ["Home"], "only PCs");
  assert.deepEqual(Object.keys(kept.Home!).sort(), ["name", "optIn", "publicKey"], "no token, no private key, nothing else");

  const withRelay = rememberedPresence(kept, true);
  assert.equal(withRelay[0]!.online, true);
  assert.equal(withRelay[0]!.remembered, true);
  assert.equal(chooseRoute({ executor: "pc-local", ifOffline: "wait" }, withRelay, { cloudAvailable: false }).to, "Home", "through the relay");

  const noRelay = rememberedPresence(kept, false);
  const r = chooseRoute({ executor: "pc-local", ifOffline: "wait" }, noRelay, { cloudAvailable: false });
  assert.equal(r.route, "wait", "no relay: the task waits in this browser's outbox");

  const old = rememberedPresence({ A: { publicKey: "k", name: "Old" }, B: { publicKey: "", name: "broken" } }, true);
  assert.equal(old.length, 1, "an entry without a key is skipped");
  assert.equal(old[0]!.optIn.acceptTasks, true, "an entry kept before -08 still takes tasks (the PC decides)");
});

test("the remembered list only when the hub is gone, not on a short reconnect", () => {
  assert.equal(useRemembered(true, 2, false), false);
  assert.equal(useRemembered(false, 0, false), true, "opened while the hub is down");
  assert.equal(useRemembered(false, 2, false), false, "a short gap keeps the hub's list");
  assert.equal(useRemembered(false, 2, true), true, "failed over");
});
