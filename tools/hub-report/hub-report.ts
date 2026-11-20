/**
 * hub-report: shows the Claude chat's helper agents live in the Kesher Cloud hub's Agents tab ("Claude chat").
 *
 *   node --import tsx tools/hub-report/hub-report.ts pair <hubUrl>
 *   node --import tsx tools/hub-report/hub-report.ts start <runId> --kind research|build|lookup --model <name> --title "<title>"
 *   node --import tsx tools/hub-report/hub-report.ts step <runId> "<label>"
 *   node --import tsx tools/hub-report/hub-report.ts done <runId> ["<summary>"]
 *   node --import tsx tools/hub-report/hub-report.ts failed <runId> "<reason>"
 *
 * `pair` pairs this container as a device of kind `claude-chat` (the code is approved on the hub's Devices screen,
 * after comparing the 6-digit fingerprint). Each other call is one short connection: a ticket over HTTPS, then a
 * WebSocket that sends one sealed `agent_event` batch to every paired phone and closes. The key and the token live
 * only in `~/.kesher-hub/claude-chat.json` (mode 600). See README.md.
 */
import {
  DEFAULT_OPT_IN,
  HUB_LIMITS,
  exportPrivateJwk,
  generateHubKeys,
  importPrivateJwk,
  keyFingerprint,
  sealMessage,
  type HubFrame,
  type HubPresence,
  type SealedEnvelope,
} from "../../packages/shared/src/hub.js";
import { applyCommand, configPath, loadConfig, parseArgs, pruneRuns, saveConfig, type ChatConfig, type ChatRun } from "./report.js";

const VERSION = "hub-report 1";
const PAIR_WAIT_MS = 100_000;
const SOCKET_MS = 15_000;

/** Stops with a message (exit code 1, or 2 for "not paired"). */
class Stop extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** The hub address as stored: http(s) only, no query, no trailing slash. */
function hubUrl(raw: string | undefined): string {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new Error();
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new Stop("Give the hub's https address, e.g. pair https://hub.example.workers.dev");
  }
}

