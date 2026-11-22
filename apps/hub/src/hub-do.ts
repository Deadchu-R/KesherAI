/**
 * The Durable Object: the hub's single brain (one object for its one owner). It owns the SQLite store and the device
 * sockets (Hibernation API, so an idle hub costs nothing), and turns HTTP and socket events into {@link Hub} calls.
 *
 * Routes (the Worker forwards everything except static files; `x-kh-ip` is set by the Worker, never by the caller):
 * - Open (rate limited): `POST /api/signin`, `POST /api/pair/start`, `POST /api/pair/poll`.
 * - Device token (Bearer): `POST /api/ticket`, `POST /api/rotate`, `GET /api/agents?since=…` (activity catch-up),
 *   `POST /api/push/subscribe` `{endpoint, keys, lang}` and `POST /api/push/unsubscribe` (this device's notifications).
 *   `POST /api/answer` `{env}`: one sealed `approval_answer` from a phone's notification (its service worker).
 *   Socket: `GET /ws/device?ticket=…`.
 * - Signed-in owner (session cookie + same Origin for changes): `GET /api/state`, `POST /api/signout`,
 *   `POST /api/pair/check`, `POST /api/pair/approve`, `POST /api/devices/:id/revoke`, `POST /api/kill`.
 * - The Claude connector (connector.ts): `/.well-known/oauth-*`, `/oauth/*`, `/mcp`; and, signed in,
 *   `POST /api/oauth/check`, `POST /api/oauth/decide`, `POST /api/connections/:id/revoke`.
 * - Device token (Bearer), read-only: `GET /api/diag`, the in-memory diagnostics ring (diag.ts; rate limited, never writes).
 * - Internal (cron only): `POST /internal/cleanup`.
 *
 * When storage refuses (Cloudflare's daily quota of rows read or written is used up), connected devices keep relaying
 * from memory: each socket carries its device row in its attachment (kept by Cloudflare through hibernation, not in
 * SQLite), so a hub that wakes without storage still knows who is on. A call that must keep something answers 503 with
 * `{error: "hub-storage-limit"}` (or `"hub-storage-error"`) instead of a bare 500; socket frames are dropped quietly.
 */
import { cleanDeviceKind, cleanOptIn, type HubFrame } from "../../../packages/shared/src/hub.js";
import { CachedStore } from "./cached-store.js";
import { fireClaudeTask } from "./claude-cloud.js";
import { connectorOwnerRoute, connectorRoute, isConnectorPath } from "./connector.js";
import { cfGlobals, upgradeResponse, type CfWebSocket, type DurableObjectState, type HubEnvBindings } from "./cf.js";
import { DiagRing, diagPath } from "./diag.js";
import { googleKeys, verifyGoogleIdToken } from "./google.js";
import { bearer, cookie, json, readJson, sameOrigin, SESSION_COOKIE, sessionCookie } from "./http.js";
import { Hub, isHubError, type DeviceSockets } from "./hub.js";
import { LIMITS } from "./rate-limit.js";
import { SqlStore } from "./sql-store.js";
import { guardStore, secondsToUtcMidnight, storageCode } from "./storage-guard.js";
import type { DeviceRow } from "./store.js";
import { UsageMeter } from "./usage.js";
import { vapidFromEnv } from "./web-push.js";

/** A socket's attachment: its device, and the device's row without live state (at most 2 KB). */
interface SocketAttachment {
  deviceId: string;
  row?: Omit<DeviceRow, "agents" | "busy" | "away">;
}

/** The device row a socket carries, cleaned (an older socket carries only its id: undefined). */
function attachedRow(a: unknown): DeviceRow | undefined {
  const r = (a as SocketAttachment | null)?.row;
  if (!r || typeof r.id !== "string" || typeof r.publicKey !== "string" || typeof r.tokenHash !== "string") return undefined;
  const optIn = cleanOptIn(r.optIn);
  return { id: r.id, name: String(r.name ?? ""), kind: cleanDeviceKind(r.kind), publicKey: r.publicKey, tokenHash: r.tokenHash, tokenIssuedAt: Number(r.tokenIssuedAt) || 0, createdAt: Number(r.createdAt) || 0, ...(Number.isFinite(r.lastSeen) ? { lastSeen: Number(r.lastSeen) } : {}), busy: false, optIn, agents: [], ...(typeof r.version === "string" ? { version: r.version } : {}) };
}

