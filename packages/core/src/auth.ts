import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * Whether a request comes from this computer.
 *
 * @param ip - `request.ip`.
 * @returns `true` for IPv4/IPv6 loopback addresses.
 */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Requires the remote token from every request that does not come from this
 * computer. The token is accepted as `Authorization: Bearer <token>` or, for
 * `<img>` tags and EventSource (which cannot set headers), as `?token=`.
 *
 * Requests from this computer are trusted: the server only listens beyond
 * localhost when the user turns remote access on. The interface's own files
 * (HTML, scripts, styles, icons) hold no data and load without a token, the
 * same as any web app's; only `/api` and `/v1` need it.
 *
 * @param app - Fastify instance.
 * @param getToken - Returns the current token (it can be rotated at runtime).
 */
export function registerRemoteAuth(app: FastifyInstance, getToken: () => string | undefined): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isLoopback(request.ip)) return;
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") && path !== "/api" && !path.startsWith("/v1/") && path !== "/v1") return;
    const token = getToken();
    const header = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const query = (request.query as Record<string, string | undefined> | undefined)?.token;
    const given = header ?? query;
    if (!token || !given || !safeEqual(given, token)) {
      await reply.code(401).send({ error: "Remote access needs a valid token" });
    }
  });
}