async function post(url: string, path: string, body: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `pair <hubUrl>`: starts pairing (or resumes one in progress) and waits up to 100 s for the approval. */
async function pair(raw: string | undefined): Promise<void> {
  const c = await loadConfig();
  const url = hubUrl(raw ?? c.pending?.url ?? c.url);
  if (c.token && c.url === url) return void console.log(`Already paired with ${url}. To pair again, delete ${configPath()} first.`);
  if (!c.privateJwk) c.privateJwk = await exportPrivateJwk((await generateHubKeys(true)).privateKey);
  const key = await importPrivateJwk(c.privateJwk);
  if (!c.pending || c.pending.url !== url || c.pending.expiresAt < Date.now()) {
    const r = await post(url, "/api/pair/start", { publicKey: key.publicKey, kind: "claude-chat", name: "Claude chat" });
    if (r.status !== 200 || typeof r.data.code !== "string" || typeof r.data.pollSecret !== "string") throw new Stop(`The hub did not start pairing (${r.status}${typeof r.data.error === "string" ? `: ${r.data.error}` : ""}).`);
    c.pending = { url, pollSecret: r.data.pollSecret, code: r.data.code, fingerprint: await keyFingerprint(key.publicKey), expiresAt: Date.now() + Number(r.data.expiresIn ?? 300) * 1000 };
    await saveConfig(c);
  }
  const p = c.pending;
  console.log(`Approve on the hub's Devices screen: code ${p.code}, fingerprint ${p.fingerprint} (expires ${new Date(p.expiresAt).toISOString().slice(11, 16)} UTC).`);
  const until = Math.min(p.expiresAt, Date.now() + PAIR_WAIT_MS);
  while (Date.now() < until) {
    const r = await post(url, "/api/pair/poll", { pollSecret: p.pollSecret }).catch(() => undefined);
    if (r?.data.status === "paired" && typeof r.data.token === "string" && typeof r.data.deviceId === "string") {
      Object.assign(c, { url, token: r.data.token, deviceId: r.data.deviceId, pending: undefined });
      await saveConfig(c);
      return void console.log("Paired. This chat's agents now show in the hub's Agents tab (Claude chat).");
    }
    if (r && r.status >= 400 && r.status !== 429) {
      c.pending = undefined;
      await saveConfig(c);
      throw new Stop(`Pairing ended: ${typeof r.data.error === "string" ? r.data.error : r.status}.`);
    }
    await sleep(3000);
  }
  throw new Stop("Not approved yet. Run the same pair command again to keep waiting (the code stays the same until it expires).");
}

/** A one-use ticket for the socket, rotating the token when the hub asks. */
async function ticket(c: ChatConfig): Promise<string> {
  const url = c.url!;
  let r = await post(url, "/api/ticket", {}, c.token);
  if (r.status === 401 || r.status === 403) throw new Stop("The hub no longer knows this chat (it was removed on the Devices screen). Pair again.", 2);
  if (r.status === 503) throw new Stop("The hub is paused (its kill switch). Nothing was sent.");
  if (r.status !== 200 || typeof r.data.ticket !== "string") throw new Stop(`The hub answered ${r.status}${typeof r.data.error === "string" ? `: ${r.data.error.slice(0, 120)}` : ""}.`);
  if (r.data.rotateDue === true) {
    const rot = await post(url, "/api/rotate", {}, c.token);
    if (rot.status === 200 && typeof rot.data.token === "string") {
      c.token = rot.data.token;
      await saveConfig(c);
      r = await post(url, "/api/ticket", {}, c.token);
      if (r.status !== 200 || typeof r.data.ticket !== "string") throw new Stop(`The hub answered ${r.status} after the token rotated.`);
    }
  }
  return String(r.data.ticket);
}

/**
 * Opens the device socket, waits for the presence, seals the run's batch to every phone, sends it and closes.
 *
 * @returns How many viewers it went to.
 */
async function deliver(c: ChatConfig, run: ChatRun): Promise<number> {
  const key = await importPrivateJwk(c.privateJwk!);
  const t = await ticket(c);
  const ws = new WebSocket(`${c.url!.replace(/^http/, "ws")}/ws/device?ticket=${encodeURIComponent(t)}`);
  return await new Promise<number>((resolve, reject) => {
    let sent = -1;
    const end = (err?: Error) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(Math.max(sent, 0));
    };
    const timer = setTimeout(() => end(sent >= 0 ? undefined : new Stop("The hub's live link did not answer in time.")), SOCKET_MS);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", version: VERSION, platform: "claude-chat", busy: false, optIn: DEFAULT_OPT_IN, agents: [] })));
    ws.addEventListener("error", () => end(new Stop("The hub's live link did not open.")));
    ws.addEventListener("message", (m) => {
      let f: HubFrame;
      try {
        f = JSON.parse(String(m.data)) as HubFrame;
      } catch {
        return;
      }
      if (f.t === "revoked") return end(new Stop("The hub removed this chat. Pair again.", 2));
      if (f.t === "refused") return end(new Stop(`The hub refused the report (${f.code}).`));
      if (f.t !== "welcome" || sent >= 0) return;
      void sendBatch(f.presence)
        .then((n) => {
          sent = n;
          // A refusal comes back at once; a short wait catches it before closing.
          setTimeout(() => end(), 400);
        })
        .catch((e: unknown) => end(e instanceof Error ? e : new Error(String(e))));
    });
    const sendBatch = async (presence: HubPresence[]): Promise<number> => {
      const viewers = presence.filter((d) => d.kind === "phone" && d.id !== c.deviceId);
      const envs: SealedEnvelope[] = [];
      for (const v of viewers) {
        const env = { ...(await sealMessage({ from: c.deviceId!, to: v.id, kind: "agent_event", ttl: 3600 }, { type: "agent_event", runId: run.state.runId, state: run.state, events: run.unsent }, key.privateKey, v.publicKey)), run: run.state.runId, n: run.unsent.length };
        if (JSON.stringify(env).length <= HUB_LIMITS.ctChars) envs.push(env);
      }
      for (let i = 0; i < envs.length; i += HUB_LIMITS.agentFrameEnvs) ws.send(JSON.stringify({ t: "agents", envs: envs.slice(i, i + HUB_LIMITS.agentFrameEnvs) }));
      return viewers.length;
    };
  });
}

/** `start` / `step` / `done` / `failed`: updates the run, then reports it. */
async function report(argv: string[]): Promise<void> {
  const { runId, command } = parseArgs(argv);
  const c = await loadConfig();
  if (!c.token || !c.url || !c.deviceId || !c.privateJwk) throw new Stop("Not paired. Run once per chat: node --import tsx tools/hub-report/hub-report.ts pair <hubUrl>", 2);
  const now = Date.now();
  const run = applyCommand(runId, c.runs[runId], command, now);
  c.runs[runId] = run;
  pruneRuns(c.runs, now);
  await saveConfig(c);
  const n = await deliver(c, run);
  // Delivered: those events are with the hub now (the next batch carries only new ones, plus the whole state).
  c.runs[runId] = { ...run, unsent: [] };
  await saveConfig(c);
  console.log(n ? `Reported ${command.cmd} ${runId} to ${n} viewer${n === 1 ? "" : "s"}.` : `Sent ${command.cmd} ${runId}, but no phone or hub page is paired to see it.`);
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === "pair" ? pair(rest[0]) : report(process.argv.slice(2))).then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`hub-report: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof Stop ? e.code : 1);
  },
);