/** Sockets of this object, found by their device-id tag. */
function socketsOf(ctx: DurableObjectState): DeviceSockets {
  return {
    send(deviceId: string, frame: HubFrame): boolean {
      const list = ctx.getWebSockets(deviceId);
      const text = JSON.stringify(frame);
      for (const ws of list) {
        try {
          ws.send(text);
        } catch {
          // A socket that is closing: the next hello delivers what is queued.
        }
      }
      return list.length > 0;
    },
    isOnline: (deviceId) => ctx.getWebSockets(deviceId).length > 0,
    close(deviceId, code, reason) {
      for (const ws of ctx.getWebSockets(deviceId)) {
        try {
          ws.close(code, reason);
        } catch {
          // Already closed.
        }
      }
    },
    closeAll(code, reason) {
      for (const ws of ctx.getWebSockets()) {
        try {
          ws.close(code, reason);
        } catch {
          // Already closed.
        }
      }
    },
  };
}

/** The hub's Durable Object (bound as `HUB` in wrangler.toml). */
export class HubObject {
  private readonly hub: Hub;
  /** Recent problems, in memory only (diag.ts); read by the PC through `GET /api/diag`. */
  private readonly diag = new DiagRing();
  /** Rows read and written today, per store call (memory only; in `GET /api/diag`). */
  private readonly usage = new UsageMeter();

