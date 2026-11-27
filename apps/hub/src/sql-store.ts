/**
 * {@link HubStore} on the Durable Object's SQLite (`ctx.storage.sql`). The schema is created on first use; every query
 * uses bound parameters.
 */
import { cleanAgents, cleanDeviceKind, cleanOptIn, type SealedKind } from "../../../packages/shared/src/hub.js";
import { cleanAwayNote } from "../../../packages/shared/src/device-status.js";
import type { AgentEventRow, AuditRow, DeviceRow, HubStore, OauthClientRow, OauthCodeRow, OauthGrantRow, PairingRow, QueuedRow, SessionRow, TicketRow } from "./store.js";
import type { SqlCursor, SqlStorage } from "./cf.js";
import type { UsageMeter } from "./usage.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, public_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, token_issued_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER,
  state TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, poll_hash TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, expires_at INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL, env TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS queue_by_recipient ON queue (recipient, created_at);
CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, action TEXT NOT NULL, device_id TEXT, ip_hash TEXT);
CREATE INDEX IF NOT EXISTS audit_by_ts ON audit (ts);
CREATE TABLE IF NOT EXISTS agent_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, sender TEXT NOT NULL,
  run TEXT NOT NULL, n INTEGER NOT NULL, env TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_events_by_recipient ON agent_events (recipient, seq);
CREATE INDEX IF NOT EXISTS agent_events_by_run ON agent_events (recipient, sender, run, seq);
CREATE INDEX IF NOT EXISTS agent_events_by_time ON agent_events (created_at);
CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL, access_hash TEXT NOT NULL UNIQUE, access_expires_at INTEGER NOT NULL, refresh_hash TEXT NOT NULL UNIQUE,
  prev_refresh_hash TEXT, refresh_expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_grants_by_prev ON oauth_grants (prev_refresh_hash);
