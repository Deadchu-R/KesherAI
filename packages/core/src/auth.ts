import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
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
const FORWARDED = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-proto", "tailscale-user-login", "tailscale-headers-info", "tailscale-funnel-request"];

/**
 * Whether a request really comes from this computer: from a loopback
 * address and not forwarded by a tunnel (Cloudflare connects over
 * 127.0.0.1, so the address alone is not enough).
 *
 * @param request - The request.
 * @returns `true` only for requests made on this computer.
 */
export function isLocalRequest(request: Pick<FastifyRequest, "ip" | "headers">): boolean {
  return isLoopback(request.ip) && !FORWARDED.some((h) => request.headers[h] !== undefined) && localHost(request.headers.host);
}

/**
 * Whether the address the browser used is this computer's own name. A page
 * on another site can make its name point at 127.0.0.1 (DNS rebinding); its
 * requests then come from this computer but carry that site's name, so they
 * are not trusted as local.
 *
 * @param host - The Host header.
 * @returns Whether it names this computer.
 */
export function localHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "::1" || name === hostname().toLowerCase() || name === `${hostname().toLowerCase()}.local`;
}

/**
 * Whether a browser page from `origin` may call KesherAI's own API (`/api`).
 * The interface itself (same address), the Android app (http://localhost,
 * no port) and, for /api/browser only, the browser extension. Any other
 * website the user happens to visit cannot, even on this computer.
 *
 * @param origin - The Origin header.
 * @param host - The Host header.
 * @param path - The path asked for.
 * @returns Whether it is allowed.
 */