  /**
   * @param ctx - The object's state.
   * @param env - The Worker's bindings and secrets.
   */
  constructor(private readonly ctx: DurableObjectState, env: HubEnvBindings) {
    const keyFor = googleKeys();
    const store = new CachedStore(guardStore(new SqlStore(ctx.storage.sql, this.usage)));
    // Connected devices are known from their sockets even before (or without) the first storage read.
    store.seed(ctx.getWebSockets().flatMap((ws) => {
      const row = attachedRow(ws.deserializeAttachment());
      return row ? [row] : [];
    }));
    this.hub = new Hub({
      store,
      sockets: socketsOf(ctx),
      config: { allowedEmail: env.ALLOWED_EMAIL, hubPrivateJwk: env.HUB_PRIVATE_KEY, claude: { triggerId: env.CLAUDE_TRIGGER_ID, token: env.CLAUDE_FIRE_TOKEN }, vapid: vapidFromEnv(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT) },
      verifyIdToken: (t) => verifyGoogleIdToken(t, env.GOOGLE_CLIENT_ID ?? "", keyFor, Date.now()),
      fireClaude: (text, trigger) => fireClaudeTask(text, trigger),
      warn: (message) => this.diag.add({ kind: "storage", where: "bookkeeping", message }),
    });
    // Pings are answered without waking the object (free while it hibernates).
    const { WebSocketRequestResponsePair } = cfGlobals();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  /**
   * One HTTP request (or socket upgrade) from the Worker.
   *
   * @param req - The request.
   * @returns The answer.
   */
  async fetch(req: Request): Promise<Response> {
    const t0 = Date.now();
    const path = diagPath(new URL(req.url).pathname);
    try {
      const res = await this.route(req);
      // Every answer that is not a success is kept with its reason (the socket upgrade's 101 is a success).
      if (res.status !== 101 && (res.status < 200 || res.status >= 300)) {
        const body = (await res.clone().json().catch(() => undefined)) as { error?: unknown; message?: unknown } | undefined;
        this.diag.add({ kind: "http", where: "http", method: req.method, path, status: res.status, ...(typeof body?.error === "string" ? { code: body.error } : {}), ...(typeof body?.message === "string" ? { message: body.message } : {}), ms: Date.now() - t0 });
      }
      return res;
    } catch (e) {
      const code = storageCode(e);
      if (!code) {
        this.diag.error("http", e, { method: req.method, path, ms: Date.now() - t0 });
        throw e;
      }
      console.warn(`hub: storage refused a request (${code})`);
      const message = e instanceof Error ? e.message : code;
      this.diag.add({ kind: "storage", where: "http", method: req.method, path, status: 503, code, message, ms: Date.now() - t0 });
      return json({ error: code, message }, 503, { "retry-after": String(secondsToUtcMidnight(Date.now())) });
    }
  }

  /**
   * `GET /api/diag`: the diagnostics ring and today's storage counts (rows read and written per kind), for a paired
   * device. The token is checked from memory (or its signature), the rate limit lives in memory, nothing is written.
   */
  private async diagRoute(req: Request): Promise<Response> {
    const d = await this.hub.deviceForToken(bearer(req));
    if (!d) return json({ error: "Unknown device." }, 401);
    if (!this.hub.limits.take(`diag:${d.id}`, LIMITS.diag)) return json({ error: "Too many tries." }, 429);
    return json({ ...this.diag.snapshot(), usage: this.usage.snapshot() });
  }

  /** {@link fetch}'s routing (storage errors are turned into 503 answers there). */
  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get("x-kh-ip") ?? "unknown";
    const answer = (r: unknown) => (isHubError(r) ? json({ error: r.error }, r.status) : json(r));

    if (path === "/internal/cleanup" && req.method === "POST") {
      try {
        return json({ expired: this.hub.cleanup() });
      } catch (e) {
        this.diag.error("cleanup", e);
        throw e;
      }
    }
    if (path === "/api/diag" && req.method === "GET") return this.diagRoute(req);

    if (path === "/ws/device") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected a WebSocket." }, 426);
      if (this.hub.paused) return json({ error: "The hub is paused." }, 503);
      const device = await this.hub.takeTicket(url.searchParams.get("ticket"));
      if (!device) return json({ error: "Unknown or used ticket." }, 401);
      const { WebSocketPair } = cfGlobals();
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [device.id]);
      const { agents: _a, busy: _b, away: _w, ...row } = device;
      try {
        server.serializeAttachment({ deviceId: device.id, row } satisfies SocketAttachment);
      } catch {
        // Over the attachment's 2 KB: the id alone (the row is read from storage instead).
        server.serializeAttachment({ deviceId: device.id } satisfies SocketAttachment);
      }
      // The socket opens even when storage refuses writes (the daily quota): the open's bookkeeping is skipped.
      // Any other failure there is recorded too, and the socket still opens: the PC's hello and beats carry the state.
      await this.hub.onOpen(device.id).catch((e: unknown) => {
        if (storageCode(e)) {
          console.warn("hub: open bookkeeping skipped (storage refused)");
          this.diag.add({ kind: "storage", where: "open", message: e instanceof Error ? e.message : "storage refused" });
        } else {
          console.warn("hub: open bookkeeping failed");
          this.diag.error("open", e);
        }
      });
      return upgradeResponse(pair[0]);
    }

    if (isConnectorPath(path)) return (await connectorRoute(req, this.hub, await this.hub.ipHash(ip))) ?? json({ error: "Not found." }, 404);

    if (req.method === "POST" && path === "/api/pair/start") return answer(await this.hub.pairStart(ip, (await readJson(req)) ?? {}));
    if (req.method === "POST" && path === "/api/pair/poll") return answer(await this.hub.pairPoll(ip, (await readJson(req))?.pollSecret));
    if (req.method === "POST" && path === "/api/ticket") return answer(await this.hub.issueTicket(bearer(req)));
    if (req.method === "POST" && path === "/api/rotate") return answer(await this.hub.rotateToken(bearer(req)));
    if (req.method === "POST" && path === "/api/push/subscribe") return answer(await this.hub.pushSubscribe(bearer(req), await readJson(req)));
    if (req.method === "POST" && path === "/api/answer") return answer(await this.hub.answerByHttp(bearer(req), await readJson(req)));
    if (req.method === "POST" && path === "/api/push/unsubscribe") return answer(await this.hub.pushUnsubscribe(bearer(req)));
    if (req.method === "GET" && path === "/api/agents") return answer(await this.hub.agentsSince(bearer(req), url.searchParams.get("since")));

    if (req.method === "POST" && path === "/api/signin") {
      if (!sameOrigin(req)) return json({ error: "Not allowed." }, 403);
      const body = await readJson(req);
      const r = await this.hub.signIn(typeof body?.credential === "string" ? body.credential : "", ip);
      if (isHubError(r)) return answer(r);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(r.session) });
    }

    // Everything below is the signed-in owner's.
    const session = cookie(req, SESSION_COOKIE);
    if (!(await this.hub.checkSession(session))) return json({ error: "Sign in first." }, 401);
    if (req.method === "GET" && path === "/api/state") return json(await this.hub.state());
    if (req.method !== "POST") return json({ error: "Not found." }, 404);
    if (!sameOrigin(req)) return json({ error: "Not allowed." }, 403);
    const body = (await readJson(req)) ?? {};

    if (path === "/api/signout") {
      await this.hub.signOut(session!);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(undefined) });
    }
    if (path === "/api/pair/check") return answer(await this.hub.pairPeek(body.code));
    if (path === "/api/pair/approve") return answer(await this.hub.pairApprove(body.code, body.name));
    const conn = await connectorOwnerRoute(path, body, this.hub, url.origin);
    if (conn) return conn;
    const revoke = /^\/api\/devices\/([\w-]{1,64})\/revoke$/.exec(path);
    if (revoke) return this.hub.revoke(revoke[1]!) ? json({ ok: true }) : json({ error: "No such device." }, 404);
    if (path === "/api/kill") {
      switch (body.what) {
        case "pause":
        case "resume":
          this.hub.setPaused(body.what === "pause");
          break;
        case "cloud-off":
        case "cloud-on":
          this.hub.setCloudOff(body.what === "cloud-off");
          break;
        case "drop-queue":
          this.hub.dropQueued();
          break;
        case "drop-agents":
          this.hub.dropAgentActivity();
          break;
        case "everything":
          this.hub.killAll();
          return json({ ok: true }, 200, { "set-cookie": sessionCookie(undefined) });
        default:
          return json({ error: "Which switch?" }, 400);
      }
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  }

  /** The device id a socket was accepted for. */
  private deviceOf(ws: CfWebSocket): string | undefined {
    const a = ws.deserializeAttachment() as { deviceId?: unknown } | null;
    return typeof a?.deviceId === "string" ? a.deviceId : undefined;
  }

  /**
   * A frame from a device socket (Hibernation API handler).
   *
   * @param ws - The socket.
   * @param message - The frame.
   */
  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const id = this.deviceOf(ws);
    if (!id) return ws.close(4000, "unknown");
    try {
      await this.hub.onFrame(id, typeof message === "string" ? message : null);
    } catch (e) {
      // The frame is dropped; the device stays connected (the next snapshot or beat carries the state again).
      this.recordSocketError("socket-message", e);
      if (!storageCode(e)) throw e;
    }
  }

  /**
   * A device socket closed (Hibernation API handler).
   *
   * @param ws - The socket.
   */
  async webSocketClose(ws: CfWebSocket): Promise<void> {
    const id = this.deviceOf(ws);
    try {
      if (id) this.hub.onClose(id);
    } catch (e) {
      this.recordSocketError("socket-close", e);
      if (!storageCode(e)) throw e;
    }
  }

  /** Puts a socket handler's failure in the diagnostics ring (a refused write as a storage warning). */
  private recordSocketError(where: string, e: unknown): void {
    if (storageCode(e)) this.diag.add({ kind: "storage", where, code: storageCode(e), message: e instanceof Error ? e.message : "storage refused" });
    else this.diag.error(where, e);
  }

  /**
   * A device socket failed (Hibernation API handler).
   *
   * @param ws - The socket.
   */
  async webSocketError(ws: CfWebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
