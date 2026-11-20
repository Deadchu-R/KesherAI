/**
 * Kesher Cloud hub: the Worker entry. The page itself is static (public/, served before the Worker). It refuses
 * everything when the outside kill switch (`HUB_DISABLED = "1"`) is on, answers the page's `/api/config`, and forwards
 * API, socket and Claude-connector requests (`/mcp`, `/oauth/*`, `/.well-known/oauth-*`) to the one Durable Object, with the caller's IP in a header it sets itself. The cron (every 5 minutes) runs the object's cleanup.
 *
 * Nothing here deploys itself: the owner deploys it from the Cloudflare dashboard (apps/hub/README.md).
 */
import type { ExecutionContext, HubEnvBindings } from "./cf.js";
import { isConnectorPath } from "./connector.js";
import { json } from "./http.js";
import { vapidFromEnv } from "./web-push.js";

export { HubObject } from "./hub-do.js";

/** The one object, named after its single owner. */
function hubStub(env: HubEnvBindings) {
  return env.HUB.get(env.HUB.idFromName("owner"));
}

export default {
  /**
   * One request from the internet.
   *
   * @param req - The request.
   * @param env - Bindings and secrets.
   * @returns The answer.
   */
  async fetch(req: Request, env: HubEnvBindings): Promise<Response> {
    if (env.HUB_DISABLED === "1") return json({ error: "The hub is switched off." }, 503);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/internal/")) return json({ error: "Not found." }, 404);
    // The page's settings: the Google client id and the Web Push public key (both public by design; they open nothing).
    // The push key is offered only when the whole VAPID setup is there, so the page never subscribes to a hub that cannot send.
    if (url.pathname === "/api/config" && req.method === "GET") return json({ googleClientId: env.GOOGLE_CLIENT_ID ?? "", vapidPublicKey: vapidFromEnv(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT)?.publicKey ?? "" });
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws/device" || isConnectorPath(url.pathname)) {
      const headers = new Headers(req.headers);
      // The DO trusts this header, so the Worker always overwrites it.
      headers.set("x-kh-ip", req.headers.get("cf-connecting-ip") ?? "unknown");
      return hubStub(env).fetch(new Request(req, { headers }));
    }
    return json({ error: "Not found." }, 404);
  },

  /**
   * The cron trigger: cleanup in the object.
   *
   * @param _event - The schedule (unused).
   * @param env - Bindings.
   * @param ctx - Background work.
   */
  async scheduled(_event: unknown, env: HubEnvBindings, ctx: ExecutionContext): Promise<void> {
    if (env.HUB_DISABLED === "1") return;
    ctx.waitUntil(hubStub(env).fetch(new Request("https://hub.internal/internal/cleanup", { method: "POST" })));
  },
};
