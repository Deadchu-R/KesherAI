/**
 * HTTP routes of the Claude connector (oauth.ts + mcp.ts), as Claude's custom connectors call them:
 *
 * - Open: `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728), `GET /.well-known/oauth-authorization-server`
 *   (RFC 8414), `POST /oauth/register` (RFC 7591, rate limited), `GET /oauth/authorize` (sends the browser to the hub's
 *   approval page, `/connect`), `POST /oauth/token` (form-encoded, rate limited).
 * - Access token (`Authorization: Bearer kc_…`): `POST /mcp` (JSON-RPC; `401` + `WWW-Authenticate` starts sign-in).
 * - Signed-in owner (session cookie + same Origin, checked by the Durable Object before these): `POST /api/oauth/check`
 *   `{params}`, `POST /api/oauth/decide` `{params, allow}`, `POST /api/connections/:id/revoke`.
 */
import { json, readJson } from "./http.js";
import type { Hub } from "./hub.js";
import { handleRpc, MCP_VERSIONS } from "./mcp.js";
import { CONNECTOR, isOauthError, type AuthorizeParams } from "./oauth.js";
import { LIMITS } from "./rate-limit.js";

/**
 * The connector's addresses on this hub (all on the hub's own origin).
 *
 * @param origin - The hub's origin.
 * @returns The MCP URL (the OAuth resource), its metadata document and the issuer.
 */
export function connectorUrls(origin: string): { resource: string; metadata: string; issuer: string } {
  return { resource: `${origin}/mcp`, metadata: `${origin}/.well-known/oauth-protected-resource/mcp`, issuer: origin };
}

/**
 * Whether a path is one of the connector's open or token-protected routes (the Worker forwards these to the object).
 *
 * @param path - The request's path.
 * @returns True for `/mcp`, `/oauth/*` and `/.well-known/oauth-*`.
 */
export function isConnectorPath(path: string): boolean {
  return path === "/mcp" || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");
}

/** The authorization request's parameters the approval page passes on (nothing else is read). */
const PARAM_KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

/** Only the known parameters, as short strings. */
function authorizeParams(x: unknown): AuthorizeParams {
  const src = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const k of PARAM_KEYS) if (typeof src[k] === "string" && (src[k] as string).length <= 1000) out[k] = src[k] as string;
  return out;
}

/** The `401` that tells Claude where to sign in (RFC 9728 §5.1). */
function unauthorized(origin: string, error?: string): Response {
  const meta = connectorUrls(origin).metadata;
  const value = `Bearer resource_metadata="${meta}", scope="${CONNECTOR.scope}"${error ? `, error="${error}"` : ""}`;
  return json({ error: error ?? "unauthorized", error_description: "Connect the hub in Claude first." }, 401, { "www-authenticate": value });
}

/**
 * The open and token-protected connector routes. Undefined when the path is not one of them.
 *
 * @param req - The request.
 * @param hub - The hub.
 * @param ipHash - The caller's salted IP hash (for rate limits).
 * @returns The answer, or undefined.
 */
export async function connectorRoute(req: Request, hub: Hub, ipHash: string): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname;
  const origin = url.origin;
  const urls = connectorUrls(origin);

  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return json({ resource: urls.resource, authorization_servers: [urls.issuer], scopes_supported: [CONNECTOR.scope], bearer_methods_supported: ["header"], resource_name: "Kesher Cloud hub" });
  }
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: urls.issuer,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      scopes_supported: [CONNECTOR.scope, "offline_access"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (path === "/oauth/register") {
    if (req.method !== "POST") return json({ error: "Not found." }, 404);
    if (!hub.limits.take(`oauthRegister:${ipHash}`, LIMITS.pairStart)) return json({ error: "temporarily_unavailable", error_description: "Too many tries." }, 429);
    const r = hub.connector.register(await readJson(req));
    return isOauthError(r) ? json({ error: r.error, error_description: r.error_description }, r.status) : json(r, 201);
  }
  if (path === "/oauth/authorize" && req.method === "GET") {
    // The approval happens on the hub page, where the owner is signed in; the page sends the same query back.
    // `/connect` is public/connect.html (static assets' default html_handling serves it without the extension).
    return new Response(null, { status: 302, headers: { location: `/connect${url.search}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  if (path === "/oauth/token") {
    if (req.method !== "POST") return json({ error: "Not found." }, 404);
    if (!hub.limits.take(`oauthToken:${ipHash}`, LIMITS.pairPoll)) return json({ error: "temporarily_unavailable", error_description: "Too many tries." }, 429);
    if (!(req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) return json({ error: "invalid_request", error_description: "Send the form as application/x-www-form-urlencoded." }, 400);
    const text = await req.text();
    if (text.length > 4096) return json({ error: "invalid_request", error_description: "Too big." }, 400);
    const r = await hub.connector.token(new URLSearchParams(text));
    return isOauthError(r) ? json({ error: r.error, error_description: r.error_description }, r.status) : json(r, 200, { pragma: "no-cache" });
  }
  if (path === "/mcp") {
    // DNS-rebinding guard (MCP transport spec): a browser page elsewhere never gets an answer.
    const from = req.headers.get("origin");
    if (from && from !== origin) return json({ error: "Not allowed." }, 403);
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return unauthorized(origin);
    const grant = await hub.connector.verify(auth.slice(7).trim());
    if (!grant) return unauthorized(origin, "invalid_token");
    if (req.method !== "POST") return json({ error: "Only POST (this server sends no event stream)." }, 405, { allow: "POST" });
    const version = req.headers.get("mcp-protocol-version");
    if (version && !(MCP_VERSIONS as readonly string[]).includes(version)) return json({ error: "Unsupported MCP-Protocol-Version." }, 400);
    const body = await readJson(req);
    if (!body) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "A JSON object (at most 20 KB) is needed." } }, 400);
    const answer = await handleRpc(hub, body, origin, grant.id);
    return answer ? json(answer) : new Response(null, { status: 202 });
  }
  return undefined;
}

/**
 * The signed-in owner's connector routes (the Durable Object checks the session and Origin before calling this).
 *
 * @param path - The request's path.
 * @param body - Its JSON body.
 * @param hub - The hub.
 * @param origin - The hub's origin.
 * @returns The answer, or undefined when the path is not one of them.
 */
export async function connectorOwnerRoute(path: string, body: Record<string, unknown>, hub: Hub, origin: string): Promise<Response | undefined> {
  const { resource } = connectorUrls(origin);
  if (path === "/api/oauth/check") {
    const c = hub.connector.check(authorizeParams(body.params), resource);
    if (!("client" in c)) return json({ error: c.error, ...(c.redirect ? { redirect: c.redirect } : {}) }, 400);
    const to = new URL(c.redirectUri);
    return json({ clientName: c.client.name, redirectHost: to.host, loopback: to.protocol === "http:" });
  }
  if (path === "/api/oauth/decide") {
    const r = await hub.connector.decide(authorizeParams(body.params), resource, body.allow === true);
    return "redirect" in r ? json(r) : json({ error: r.error }, 400);
  }
  const revoke = /^\/api\/connections\/([\w-]{1,64})\/revoke$/.exec(path);
  if (revoke) return hub.connector.revoke(revoke[1]!) ? json({ ok: true }) : json({ error: "No such connection." }, 404);
  return undefined;
}
