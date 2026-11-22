/**
 * The few Cloudflare Workers runtime types the hub uses, written out here so the repo needs no new dependency
 * (`@cloudflare/workers-types`). They match the documented runtime API; only what the hub calls is declared.
 */

/** A SQL cursor (`ctx.storage.sql.exec`). */
export interface SqlCursor {
  toArray(): Record<string, unknown>[];
  /** Rows read so far (complete once the rows are read). */
  readonly rowsRead?: number;
  readonly rowsWritten: number;
}

/** The Durable Object's SQLite. */
export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

/** A WebSocket as the Workers runtime has it (with the Hibernation API's attachment). */
export interface CfWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The Durable Object's state. */
export interface DurableObjectState {
  storage: { sql: SqlStorage };
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

/** A stub to call a Durable Object. */
export interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}

/** A Durable Object namespace binding. */
export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

/** The background-work handle a Worker gets. */
export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

/** The Workers runtime's globals the hub uses (read through {@link cfGlobals}, so the code typechecks without them). */
export interface CfGlobals {
  WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
}

/** @returns The runtime's WebSocketPair and WebSocketRequestResponsePair. */
export function cfGlobals(): CfGlobals {
  return globalThis as unknown as CfGlobals;
}

/**
 * A response that hands the client end of a WebSocket to the runtime (status 101).
 *
 * @param client - The client end.
 * @returns The response.
 */
export function upgradeResponse(client: CfWebSocket): Response {
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

/** The Worker's bindings and secrets (secrets are set with `wrangler secret put`, never in wrangler.toml). */
export interface HubEnvBindings {
  HUB: DurableObjectNamespace;
  /** "1" turns the whole hub off (kill switch outside the hub's own page). */
  HUB_DISABLED?: string;
  /** Secret: the one Google account allowed to sign in (only until its `sub` is pinned). */
  ALLOWED_EMAIL?: string;
  /** Secret (public value, kept out of git anyway): the Google OAuth web client id. */
  GOOGLE_CLIENT_ID?: string;
  /** Optional secret: the hub's own ECDH private key (JWK text); without it the hub makes one and keeps it in storage. */
  HUB_PRIVATE_KEY?: string;
  /** A plain random secret (32+ characters) device tokens and socket tickets are signed from, with no storage read. */
  HUB_TOKEN_SECRET?: string;
  /** Secret: the Claude Code scheduled task's trigger id and its per-task API token. */
  CLAUDE_TRIGGER_ID?: string;
  CLAUDE_FIRE_TOKEN?: string;
  /** Web Push: the VAPID public key (plain variable, served to the page), its private "d" (secret) and contact. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}
