/**
 * OAuth 2.1 for the Claude connector (the hub's remote MCP endpoint, `/mcp`). The hub is its own authorization server
 * and resource server, on one origin, as Claude's custom connectors expect (docs/RESEARCH_LOG.md, "The hub as a Claude
 * custom connector"):
 *
 * - Clients register themselves (RFC 7591, public clients, no secret), but only with Claude's redirect URIs: the hosted
 *   apps' `https://claude.ai/api/mcp/auth_callback`, or Claude Code's loopback `http://localhost|127.0.0.1:<port>/callback`.
 * - Authorization code + PKCE S256 only. The code is approved on the hub page by the signed-in owner (the one Google
 *   account in `ALLOWED_EMAIL`, pinned on first sign-in), so nobody else can connect, whatever client they register.
 * - Access tokens live 1 hour; refresh tokens rotate on each use, live 30 days, and a connection ends after 90 days. A
 *   refresh token used twice ends its connection (theft). "Connected apps" on the hub page revokes one at once.
 * - Only hashes of codes and tokens are kept.
 */
import { randomB64url, sha256Hex } from "../../../packages/shared/src/hub.js";
import type { HubStore, OauthClientRow, OauthGrantRow } from "./store.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Lifetimes and caps of the connector's OAuth. */
export const CONNECTOR = {
  code: MIN,
  access: HOUR,
  refresh: 30 * DAY,
  /** A connection must be approved again after this, even when it is used every day. */
  grantMax: 90 * DAY,
  /** A registered client no connection uses is deleted after this. */
  clientUnused: DAY,
  /** When the client table is full, unused registrations older than this make room (an approval takes less). */
  clientFresh: 10 * MIN,
  maxClients: 50,
  /** Connections at once; approving one more ends the oldest. */
  maxGrants: 10,
  /** The one scope: everything the connector's tools do. */
  scope: "hub",
} as const;

/** The hosted Claude apps' callback (claude.ai, Desktop, mobile, Cowork). */
const CLAUDE_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

/** An OAuth error answer (RFC 6749 §5.2 names). */
export interface OauthError {
  status: 400 | 401 | 403 | 404 | 429;
  error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "invalid_scope" | "invalid_redirect_uri" | "invalid_client_metadata" | "access_denied" | "unsupported_response_type" | "temporarily_unavailable";
  error_description: string;
}

const oerr = (status: OauthError["status"], error: OauthError["error"], error_description: string): OauthError => ({ status, error, error_description });

/** Whether a value is an {@link OauthError}. */
export function isOauthError(x: unknown): x is OauthError {
  return !!x && typeof x === "object" && "error" in x && "status" in x && "error_description" in x;
}

/** A loopback redirect (Claude Code): http, localhost or 127.0.0.1, any port, path `/callback`, nothing else. */
function loopback(uri: string): URL | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || (u.hostname !== "localhost" && u.hostname !== "127.0.0.1")) return undefined;
    if (u.pathname !== "/callback" || u.search || u.hash || u.username || u.password) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

/**
 * Whether a client may register this redirect URI: Claude's hosted callback or Claude Code's loopback only.
 *
 * @param uri - The redirect URI.
 * @returns True when allowed.
 */
export function allowedRedirect(uri: unknown): uri is string {
  return typeof uri === "string" && uri.length <= 200 && (CLAUDE_CALLBACKS.has(uri) || !!loopback(uri));
}

/**
 * Whether an authorization request's redirect URI is one the client registered: exact, except that a loopback one
 * matches on any port (RFC 8252 §7.3; Claude Code picks a new port each session).
 *
 * @param registered - The client's redirect URIs.
 * @param uri - The one in the request.
 * @returns True when it matches.
 */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  const u = loopback(uri);
  return !!u && registered.some((r) => loopback(r)?.hostname === u.hostname);
}

