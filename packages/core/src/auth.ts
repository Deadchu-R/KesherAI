import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Whether a request comes from this computer.
 *
 * @param ip - `request.ip`.
 * @returns `true` for IPv4/IPv6 loopback addresses.
 */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Headers a tunnel or proxy adds. A request carrying one came from outside, even if it reached us over 127.0.0.1. */
const FORWARDED = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-proto", "tailscale-user-login", "tailscale-headers-info"];

/**
 * Whether a request really comes from this computer: from a loopback
 * address and not forwarded by a tunnel (Cloudflare connects over
 * 127.0.0.1, so the address alone is not enough).
 *
 * @param request - The request.
 * @returns `true` only for requests made on this computer.
 */
export function isLocalRequest(request: Pick<FastifyRequest, "ip" | "headers">): boolean {
  return isLoopback(request.ip) && !FORWARDED.some((h) => request.headers[h] !== undefined);
}

/**
 * The visitor's address, for counting failed attempts: the real one behind a tunnel.
 *
 * @param request - The request.
 * @returns The address.
 */
export function clientAddress(request: Pick<FastifyRequest, "ip" | "headers">): string {
  const cf = request.headers["cf-connecting-ip"];
  return (Array.isArray(cf) ? cf[0] : cf) ?? request.ip;
}

const failures = new Map<string, { count: number; since: number }>();
const MAX_FAILURES = 20;
const WINDOW_MS = 10 * 60_000;

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
 * same as any web app's; only `/api`, `/v1` and `/mcp` need it. The model
 * APIs (`/v1`, `/mcp`) also take an app's own access key, as a Bearer token
 * or `x-api-key` (Anthropic SDKs), and can ask for one on this computer too.
 *
 * @param app - Fastify instance.
 * @param getToken - Returns the current token (it can be rotated at runtime).
 * @param keys - Checks app access keys, and whether this computer needs one too.
 * @param keys.verify - Returns something for a valid key.
 * @param keys.requireLocally - Whether apps on this computer need a key.
 */
export function registerRemoteAuth(
  app: FastifyInstance,
  getToken: () => string | undefined,
  keys: { verify?: (key: string | undefined) => unknown; requireLocally?: () => boolean } = {},
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    // The model APIs: apps may use their own access key instead of the remote token.
    const apiPath = path.startsWith("/v1/") || path === "/v1" || path === "/mcp";
    if (isLocalRequest(request) && !(apiPath && keys.requireLocally?.())) return;
    if (!path.startsWith("/api/") && path !== "/api" && !apiPath) return;
    // Pairing a phone found on the network: it asks, and the user allows it on this computer.
    if (path === "/api/hello") return;
    if (path === "/api/pair" || /^\/api\/pair\/[0-9a-f-]{36}$/.test(path)) {
      if (request.method === "POST" && path === "/api/pair") return;
      if (request.method === "GET" && path !== "/api/pair") return;
    }
    const token = getToken();
    const xKey = request.headers["x-api-key"];
    const header = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? (typeof xKey === "string" ? xKey : undefined);
    if (apiPath && keys.verify?.(header)) return;
    const query = (request.query as Record<string, string | undefined> | undefined)?.token;
    // Plugin pages run in a sandboxed frame that cannot add headers or cookies, so their files
    // are served under /api/plugin-files/<token>/…, and relative links keep the token.
    const inPath = /^\/api\/plugin-files\/([^/]+)\//.exec(path)?.[1];
    const given = header ?? query ?? inPath;
    const who = clientAddress(request);
    const f = failures.get(who);
    if (f && Date.now() - f.since < WINDOW_MS && f.count >= MAX_FAILURES) {
      await reply.code(429).send({ error: "Too many wrong tokens. Try again in a few minutes." });
      return;
    }
    if (!token || !given || !safeEqual(given, token)) {
      const fresh = !f || Date.now() - f.since >= WINDOW_MS;
      failures.set(who, { count: fresh ? 1 : f.count + 1, since: fresh ? Date.now() : f.since });
      await reply.code(401).send({ error: "Remote access needs a valid token" });
    }
  });
}
