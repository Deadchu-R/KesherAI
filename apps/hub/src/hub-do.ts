/**
 * The Durable Object: the hub's single brain (one object for its one owner). It owns the SQLite store and the device
 * sockets (Hibernation API, so an idle hub costs nothing), and turns HTTP and socket events into {@link Hub} calls.
 *
 * Routes (the Worker forwards everything except static files; `x-kh-ip` is set by the Worker, never by the caller):
 * - Open (rate limited): `POST /api/signin`, `POST /api/pair/start`, `POST /api/pair/poll`.
 * - Device token (Bearer): `POST /api/ticket`, `POST /api/rotate`. Socket: `GET /ws/device?ticket=…`.
 * - Signed-in owner (session cookie + same Origin for changes): `GET /api/state`, `POST /api/signout`,
 *   `POST /api/pair/check`, `POST /api/pair/approve`, `POST /api/devices/:id/revoke`, `POST /api/kill`.
 * - Internal (cron only): `POST /internal/cleanup`.
 */
import type { HubFrame } from "../../../packages/shared/src/hub.js";
import { fireClaudeTask } from "./claude-cloud.js";
import { cfGlobals, upgradeResponse, type CfWebSocket, type DurableObjectState, type HubEnvBindings } from "./cf.js";
import { googleKeys, verifyGoogleIdToken } from "./google.js";
import { bearer, cookie, json, readJson, sameOrigin, SESSION_COOKIE, sessionCookie } from "./http.js";
import { Hub, isHubError, type DeviceSockets } from "./hub.js";
import { SqlStore } from "./sql-store.js";

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

  /**
   * @param ctx - The object's state.
   * @param env - The Worker's bindings and secrets.
   */
  constructor(private readonly ctx: DurableObjectState, env: HubEnvBindings) {
    const keyFor = googleKeys();
    this.hub = new Hub({
      store: new SqlStore(ctx.storage.sql),
      sockets: socketsOf(ctx),
      config: { allowedEmail: env.ALLOWED_EMAIL, hubPrivateJwk: env.HUB_PRIVATE_KEY, claude: { triggerId: env.CLAUDE_TRIGGER_ID, token: env.CLAUDE_FIRE_TOKEN } },
      verifyIdToken: (t) => verifyGoogleIdToken(t, env.GOOGLE_CLIENT_ID ?? "", keyFor, Date.now()),
      fireClaude: (text, trigger) => fireClaudeTask(text, trigger),
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
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get("x-kh-ip") ?? "unknown";
    const answer = (r: unknown) => (isHubError(r) ? json({ error: r.error }, r.status) : json(r));

    if (path === "/internal/cleanup" && req.method === "POST") return json({ expired: this.hub.cleanup() });

    if (path === "/ws/device") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "Expected a WebSocket." }, 426);
      if (this.hub.paused) return json({ error: "The hub is paused." }, 503);
      const device = await this.hub.takeTicket(url.searchParams.get("ticket"));
      if (!device) return json({ error: "Unknown or used ticket." }, 401);
      const { WebSocketPair } = cfGlobals();
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [device.id]);
      server.serializeAttachment({ deviceId: device.id });
      await this.hub.onOpen(device.id);
      return upgradeResponse(pair[0]);
    }

    if (req.method === "POST" && path === "/api/pair/start") return answer(await this.hub.pairStart(ip, (await readJson(req)) ?? {}));
    if (req.method === "POST" && path === "/api/pair/poll") return answer(await this.hub.pairPoll(ip, (await readJson(req))?.pollSecret));
    if (req.method === "POST" && path === "/api/ticket") return answer(await this.hub.issueTicket(bearer(req)));
    if (req.method === "POST" && path === "/api/rotate") return answer(await this.hub.rotateToken(bearer(req)));

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
    await this.hub.onFrame(id, typeof message === "string" ? message : null);
  }

  /**
   * A device socket closed (Hibernation API handler).
   *
   * @param ws - The socket.
   */
  async webSocketClose(ws: CfWebSocket): Promise<void> {
    const id = this.deviceOf(ws);
    if (id) this.hub.onClose(id);
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