/**
 * The PKCE S256 challenge of a verifier (base64url of its SHA-256, no padding).
 *
 * @param verifier - The code verifier.
 * @returns The challenge.
 */
export async function pkceS256(verifier: string): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let s = "";
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** The query of an authorization request (`GET /oauth/authorize`), as the approval page passes it on. */
export interface AuthorizeParams {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  state?: unknown;
  scope?: unknown;
  resource?: unknown;
}

/** A checked authorization request. */
export interface AuthorizeOk {
  client: OauthClientRow;
  redirectUri: string;
  challenge: string;
  state?: string;
}

/**
 * A redirect URI with OAuth parameters added (the existing query kept).
 *
 * @param uri - The client's redirect URI.
 * @param params - What to add.
 * @returns The URL.
 */
function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** What a token request answers. */
export interface TokenAnswer {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** A connection as "Connected apps" lists it (no token, no hash). */
export interface ConnectionView {
  id: string;
  name: string;
  createdAt: number;
  lastUsed: number;
  /** When it must be approved again at the latest. */
  endsAt: number;
}

/** The connector's authorization server. One lives in the {@link Hub}. */
export class ConnectorAuth {
  /**
   * @param store - The hub's storage.
   * @param now - The clock.
   * @param audit - Writes one metadata-only line to the hub's activity log (action, connection id).
   */
  constructor(
    private readonly store: HubStore,
    private readonly now: () => number,
    private readonly audit: (action: string, grantId?: string) => void,
  ) {}

  /**
   * Dynamic client registration (RFC 7591): a public client with Claude's redirect URIs only.
   *
   * @param body - The registration request (JSON).
   * @returns The client's metadata with its new id, or an error.
   */
  register(body: Record<string, unknown> | undefined): Record<string, unknown> | OauthError {
    if (!body) return oerr(400, "invalid_client_metadata", "A JSON body is needed.");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(allowedRedirect)) return oerr(400, "invalid_redirect_uri", "Only Claude's redirect URIs can be registered with this hub.");
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") return oerr(400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
    if (!grants.every((g) => g === "authorization_code" || g === "refresh_token")) return oerr(400, "invalid_client_metadata", "Only authorization_code and refresh_token.");
    const t = this.now();
    this.store.pruneOauthClients(t - CONNECTOR.clientUnused);
    // Full: registrations no connection uses and older than a few minutes go first, so strangers filling the table
    // (registering is open) lock the owner out for minutes at most, not a day (security scan 169).
    if (this.store.oauthClientCount() >= CONNECTOR.maxClients) this.store.pruneOauthClients(t - CONNECTOR.clientFresh);
    if (this.store.oauthClientCount() >= CONNECTOR.maxClients) return oerr(429, "temporarily_unavailable", "Too many clients registered; try again in a few minutes.");
    const name = (typeof body.client_name === "string" ? [...body.client_name].filter((ch) => ch >= " " && ch !== "\u007f").join("").trim() : "").slice(0, 60) || "Claude";
    const client: OauthClientRow = { id: `cl_${randomB64url(16)}`, name, redirectUris: [...new Set(uris as string[])], createdAt: t };
    this.store.putOauthClient(client);
    this.audit("mcp-client-registered");
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(t / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: CONNECTOR.scope,
    };
  }

