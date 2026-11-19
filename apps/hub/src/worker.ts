/**
 * Kesher Cloud hub: the Worker entry. It answers the bare page, refuses everything when the outside kill switch
 * (`HUB_DISABLED = "1"`) is on, and forwards API and socket requests to the one Durable Object, with the caller's IP in
 * a header it sets itself. The cron (every 5 minutes) runs the object's cleanup.
 *
 * Nothing here deploys itself: the owner deploys it from the Cloudflare dashboard (apps/hub/README.md).
 */
import type { ExecutionContext, HubEnvBindings } from "./cf.js";
import { json, SECURITY_HEADERS } from "./http.js";

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
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws/device") {
      const headers = new Headers(req.headers);
      // The DO trusts this header, so the Worker always overwrites it.
      headers.set("x-kh-ip", req.headers.get("cf-connecting-ip") ?? "unknown");
      return hubStub(env).fetch(new Request(req, { headers }));
    }
    if (url.pathname === "/" && req.method === "GET") {
      // The page itself is built separately (apps/hub screens); until then a plain placeholder.
      return new Response("Kesher Cloud hub. This hub is private.", { headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
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