`;

type Row = Record<string, string | number | null>;

const num = (v: unknown): number => Number(v ?? 0);
const opt = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function toDevice(r: Row): DeviceRow {
  let st: Record<string, unknown> = {};
  try {
    st = JSON.parse(String(r.state ?? "{}")) as Record<string, unknown>;
  } catch {
    // A damaged state reads as the defaults.
  }
  const optIn = cleanOptIn(st.optIn);
  return {
    id: String(r.id),
    name: String(r.name),
    kind: cleanDeviceKind(r.kind),
    publicKey: String(r.public_key),
    tokenHash: String(r.token_hash),
    tokenIssuedAt: num(r.token_issued_at),
    createdAt: num(r.created_at),
    ...(r.last_seen != null ? { lastSeen: num(r.last_seen) } : {}),
    busy: st.busy === true,
    optIn,
    agents: cleanAgents(st.agents, optIn.reportLinks),
    ...(typeof st.version === "string" ? { version: st.version } : {}),
    ...(st.away && typeof st.away === "object" && Number.isFinite(Number((st.away as { at?: unknown }).at)) ? { away: { at: Number((st.away as { at: unknown }).at), note: cleanAwayNote((st.away as { note?: unknown }).note) } } : {}),
  };
}

const toPairing = (r: Row): PairingRow => ({ codeHash: String(r.code_hash), pollHash: String(r.poll_hash), publicKey: String(r.public_key), kind: cleanDeviceKind(r.kind), name: String(r.name), expiresAt: num(r.expires_at), approved: num(r.approved) === 1 });
const toAgentEvent = (r: Row): AgentEventRow => ({ seq: num(r.seq), to: String(r.recipient), from: String(r.sender), run: String(r.run), n: num(r.n), env: String(r.env), createdAt: num(r.created_at) });
const toClient = (r: Row): OauthClientRow => {
  let uris: unknown = [];
  try {
    uris = JSON.parse(String(r.redirect_uris ?? "[]"));
  } catch {
    // A damaged list reads as empty (the client cannot be used).
  }
  return { id: String(r.id), name: String(r.name), redirectUris: Array.isArray(uris) ? uris.filter((u): u is string => typeof u === "string") : [], createdAt: num(r.created_at) };
};
const toGrant = (r: Row): OauthGrantRow => ({ id: String(r.id), clientId: String(r.client_id), name: String(r.name), createdAt: num(r.created_at), lastUsed: num(r.last_used), accessHash: String(r.access_hash), accessExpiresAt: num(r.access_expires_at), refreshHash: String(r.refresh_hash), ...(r.prev_refresh_hash != null ? { prevRefreshHash: String(r.prev_refresh_hash) } : {}), refreshExpiresAt: num(r.refresh_expires_at) });
const toQueued = (r: Row): QueuedRow => ({ id: String(r.id), to: String(r.recipient), from: String(r.sender), kind: String(r.kind) as SealedKind, expiresAt: num(r.expires_at), env: String(r.env), createdAt: num(r.created_at) });

/** The hub's storage in the Durable Object's SQLite. */
export class SqlStore implements HubStore {
  /**
   * @param sql - `ctx.storage.sql` of the Durable Object.
   * @param meter - Counts rows read and written per method (shown in `GET /api/diag`).
   */
  constructor(private readonly sql: SqlStorage, private readonly meter?: UsageMeter) {
    // The tables exist after the first start. When Cloudflare's daily write limit is used up even "CREATE TABLE IF
    // NOT EXISTS" can throw; failing here would fail every request (Error 1101), so the object starts and reads work.
    try {
      const cur = this.sql.exec(SCHEMA);
      this.meter?.add("schema", cur.rowsRead ?? 0, cur.rowsWritten ?? 0);
    } catch (e) {
      console.warn(`hub: schema check skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** Runs one statement and counts its rows read and written under `kind` (the store method). */
  private exec(kind: string, q: string, ...args: unknown[]): SqlCursor {
    try {
      const cur = this.sql.exec(q, ...args);
      this.meter?.add(kind, cur.rowsRead ?? 0, cur.rowsWritten ?? 0);
      return cur;
    } catch (e) {
      this.meter?.refused(kind);
      throw e;
    }
  }
  /** Runs a query and returns its rows (counted after they are read). */
  private all(kind: string, q: string, ...args: unknown[]): Row[] {
    let cur: SqlCursor;
    try {
      cur = this.sql.exec(q, ...args);
    } catch (e) {
      this.meter?.refused(kind);
      throw e;
    }
    const rows = cur.toArray() as Row[];
    this.meter?.add(kind, cur.rowsRead ?? 0, cur.rowsWritten ?? 0);
    return rows;
  }
  private first(kind: string, q: string, ...args: unknown[]): Row | undefined {
    return this.all(kind, q, ...args)[0];
  }

  /** @inheritdoc */
  getSetting(key: string): string | undefined {
    return opt(this.first("getSetting", "SELECT v FROM settings WHERE k = ?", key)?.v);
  }
  /** @inheritdoc */
  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.exec("setSetting", "DELETE FROM settings WHERE k = ?", key);
    else this.exec("setSetting", "INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
  /** @inheritdoc */
  devices(): DeviceRow[] {
    return this.all("devices", "SELECT * FROM devices ORDER BY created_at").map(toDevice);
  }
  /** @inheritdoc */
  device(id: string): DeviceRow | undefined {
    const r = this.first("device", "SELECT * FROM devices WHERE id = ?", id);
    return r && toDevice(r);
  }
  /** @inheritdoc */
  deviceByTokenHash(hash: string): DeviceRow | undefined {
    const r = this.first("deviceByTokenHash", "SELECT * FROM devices WHERE token_hash = ?", hash);
    return r && toDevice(r);
  }
  /** @inheritdoc */
  putDevice(d: DeviceRow): void {
    const state = JSON.stringify({ busy: d.busy, optIn: d.optIn, agents: d.agents, ...(d.version ? { version: d.version } : {}), ...(d.away ? { away: d.away } : {}) });
    this.exec("putDevice", 
      `INSERT INTO devices (id, name, kind, public_key, token_hash, token_issued_at, created_at, last_seen, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key, token_hash = excluded.token_hash,
       token_issued_at = excluded.token_issued_at, last_seen = excluded.last_seen, state = excluded.state`,
      d.id, d.name, d.kind, d.publicKey, d.tokenHash, d.tokenIssuedAt, d.createdAt, d.lastSeen ?? null, state,
    );
  }
  /** @inheritdoc */
  deleteDevice(id: string): void {
    this.exec("deleteDevice", "DELETE FROM devices WHERE id = ?", id);
    this.exec("deleteDevice", "DELETE FROM tickets WHERE device_id = ?", id);
  }
  /** @inheritdoc */
  putSession(s: SessionRow): void {
    this.exec("putSession", "INSERT INTO sessions (hash, created_at, last_used) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_used = excluded.last_used", s.hash, s.createdAt, s.lastUsed);
  }
  /** @inheritdoc */
  session(hash: string): SessionRow | undefined {
    const r = this.first("session", "SELECT * FROM sessions WHERE hash = ?", hash);
    return r && { hash: String(r.hash), createdAt: num(r.created_at), lastUsed: num(r.last_used) };
  }
  /** @inheritdoc */
  deleteSession(hash: string): void {
    this.exec("deleteSession", "DELETE FROM sessions WHERE hash = ?", hash);
  }
  /** @inheritdoc */
  deleteAllSessions(): void {
    this.exec("deleteAllSessions", "DELETE FROM sessions");
  }
  /** @inheritdoc */
  pruneSessions(idleBefore: number, createdBefore: number): void {
    this.exec("pruneSessions", "DELETE FROM sessions WHERE last_used < ? OR created_at < ?", idleBefore, createdBefore);
  }
  /** @inheritdoc */
  putPairing(p: PairingRow): void {
    this.exec("putPairing", 
      `INSERT INTO pairings (code_hash, poll_hash, public_key, kind, name, expires_at, approved) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code_hash) DO UPDATE SET name = excluded.name, approved = excluded.approved`,
      p.codeHash, p.pollHash, p.publicKey, p.kind, p.name, p.expiresAt, p.approved ? 1 : 0,
    );
  }
  /** @inheritdoc */
  pairingByCode(codeHash: string): PairingRow | undefined {
    const r = this.first("pairingByCode", "SELECT * FROM pairings WHERE code_hash = ?", codeHash);
    return r && toPairing(r);
  }
  /** @inheritdoc */
  pairingByPoll(pollHash: string): PairingRow | undefined {
    const r = this.first("pairingByPoll", "SELECT * FROM pairings WHERE poll_hash = ?", pollHash);
    return r && toPairing(r);
  }
  /** @inheritdoc */
  deletePairing(codeHash: string): void {
    this.exec("deletePairing", "DELETE FROM pairings WHERE code_hash = ?", codeHash);
  }
  /** @inheritdoc */
  pairingCount(now: number): number {
    return num(this.first("pairingCount", "SELECT COUNT(*) AS n FROM pairings WHERE expires_at > ?", now)?.n);
  }
  /** @inheritdoc */
  prunePairings(now: number): void {
    this.exec("prunePairings", "DELETE FROM pairings WHERE expires_at <= ?", now);
  }
  /** @inheritdoc */
  putTicket(t: TicketRow): void {
    this.exec("putTicket", "INSERT INTO tickets (hash, device_id, expires_at) VALUES (?, ?, ?)", t.hash, t.deviceId, t.expiresAt);
  }
  /** @inheritdoc */
  takeTicket(hash: string): TicketRow | undefined {
    const r = this.first("takeTicket", "SELECT * FROM tickets WHERE hash = ?", hash);
    if (r) this.exec("takeTicket", "DELETE FROM tickets WHERE hash = ?", hash);
    return r && { hash: String(r.hash), deviceId: String(r.device_id), expiresAt: num(r.expires_at) };
  }
  /** @inheritdoc */
  pruneTickets(now: number): void {
    this.exec("pruneTickets", "DELETE FROM tickets WHERE expires_at <= ?", now);
  }
  /** @inheritdoc */
  enqueue(q: QueuedRow): boolean {
    // An id already queued is ignored (0 rows written); no COUNT(*) scans of the whole queue.
    return this.exec("enqueue", "INSERT OR IGNORE INTO queue (id, recipient, sender, kind, expires_at, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", q.id, q.to, q.from, q.kind, q.expiresAt, q.env, q.createdAt).rowsWritten > 0;
  }
  /** @inheritdoc */
  queued(to: string): QueuedRow[] {
    return this.all("queued", "SELECT * FROM queue WHERE recipient = ? ORDER BY created_at", to).map(toQueued);
  }
  /** @inheritdoc */
  dequeue(to: string, id: string): boolean {
    return this.exec("dequeue", "DELETE FROM queue WHERE recipient = ? AND id = ?", to, id).rowsWritten > 0;
  }
  /** @inheritdoc */
  dropQueueFor(to: string): void {
    this.exec("dropQueueFor", "DELETE FROM queue WHERE recipient = ? OR sender = ?", to, to);
  }
  /** @inheritdoc */
  dropQueue(): void {
    this.exec("dropQueue", "DELETE FROM queue");
  }
  /** @inheritdoc */
  pruneQueue(now: number): number {
    return this.exec("pruneQueue", "DELETE FROM queue WHERE expires_at <= ?", now).rowsWritten;
  }
  /** @inheritdoc */
  queueCount(): number {
    return num(this.first("queueCount", "SELECT COUNT(*) AS n FROM queue")?.n);
  }
  /** @inheritdoc */
  audit(a: AuditRow): void {
    this.exec("audit", "INSERT INTO audit (ts, action, device_id, ip_hash) VALUES (?, ?, ?, ?)", a.ts, a.action, a.deviceId ?? null, a.ipHash ?? null);
  }
  /** @inheritdoc */
  auditBatch(rows: AuditRow[]): void {
    if (!rows.length) return;
    if (rows.length === 1) {
      this.audit(rows[0]!);
      return;
    }
    const values = rows.map(() => "(?, ?, ?, ?)").join(", ");
    const args: (number | string | null)[] = [];
    for (const r of rows) {
      args.push(r.ts, r.action, r.deviceId ?? null, r.ipHash ?? null);
    }
    this.exec("auditBatch", `INSERT INTO audit (ts, action, device_id, ip_hash) VALUES ${values}`, ...args);
  }
  /** @inheritdoc */
  auditList(limit: number): AuditRow[] {
    return this.all("auditList", "SELECT * FROM audit ORDER BY ts DESC LIMIT ?", limit).map((r) => ({ ts: num(r.ts), action: String(r.action), ...(opt(r.device_id) ? { deviceId: String(r.device_id) } : {}), ...(opt(r.ip_hash) ? { ipHash: String(r.ip_hash) } : {}) }));
  }
  /** @inheritdoc */
  pruneAudit(before: number): void {
    this.exec("pruneAudit", "DELETE FROM audit WHERE ts < ?", before);
  }
  /** @inheritdoc */
  addAgentEvent(row: Omit<AgentEventRow, "seq">, maxEvents: number): AgentEventRow {
    if (row.n === 0) this.exec("addAgentEvent", "DELETE FROM agent_events WHERE recipient = ? AND sender = ? AND run = ? AND n = 0", row.to, row.from, row.run);
    const seq = num(this.first("addAgentEvent", "INSERT INTO agent_events (recipient, sender, run, n, env, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq", row.to, row.from, row.run, row.n, row.env, row.createdAt)?.seq);
    if (row.n > 0) {
      // The oldest batches of the run go while it holds more than maxEvents events (the newest is always kept).
      const rows = this.all("addAgentEvent", "SELECT seq, n FROM agent_events WHERE recipient = ? AND sender = ? AND run = ? AND n > 0 ORDER BY seq DESC", row.to, row.from, row.run);
      let total = 0;
      const old = rows.filter((r) => (total += num(r.n)) > maxEvents && num(r.seq) !== seq).map((r) => num(r.seq));
      if (old.length) this.exec("addAgentEvent", `DELETE FROM agent_events WHERE seq IN (${old.map(() => "?").join(",")})`, ...old);
    }
    return { ...row, seq };
  }
  /** @inheritdoc */
  agentEvents(to: string, since: number, limit: number): AgentEventRow[] {
    return this.all("agentEvents", "SELECT * FROM agent_events WHERE recipient = ? AND seq > ? ORDER BY seq LIMIT ?", to, since, limit).map(toAgentEvent);
  }
  /** @inheritdoc */
  dropAgentEventsFor(deviceId: string): void {
    this.exec("dropAgentEventsFor", "DELETE FROM agent_events WHERE recipient = ? OR sender = ?", deviceId, deviceId);
  }
  /** @inheritdoc */
  dropAgentEvents(): void {
    this.exec("dropAgentEvents", "DELETE FROM agent_events");
  }
  /** @inheritdoc */
  capAgentEvents(max: number): void {
    this.exec("capAgentEvents", "DELETE FROM agent_events WHERE seq <= (SELECT seq FROM agent_events ORDER BY seq DESC LIMIT 1 OFFSET ?)", Math.max(0, max));
  }
  /** @inheritdoc */
  pruneAgentEvents(before: number): number {
    return this.exec("pruneAgentEvents", "DELETE FROM agent_events WHERE created_at < ?", before).rowsWritten;
  }
  /** @inheritdoc */
  agentEventCount(since?: number): number {
    return num((since === undefined ? this.first("agentEventCount", "SELECT COUNT(*) AS n FROM agent_events") : this.first("agentEventCount", "SELECT COUNT(*) AS n FROM agent_events WHERE created_at >= ?", since))?.n);
  }
  /** @inheritdoc */
  putOauthClient(row: OauthClientRow): void {
    this.exec("putOauthClient", "INSERT OR REPLACE INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)", row.id, row.name, JSON.stringify(row.redirectUris), row.createdAt);
  }
  /** @inheritdoc */
  oauthClient(id: string): OauthClientRow | undefined {
    const r = this.first("oauthClient", "SELECT * FROM oauth_clients WHERE id = ?", id);
    return r && toClient(r);
  }
  /** @inheritdoc */
  oauthClientCount(): number {
    return num(this.first("oauthClientCount", "SELECT COUNT(*) AS n FROM oauth_clients")?.n);
  }
  /** @inheritdoc */
  pruneOauthClients(before: number): void {
    this.exec("pruneOauthClients", "DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)", before);
  }
  /** @inheritdoc */
  putOauthCode(row: OauthCodeRow): void {
    this.exec("putOauthCode", "INSERT OR REPLACE INTO oauth_codes (hash, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?)", row.hash, row.clientId, row.redirectUri, row.challenge, row.expiresAt);
  }
  /** @inheritdoc */
  takeOauthCode(hash: string): OauthCodeRow | undefined {
    const r = this.first("takeOauthCode", "SELECT * FROM oauth_codes WHERE hash = ?", hash);
    if (!r) return undefined;
    this.exec("takeOauthCode", "DELETE FROM oauth_codes WHERE hash = ?", hash);
    return { hash: String(r.hash), clientId: String(r.client_id), redirectUri: String(r.redirect_uri), challenge: String(r.challenge), expiresAt: num(r.expires_at) };
  }
  /** @inheritdoc */
  pruneOauthCodes(now: number): void {
    this.exec("pruneOauthCodes", "DELETE FROM oauth_codes WHERE expires_at <= ?", now);
  }
  /** @inheritdoc */
  putGrant(g: OauthGrantRow): void {
    this.exec("putGrant", 
      "INSERT OR REPLACE INTO oauth_grants (id, client_id, name, created_at, last_used, access_hash, access_expires_at, refresh_hash, prev_refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      g.id, g.clientId, g.name, g.createdAt, g.lastUsed, g.accessHash, g.accessExpiresAt, g.refreshHash, g.prevRefreshHash ?? null, g.refreshExpiresAt,
    );
  }
  /** @inheritdoc */
  grants(): OauthGrantRow[] {
    return this.all("grants", "SELECT * FROM oauth_grants ORDER BY created_at").map(toGrant);
  }
  /** @inheritdoc */
  grantByAccess(hash: string): OauthGrantRow | undefined {
    const r = this.first("grantByAccess", "SELECT * FROM oauth_grants WHERE access_hash = ?", hash);
    return r && toGrant(r);
  }
  /** @inheritdoc */
  grantByRefresh(hash: string): OauthGrantRow | undefined {
    const r = this.first("grantByRefresh", "SELECT * FROM oauth_grants WHERE refresh_hash = ? OR prev_refresh_hash = ?", hash, hash);
    return r && toGrant(r);
  }
  /** @inheritdoc */
  deleteGrant(id: string): boolean {
    return this.exec("deleteGrant", "DELETE FROM oauth_grants WHERE id = ?", id).rowsWritten > 0;
  }
  /** @inheritdoc */
  deleteAllGrants(): void {
    this.exec("deleteAllGrants", "DELETE FROM oauth_grants");
  }
  /** @inheritdoc */
  pruneGrants(now: number): void {
    this.exec("pruneGrants", "DELETE FROM oauth_grants WHERE refresh_expires_at <= ?", now);
  }
}
