/**
 * The design render's support for the Kesher Cloud hub page (apps/hub/public, served by Cloudflare in production).
 *
 * A hub board (`"target": "hub"` in a scenario file) is shot from the hub's real static files, served here by a tiny
 * local server, with the hub's `/api/*` answers mocked (Playwright routes) and its socket answered by a scripted
 * "welcome". What the hub page keeps in the browser (its device key, its tasks) is written into IndexedDB first, and
 * the agent activity the PCs would send is sealed in the page itself with the page's own crypto, so the page opens
 * it exactly as it would a real one. Nothing here talks to a real hub, and no real data can show up in a board.
 *
 * The pure parts (file lookup, the seed's defaults, the owner state) are tested in design-hub.test.ts; the script
 * that runs inside the page ({@link HUB_SEED_JS}) is plain JavaScript because Playwright sends it as text.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { cleanProviderQuotas, type ProviderQuota } from "@kesher/shared";
import type { HubSeed } from "./design-scenarios.js";

/** Where the hub's static files are in the repo. */
export const HUB_PUBLIC = "apps/hub/public";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/**
 * The file a request path means, only ever inside the hub's folder (no `..`, no encoded slashes, no other drive).
 * `/` is the page and `/connect` the Claude connector's approval page, as the Worker serves them.
 * @param root The hub's public folder.
 * @param urlPath The request's path (no query).
 * @returns The absolute file, or undefined when it is outside the folder, missing or not a file.
 */
export function hubStaticFile(root: string, urlPath: string): string | undefined {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (p.includes("\0") || p.includes("\\")) return undefined;
  if (p === "/") p = "/index.html";
  else if (p === "/connect") p = "/connect.html";
  else if (p === "/__blank") return undefined;
  const base = resolve(root);
  const file = resolve(base, "." + p);
  if (file !== base && !file.startsWith(base + sep)) return undefined;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/**
 * Serves the hub's public folder on a free local port (127.0.0.1 only), plus `/__blank`: an empty page on the same
 * origin, where the seed script runs before the hub page loads.
 * @param root The hub's public folder.
 * @returns The origin, and a function that stops the server.
 */
export async function startHubServer(root: string): Promise<{ base: string; close: () => void }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/__blank") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>seed</title>");
      return;
    }
    const file = hubStaticFile(root, path);
    if (!file) return void res.writeHead(404).end("not found");
    void readFile(file).then(
      (data) => res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(data),
      () => res.writeHead(500).end("error"),
    );
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const a = server.address();
  if (!a || typeof a !== "object") throw new Error("no port for the hub server");
  return { base: `http://127.0.0.1:${a.port}`, close: () => void server.close() };
}

/** The hub's Web Push key as the page checks it (url-safe base64, 80 to 100 characters): a fixed fake, never a real key. */
export const FAKE_VAPID = "B" + "x".repeat(86);

/** The first part of a PC's opt-in the hub page needs to list it as a PC that takes tasks and reports activity. */
export const PC_OPT_IN = { appear: true, acceptTasks: true, acceptLocal: true, acceptAntigravity: true, reportLinks: false, reportActivity: true, reportFileNames: false };

/** What the hub page reads from `/api/state` for a signed-in owner (the seed's `owner` fields go over these). */
export function hubOwnerState(seed: HubSeed, presence: Array<{ id: string; name: string; kind: string; online: boolean }>): Record<string, unknown> {
  return {
    devices: presence.map((d) => ({ ...d, publicKey: "", busy: false, optIn: PC_OPT_IN, agents: [], fingerprint: "4f2a 91c0 7be3 d518" })),
    paused: false,
    cloudOff: false,
    cloudReady: true,
    queued: 0,
    agents: { kept: 0, writtenToday: 0, freeWrites: 1000 },
    connections: [],
    audit: [],
    ...(seed.owner ?? {}),
  };
}

/**
 * The tasks the hub page keeps in the browser (`PageTask`), each filled in from a few fields of the seed.
 * @param seed The board's seed.
 * @param now The render's clock (ms).
 * @returns Complete tasks, newest first, with ids `t1`, `t2`… when the seed gives none.
 */