  /**
   * Checks an authorization request. An unknown client or a redirect URI it did not register gets an error shown on
   * the hub (never a redirect, RFC 6749 §4.1.2.1); other problems are sent back to the client as `error=`.
   *
   * @param p - The request's parameters.
   * @param resource - This hub's MCP URL (RFC 8707: a `resource` sent must equal it).
   * @returns The checked request, or `{ error, redirect? }`.
   */
  check(p: AuthorizeParams, resource: string): AuthorizeOk | { error: string; redirect?: string } {
    const client = typeof p.client_id === "string" && p.client_id.length <= 64 ? this.store.oauthClient(p.client_id) : undefined;
    if (!client) return { error: "This app is not registered with the hub. Add the connector in Claude again." };
    const redirectUri = typeof p.redirect_uri === "string" ? p.redirect_uri : client.redirectUris.length === 1 ? client.redirectUris[0]! : "";
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return { error: "The return address does not match the app's registration." };
    const state = typeof p.state === "string" ? p.state.slice(0, 500) : undefined;
    const back = (error: string, description: string) => ({ error: description, redirect: withParams(redirectUri, { error, error_description: description, state }) });
    if (p.response_type !== "code") return back("unsupported_response_type", "Only response_type=code.");
    if (p.code_challenge_method !== "S256" || typeof p.code_challenge !== "string" || !PKCE.test(p.code_challenge)) return back("invalid_request", "PKCE with S256 is required.");
    if (p.resource !== undefined && p.resource !== "" && p.resource !== resource) return back("invalid_target", "This hub serves only its own /mcp resource.");
    if (typeof p.scope === "string" && p.scope.split(" ").some((s) => s && s !== CONNECTOR.scope && s !== "offline_access")) return back("invalid_scope", `The only scope is "${CONNECTOR.scope}".`);
    return { client, redirectUri, challenge: p.code_challenge, ...(state !== undefined ? { state } : {}) };
  }

  /**
   * The signed-in owner approves (or refuses) on the hub page: a one-use code goes back to Claude.
   *
   * @param p - The request's parameters (checked again here).
   * @param resource - This hub's MCP URL.
   * @param allow - Approve or refuse.
   * @returns Where to send the browser, or an error to show.
   */
  async decide(p: AuthorizeParams, resource: string, allow: boolean): Promise<{ redirect: string } | { error: string }> {
    const c = this.check(p, resource);
    if (!("client" in c)) return c.redirect ? { redirect: c.redirect } : { error: c.error };
    if (!allow) {
      this.audit("mcp-denied");
      return { redirect: withParams(c.redirectUri, { error: "access_denied", error_description: "The hub's owner refused.", state: c.state }) };
    }
    const code = randomB64url(32);
    const t = this.now();
    this.store.pruneOauthCodes(t);
    this.store.putOauthCode({ hash: await sha256Hex(code), clientId: c.client.id, redirectUri: c.redirectUri, challenge: c.challenge, expiresAt: t + CONNECTOR.code });
    this.audit("mcp-approved");
    return { redirect: withParams(c.redirectUri, { code, state: c.state, iss: new URL(resource).origin }) };
  }