export function allowedOrigin(origin: string, host: string | undefined, path: string): boolean {
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return true;
  if (/^(https?|capacitor):\/\/localhost$/.test(origin)) return true;
  if (/^(chrome|moz)-extension:\/\/[\w-]+$/.test(origin) && path.startsWith("/api/browser")) return true;
  // The Unreal Editor's WebSocket (libwebsockets) sends the address it connects to as its Origin, often
  // without a scheme or a port ("127.0.0.1"): accepted for the editor's own socket only (found testing the
  // bridge: every connection was refused with 403).
  if (path === "/api/unreal/ws" && /^((https?|wss?):\/\/)?(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i.test(origin)) return true;
  return false;
}

/** What kind of key a request presented, for the access log (never the value itself). */
export type KeyKind = "device-key" | "shared" | "other" | "none";

/**
 * The visitor's address, for counting failed attempts: the real one behind a tunnel.
 *
 * @param request - The request.
 * @returns The address.
 */
export function clientAddress(request: Pick<FastifyRequest, "ip" | "headers">): string {
  // Only the tunnel (which connects from this computer) may say who is behind it; anyone on the
  // network could send that header to look like someone else and dodge the limit on wrong tokens.
  if (!isLoopback(request.ip)) return request.ip;
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

/** The paired device a request came in with (its own key), if any. */
const pairedDevice = new WeakMap<object, string>();

/** @returns The name of the paired device that sent this request (with its own key), or undefined. */
export function pairedDeviceOf(request: Pick<FastifyRequest, "raw">): string | undefined {
  return pairedDevice.get(request.raw);
}

const pairedDeviceId = new WeakMap<object, string>();

/** @returns The id of the paired device that sent this request (with its own key), or undefined. */
export function pairedDeviceIdOf(request: Pick<FastifyRequest, "raw">): string | undefined {
  return pairedDeviceId.get(request.raw);
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
  log?: (r: { address: string; method: string; path: string; status: number; via: "tunnel" | "network"; agent?: string; device?: string; kind?: KeyKind; ms?: number }) => void,
  devices?: DeviceAuth,
): void {
  const deviceOf = new WeakMap<object, string>();
  // The kind of key on requests refused in onRequest (a 429 lockout has no device name).
  const refusedKind = new WeakMap<object, KeyKind>();
  // What came from outside this computer, for Settings → Phone (never tokens or query strings).
  if (log) {
    app.addHook("onResponse", async (request, reply) => {
      if (isLocalRequest(request)) return;
      const path = (request.url.split("?")[0] ?? "").slice(0, 200);
      // Only the API: the interface's own files (scripts, pictures) would drown out the rest.
      if (!/^\/(api|v1|mcp|comfy-ui)\b/.test(path)) return;
      const status = reply.statusCode;
      if (status < 400 && /^\/api\/(downloads\/events|activity|computer\/status)/.test(path)) return;
      const device = deviceOf.get(request.raw);
      log({ address: clientAddress(request), method: request.method, path, status: status === 401 || status === 403 || status === 429 ? status : status >= 400 ? 200 : status, via: request.headers["cf-connecting-ip"] ? "tunnel" : "network", ms: Math.round(reply.elapsedTime), ...(device ? { device } : {}), ...(status >= 400 ? { kind: refusedKind.get(request.raw) ?? "none" } : {}), ...(typeof request.headers["user-agent"] === "string" ? { agent: request.headers["user-agent"] } : {}) });
    });
  }
  app.addHook("onRequest", async (request, reply) => {
    // Paths are compared as the router reads them: "/%61pi/…" is "/api/…".
    let path = request.url.split("?")[0] ?? "";
    try {
      path = decodeURIComponent(path);
    } catch {
      await reply.code(400).send({ error: "Bad address" });
      return;
    }
    path = path.replace(/\/{2,}/g, "/");
    // What the request presented as its key, read once so every refusal below can log the key's kind (never the value).
    const token = getToken();
    const xKey = request.headers["x-api-key"];
    const header = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? (typeof xKey === "string" ? xKey : undefined);
    const query = (request.query as Record<string, string | undefined> | undefined)?.token;
    // Plugin pages run in a sandboxed frame that cannot add headers or cookies, so their files
    // are served under /api/plugin-files/<token>/…, and relative links keep the token.
    const inPath = /^\/api\/plugin-files\/([^/]+)\//.exec(path)?.[1];
    const given = header ?? query ?? inPath;
    // The kind of key, for the access log (never the value): a device key starts with kd_ (even one
    // no longer paired, so the user sees "an old phone code" instead of a stranger), the shared token
    // is the one the user set, anything else is "other". Set once, read back only when the request
    // ends up refused (a 4xx).
    const kind: KeyKind = given?.startsWith("kd_") ? "device-key" : token && given && safeEqual(given, token) ? "shared" : given ? "other" : "none";
    refusedKind.set(request.raw, kind);
    // Other websites open in the user's browser must not use this computer's KesherAI
    // (cross-site requests, even simple form posts, are refused for /api).
    // The same for ComfyUI's editor (its API can run any workflow) and KesherAI's MCP server (it reads your knowledge).
    if ((path.startsWith("/api") && !path.startsWith("/api/plugin-files/")) || path.startsWith("/comfy-ui") || path === "/mcp") {
      const origin = request.headers.origin;
      const site = request.headers["sec-fetch-site"];
      if ((typeof origin === "string" && origin !== "null" && !allowedOrigin(origin, request.headers.host, path)) || origin === "null" || (site === "cross-site" && !(typeof origin === "string" && allowedOrigin(origin, request.headers.host, path)))) {
        await reply.code(403).send({ error: "Requests from other websites are not allowed." });
        return;
      }
    }
    // The model APIs: apps may use their own access key instead of the remote token.
    const apiPath = path.startsWith("/v1/") || path === "/v1" || path === "/mcp";
    // A web page from another site may use the model API only with an access key, never as "this computer".
    const foreignPage = apiPath && typeof request.headers.origin === "string" && !allowedOrigin(request.headers.origin, request.headers.host, path);
    if (isLocalRequest(request) && !(apiPath && keys.requireLocally?.()) && !foreignPage) return;
    if (!path.startsWith("/api/") && path !== "/api" && !apiPath) return;
    // Pairing a phone found on the network: it asks, and the user allows it on this computer.
    if (path === "/api/hello") return;
    // The Approve / Deny buttons on a phone or watch notification: a one-time code for one request.
    if (request.method === "POST" && /^\/api\/quick-approve\/[\w-]{32}$/.test(path)) return;
    if (path === "/api/pair" || /^\/api\/pair\/[0-9a-f-]{36}$/.test(path)) {
      if (request.method === "POST" && path === "/api/pair") return;
      if (request.method === "GET" && path !== "/api/pair") return;
    }
    if (apiPath && keys.verify?.(header)) return;
    const who = clientAddress(request);
    const f = failures.get(who);
    // Through the internet link (Cloudflare connects from this computer and says who is behind it).
    // Tailscale Funnel marks what it brings from the internet too (anyone may send that header, but it only makes the rules stricter).
    const viaTunnel = (isLoopback(request.ip) && request.headers["cf-connecting-ip"] !== undefined) || request.headers["tailscale-funnel-request"] !== undefined;
    const device = devices?.find(given);
    const shared = !!token && !!given && safeEqual(given, token);
    // The lockout stops guessing; a right key cannot be a guess. Without this, the user's own phone was locked out
    // for 10 minutes because an old code it sent a minute earlier (after an app update) counted against its address,
    // which on a mobile network it shares with many others.
    if (!device && !shared && f && Date.now() - f.since < WINDOW_MS && f.count >= MAX_FAILURES) {
      await reply.code(429).send({ error: "Too many wrong tokens. Try again in a few minutes." });
      return;
    }
    if (device) {
      // A connector key (for an AI app) opens KesherAI's MCP server and nothing else.
      if ((device as { scope?: string }).scope === "mcp" && path !== "/mcp") {
        await reply.code(403).send({ error: "This key is only for KesherAI's MCP server (/mcp)." });
        return;
      }
      const idle = devices!.idleDays();
      if (viaTunnel && idle > 0 && device.lastSeen && Date.now() - Date.parse(device.lastSeen) > idle * 86_400_000) {
        await reply.code(403).send({ error: `This device was not used for over ${idle} days, so it cannot come in through the internet link. Use it once on the home network, or pair it again.` });
        return;
      }
      devices!.seen(device, who);
      deviceOf.set(request.raw, device.name);
      pairedDevice.set(request.raw, device.name);
      if (device.id) pairedDeviceId.set(request.raw, device.id);
      return;
    }
    if (shared && viaTunnel && devices?.devicesOnly()) {
      await reply.code(403).send({ error: "Through the internet link, only paired devices with their own key can come in. Pair this device on the home network first." });
      return;
    }
    if (!shared) {
      const fresh = !f || Date.now() - f.since >= WINDOW_MS;
      failures.set(who, { count: fresh ? 1 : f.count + 1, since: fresh ? Date.now() : f.since });
      await reply.code(401).send({ error: "Remote access needs a valid token" });
    }
  });
}

/** Device keys, for registerRemoteAuth (see device-keys.ts). */
export interface DeviceAuth {
  find(key: string | undefined): { id?: string; name: string; lastSeen?: string } | undefined;
  seen(device: { name: string; lastSeen?: string }, address: string): void;
  /** Through the internet link, only device keys (not the shared token). */
  devicesOnly(): boolean;
  /** Through the internet link, a device key unused this many days stops working (0 = never). */
  idleDays(): number;
}