export function hubTasks(seed: HubSeed, now: number): Array<Record<string, unknown>> {
  return seed.tasks.map((t, i) => {
    const createdAt = typeof t.createdAt === "number" ? t.createdAt : now - (i + 1) * 3_600_000;
    const status = typeof t.status === "string" ? t.status : "done";
    return {
      taskId: `t${i + 1}`,
      title: "Task",
      spec: "",
      executor: "auto",
      ifOffline: "cloud",
      route: "pc",
      to: null,
      toName: "",
      ...t,
      createdAt,
      status,
      history: Array.isArray(t.history) ? t.history : [{ t: createdAt, he: "נוצרה", en: "Created" }],
    };
  });
}

/**
 * A run's complete state (what a PC sends in every batch) from the few fields a scenario gives.
 * @param s The scenario's fields (title, state, source, name, note, label…).
 * @param runId The run's id.
 * @param now The render's clock (ms).
 * @returns A state the hub page accepts.
 */
export function hubAgentState(s: Record<string, unknown>, runId: string, now: number): Record<string, unknown> {
  const going = !["done", "failed", "cancelled"].includes(String(s.state ?? "running"));
  return {
    runId,
    title: "Agent",
    source: "inbox",
    state: "running",
    step: 0,
    startedAt: now - 600_000,
    lastEventAt: now - 20_000,
    files: 0,
    fileNames: [],
    ...(going ? {} : { endedAt: now - 120_000 }),
    ...s,
  };
}

/** This render's browser as a device of the hub (its id; the name comes from the seed). */
export const HUB_DEVICE_ID = "design-phone";

/** What {@link HUB_SEED_JS} takes: everything complete, so the script has nothing to decide. */
export interface HubPlan {
  deviceId: string;
  device?: { name: string };
  nowIso: string;
  optIn: typeof PC_OPT_IN;
  pcs: Array<{ id: string; name: string; kind: string; online: boolean }>;
  tasks: Array<Record<string, unknown>>;
  agents: Array<{ pc: string; runId: string; state: Record<string, unknown>; events: Array<Record<string, unknown>> }>;
  /** The PCs' shared task boards, whole (sealed to this device and delivered after the welcome). */
  boards: Array<{ pc: string; rev: number; items: Array<Record<string, unknown>>; doneTotal: number; at: number }>;
  /** The PCs' quotas snapshots, cleaned as the page cleans them (sealed and delivered after the welcome, like the boards). */
  quotas: Array<{ pc: string; items: ProviderQuota[]; at: number }>;
}

/**
 * Fills a hub board's seed in: complete tasks, complete run states, numbered events.
 * @param seed The board's seed.
 * @param now The render's clock (ms).
 * @returns What the seed script writes and seals.
 * @throws When a run names a PC the seed does not list.
 */
export function hubPlan(seed: HubSeed, now: number): HubPlan {
  const agents = seed.agents.map((a) => {
    if (!seed.pcs.some((p) => p.id === a.pc)) throw new Error(`hub seed: the run ${a.runId} is on PC "${a.pc}", which is not in "pcs"`);
    const state = hubAgentState(a.state, a.runId, now);
    return { pc: a.pc, runId: a.runId, state, events: a.events.map((e, i) => ({ seq: i + 1, t: now - (a.events.length - i) * 30_000, ...e })) };
  });
  const boards = seed.boards.map((b) => {
    if (!seed.pcs.some((p) => p.id === b.pc)) throw new Error(`hub seed: the board is on PC "${b.pc}", which is not in "pcs"`);
    const items = b.items.map((i, n) => ({ id: `t${n + 1}`, status: "open", size: "big", priority: 5, at: now - (n + 1) * 600_000, ...i }));
    return { pc: b.pc, rev: 40, items, doneTotal: b.doneTotal ?? items.filter((i) => i.status === "done").length, at: now };
  });
  const quotas = seed.quotas.map((q) => {
    if (!seed.pcs.some((p) => p.id === q.pc)) throw new Error(`hub seed: the quotas are on PC "${q.pc}", which is not in "pcs"`);
    return { pc: q.pc, items: cleanProviderQuotas(q.items), at: now };
  });
  return { deviceId: HUB_DEVICE_ID, ...(seed.device ? { device: seed.device } : {}), nowIso: new Date(now).toISOString(), optIn: PC_OPT_IN, pcs: seed.pcs, tasks: hubTasks(seed, now), agents, boards, quotas };
}