  /**
   * The token endpoint (`POST /oauth/token`, form-encoded): code + PKCE verifier, or a refresh token (rotated).
   *
   * @param form - The request's fields.
   * @returns New tokens, or an error.
   */
  async token(form: URLSearchParams): Promise<TokenAnswer | OauthError> {
    const grantType = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      if (!code || code.length > 100) return oerr(400, "invalid_request", "A code is needed.");
      const row = this.store.takeOauthCode(await sha256Hex(code));
      const t = this.now();
      if (!row || row.expiresAt <= t) return oerr(400, "invalid_grant", "The code is unknown, used or expired.");
      if (row.clientId !== clientId) return oerr(400, "invalid_grant", "The code was issued to another client.");
      const redirect = form.get("redirect_uri");
      if (redirect !== null && redirect !== row.redirectUri) return oerr(400, "invalid_grant", "The redirect URI does not match.");
      if (!PKCE.test(verifier) || (await pkceS256(verifier)) !== row.challenge) return oerr(400, "invalid_grant", "The PKCE verifier does not match.");
      const client = this.store.oauthClient(clientId);
      if (!client) return oerr(400, "invalid_client", "Unknown client.");
      // At most a few connections: approving one more ends the oldest.
      const all = this.store.grants();
      for (const old of all.slice(0, Math.max(0, all.length - CONNECTOR.maxGrants + 1))) {
        this.store.deleteGrant(old.id);
        this.audit("mcp-revoked", old.id);
      }
      const id = `g${randomB64url(9)}`;
      const answer = await this.issue({ id, clientId, name: client.name, createdAt: t, lastUsed: t }, undefined);
      this.audit("mcp-connected", id);
      return answer;
    }
    if (grantType === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      if (!refresh.startsWith("kr_") || refresh.length > 100) return oerr(400, "invalid_grant", "Unknown refresh token.");
      const hash = await sha256Hex(refresh);
      const g = this.store.grantByRefresh(hash);
      const t = this.now();
      if (!g || g.refreshExpiresAt <= t) return oerr(400, "invalid_grant", "Unknown or expired refresh token.");
      if (g.clientId !== clientId) return oerr(400, "invalid_grant", "The token was issued to another client.");
      if (g.refreshHash !== hash) {
        // An old refresh token came back: someone else may hold it. The whole connection ends (OAuth 2.1 §4.3.1).
        this.store.deleteGrant(g.id);
        this.audit("mcp-refresh-reused", g.id);
        return oerr(400, "invalid_grant", "This refresh token was already used; connect again.");
      }
      return this.issue(g, g.refreshHash);
    }
    return oerr(400, "unsupported_grant_type", "Only authorization_code and refresh_token.");
  }

  /** Makes a new access and refresh token for a connection and keeps their hashes. */
  private async issue(g: Pick<OauthGrantRow, "id" | "clientId" | "name" | "createdAt" | "lastUsed">, prev: string | undefined): Promise<TokenAnswer> {
    const t = this.now();
    const access = `kc_${randomB64url(32)}`;
    const refresh = `kr_${randomB64url(32)}`;
    const refreshExpiresAt = Math.min(t + CONNECTOR.refresh, g.createdAt + CONNECTOR.grantMax);
    this.store.putGrant({ ...g, accessHash: await sha256Hex(access), accessExpiresAt: t + CONNECTOR.access, refreshHash: await sha256Hex(refresh), ...(prev ? { prevRefreshHash: prev } : {}), refreshExpiresAt });
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor(CONNECTOR.access / 1000), refresh_token: refresh, scope: CONNECTOR.scope };
  }

  /**
   * The connection an access token belongs to, unless it expired or was revoked (checked on every MCP request).
   *
   * @param bearer - The `Authorization: Bearer` value.
   * @returns The connection, or undefined.
   */
  async verify(bearer: string | undefined): Promise<OauthGrantRow | undefined> {
    if (!bearer || !bearer.startsWith("kc_") || bearer.length > 100) return undefined;
    const g = this.store.grantByAccess(await sha256Hex(bearer));
    const t = this.now();
    if (!g || g.accessExpiresAt <= t) return undefined;
    // Last used is written at most every 5 minutes (rows written are counted on the free plan).
    if (t - g.lastUsed > 5 * MIN) this.store.putGrant({ ...g, lastUsed: t });
    return g;
  }

  /** The connections, oldest first, for "Connected apps". */
  list(): ConnectionView[] {
    return this.store.grants().map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt, lastUsed: g.lastUsed, endsAt: g.createdAt + CONNECTOR.grantMax }));
  }

  /**
   * Ends one connection now: its access and refresh tokens stop at once.
   *
   * @param id - The connection.
   * @returns Whether it existed.
   */
  revoke(id: string): boolean {
    const ok = this.store.deleteGrant(id);
    if (ok) this.audit("mcp-revoked", id);
    return ok;
  }

  /** Ends every connection (the hub's "disconnect everything"). */
  revokeAll(): void {
    this.store.deleteAllGrants();
  }

  /** Cron upkeep: expired codes and connections, unused clients. */
  cleanup(): void {
    const t = this.now();
    this.store.pruneOauthCodes(t);
    this.store.pruneGrants(t);
    this.store.pruneOauthClients(t - CONNECTOR.clientUnused);
  }
}