/**
 * Runs inside the page before the hub page loads (Playwright evaluates it as text): makes the browser's own device key
 * and a key for each PC, writes the device and its tasks into the page's IndexedDB, and seals each run's activity from
 * its PC to this device.
 * It returns the presence list (with the PCs' public keys) and the sealed activity, which the renderer serves.
 */
export const HUB_SEED_JS = `async (plan) => {
  const c = await import("/js/packages/shared/src/hub-crypto.js");
  const me = await c.generateHubKeys(false);
  const hubKey = "design-hub-key";
  const keys = {};
  const presence = [];
  for (const pc of plan.pcs) {
    const k = await c.generateHubKeys(false);
    keys[pc.id] = k;
    presence.push({ id: pc.id, name: pc.name, kind: pc.kind, publicKey: k.publicKey, online: pc.online, lastSeen: plan.nowIso, busy: false, optIn: plan.optIn, agents: [] });
  }
  const envs = [];
  let seq = 1;
  for (const a of plan.agents) {
    const env = await c.sealMessage({ from: a.pc, to: plan.deviceId, kind: "agent_event" }, { type: "agent_event", runId: a.runId, state: a.state, events: a.events }, keys[a.pc].privateKey, me.publicKey);
    env.run = a.runId; env.n = a.events.length; env.seq = seq++; env.at = a.state.lastEventAt;
    envs.push(env);
  }
  const boardEnvs = [];
  for (const b of plan.boards) boardEnvs.push(await c.sealMessage({ from: b.pc, to: plan.deviceId, kind: "board" }, { type: "board", rev: b.rev, items: b.items, doneTotal: b.doneTotal, at: b.at }, keys[b.pc].privateKey, me.publicKey));
  for (const q of plan.quotas) boardEnvs.push(await c.sealMessage({ from: q.pc, to: plan.deviceId, kind: "quotas" }, { type: "quotas", items: q.items, at: q.at }, keys[q.pc].privateKey, me.publicKey));
  const db = await new Promise((ok, fail) => {
    const r = indexedDB.open("kesher-hub", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  const put = (k, v) => new Promise((ok, fail) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(v, k);
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
  });
  if (plan.device) await put("device", { deviceId: plan.deviceId, token: "design-token", hubKey, privateKey: me.privateKey, publicKey: me.publicKey, name: plan.device.name });
  await put("tasks", plan.tasks);
  db.close();
  return { presence, envs, boardEnvs, hubKey };
}`;

/**
 * Runs in every hub page before its own scripts: makes this browser look subscribed to Web Push (the real push
 * service cannot be reached from a render), (and the permission granted), so Settings › Notifications shows its switch on.
 */
export const HUB_PUSH_JS = `(() => {
  const sub = { toJSON: () => ({ endpoint: "https://push.invalid/design", keys: {} }), unsubscribe: async () => true };
  const reg = { getNotifications: async () => [], pushManager: { getSubscription: async () => (window.__pushOn ? sub : null), subscribe: async () => sub } };
  Object.defineProperty(Notification, "permission", { get: () => "granted" });
  Object.defineProperty(navigator.serviceWorker, "register", { value: async () => reg });
  Object.defineProperty(navigator.serviceWorker, "ready", { get: () => Promise.resolve(reg) });
})()`;

/** Where the hub's public folder is, in a repo. */
export const hubPublicDir = (repo: string): string => join(repo, HUB_PUBLIC);

/** The hub's public address, shown in boards instead of the render's own local one. */
export const HUB_PUBLIC_ORIGIN = "https://hub.roeetal.com";

/** Runs after a hub page is drawn: the render's local address in the page's texts becomes the hub's public one. */
export const HUB_ORIGIN_JS = `(() => {
  const local = location.origin, pub = ${JSON.stringify(HUB_PUBLIC_ORIGIN)};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes(local)) n.nodeValue = n.nodeValue.split(local).join(pub);
  for (const el of document.querySelectorAll("[title]")) if (el.title.includes(local)) el.title = el.title.split(local).join(pub);
})()`;
