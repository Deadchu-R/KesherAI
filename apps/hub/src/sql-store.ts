/**
 * {@link HubStore} on the Durable Object's SQLite (`ctx.storage.sql`). The schema is created on first use; every query
 * uses bound parameters.
 */
import { cleanAgents, cleanOptIn, type HubDeviceKind, type SealedKind } from "../../../packages/shared/src/hub.js";
import type { AgentEventRow, AuditRow, DeviceRow, HubStore, PairingRow, QueuedRow, SessionRow, TicketRow } from "./store.js";
import type { SqlStorage } from "./cf.js";

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
    kind: r.kind === "phone" ? "phone" : ("pc" as HubDeviceKind),
    publicKey: String(r.public_key),
    tokenHash: String(r.token_hash),
    tokenIssuedAt: num(r.token_issued_at),
    createdAt: num(r.created_at),
    ...(r.last_seen != null ? { lastSeen: num(r.last_seen) } : {}),
    busy: st.busy === true,
    optIn,
    agents: cleanAgents(st.agents, optIn.reportLinks),
    ...(typeof st.version === "string" ? { version: st.version } : {}),
  };
}

const toPairing = (r: Row): PairingRow => ({ codeHash: String(r.code_hash), pollHash: String(r.poll_hash), publicKey: String(r.public_key), kind: r.kind === "phone" ? "phone" : "pc", name: String(r.name), expiresAt: num(r.expires_at), approved: num(r.approved) === 1 });
const toAgentEvent = (r: Row): AgentEventRow => ({ seq: num(r.seq), to: String(r.recipient), from: String(r.sender), run: String(r.run), n: num(r.n), env: String(r.env), createdAt: num(r.created_at) });
const toQueued = (r: Row): QueuedRow => ({ id: String(r.id), to: String(r.recipient), from: String(r.sender), kind: String(r.kind) as SealedKind, expiresAt: num(r.expires_at), env: String(r.env), createdAt: num(r.created_at) });

/** The hub's storage in the Durable Object's SQLite. */
export class SqlStore implements HubStore {
  /** @param sql - `ctx.storage.sql` of the Durable Object. */
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(SCHEMA);
  }

  private all(q: string, ...args: unknown[]): Row[] {
    return this.sql.exec(q, ...args).toArray() as Row[];
  }
  private first(q: string, ...args: unknown[]): Row | undefined {
    return this.all(q, ...args)[0];
  }

  /** @inheritdoc */
  getSetting(key: string): string | undefined {
    return opt(this.first("SELECT v FROM settings WHERE k = ?", key)?.v);
  }
  /** @inheritdoc */
  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.sql.exec("DELETE FROM settings WHERE k = ?", key);
    else this.sql.exec("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
  /** @inheritdoc */
  devices(): DeviceRow[] {
    return this.all("SELECT * FROM devices ORDER BY created_at").map(toDevice);
  }
  /** @inheritdoc */
  device(id: string): DeviceRow | undefined {
    const r = this.first("SELECT * FROM devices WHERE id = ?", id);
    return r && toDevice(r);
  }
  /** @inheritdoc */
  deviceByTokenHash(hash: string): DeviceRow | undefined {
    const r = this.first("SELECT * FROM devices WHERE token_hash = ?", hash);
    return r && toDevice(r);
  }
  /** @inheritdoc */
  putDevice(d: DeviceRow): void {
    const state = JSON.stringify({ busy: d.busy, optIn: d.optIn, agents: d.agents, ...(d.version ? { version: d.version } : {}) });
    this.sql.exec(
      `INSERT INTO devices (id, name, kind, public_key, token_hash, token_issued_at, created_at, last_seen, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key, token_hash = excluded.token_hash,
       token_issued_at = excluded.token_issued_at, last_seen = excluded.last_seen, state = excluded.state`,
      d.id, d.name, d.kind, d.publicKey, d.tokenHash, d.tokenIssuedAt, d.createdAt, d.lastSeen ?? null, state,
    );
  }
  /** @inheritdoc */
  deleteDevice(id: string): void {
    this.sql.exec("DELETE FROM devices WHERE id = ?", id);
    this.sql.exec("DELETE FROM tickets WHERE device_id = ?", id);
  }
  /** @inheritdoc */
  putSession(s: SessionRow): void {
    this.sql.exec("INSERT INTO sessions (hash, created_at, last_used) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_used = excluded.last_used", s.hash, s.createdAt, s.lastUsed);
  }
  /** @inheritdoc */
  session(hash: string): SessionRow | undefined {
    const r = this.first("SELECT * FROM sessions WHERE hash = ?", hash);
    return r && { hash: String(r.hash), createdAt: num(r.created_at), lastUsed: num(r.last_used) };
  }
  /** @inheritdoc */
  deleteSession(hash: string): void {
    this.sql.exec("DELETE FROM sessions WHERE hash = ?", hash);
  }
  /** @inheritdoc */
  deleteAllSessions(): void {
    this.sql.exec("DELETE FROM sessions");
  }
  /** @inheritdoc */
  pruneSessions(idleBefore: number, createdBefore: number): void {
    this.sql.exec("DELETE FROM sessions WHERE last_used < ? OR created_at < ?", idleBefore, createdBefore);
  }
  /** @inheritdoc */
  putPairing(p: PairingRow): void {
    this.sql.exec(
      `INSERT INTO pairings (code_hash, poll_hash, public_key, kind, name, expires_at, approved) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code_hash) DO UPDATE SET name = excluded.name, approved = excluded.approved`,
      p.codeHash, p.pollHash, p.publicKey, p.kind, p.name, p.expiresAt, p.approved ? 1 : 0,
    );
  }
  /** @inheritdoc */
  pairingByCode(codeHash: string): PairingRow | undefined {
    const r = this.first("SELECT * FROM pairings WHERE code_hash = ?", codeHash);
    return r && toPairing(r);
  }
  /** @inheritdoc */
  pairingByPoll(pollHash: string): PairingRow | undefined {
    const r = this.first("SELECT * FROM pairings WHERE poll_hash = ?", pollHash);
    return r && toPairing(r);
  }
  /** @inheritdoc */
  deletePairing(codeHash: string): void {
    this.sql.exec("DELETE FROM pairings WHERE code_hash = ?", codeHash);
  }
  /** @inheritdoc */
  pairingCount(now: number): number {
    return num(this.first("SELECT COUNT(*) AS n FROM pairings WHERE expires_at > ?", now)?.n);
  }
  /** @inheritdoc */
  prunePairings(now: number): void {
    this.sql.exec("DELETE FROM pairings WHERE expires_at <= ?", now);
  }
  /** @inheritdoc */
  putTicket(t: TicketRow): void {
    this.sql.exec("INSERT INTO tickets (hash, device_id, expires_at) VALUES (?, ?, ?)", t.hash, t.deviceId, t.expiresAt);
  }
  /** @inheritdoc */
  takeTicket(hash: string): TicketRow | undefined {
    const r = this.first("SELECT * FROM tickets WHERE hash = ?", hash);
    this.sql.exec("DELETE FROM tickets WHERE hash = ?", hash);
    return r && { hash: String(r.hash), deviceId: String(r.device_id), expiresAt: num(r.expires_at) };
  }
  /** @inheritdoc */
  pruneTickets(now: number): void {
    this.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
  }
  /** @inheritdoc */
  enqueue(q: QueuedRow): boolean {
    const before = this.queueCount();
    this.sql.exec("INSERT OR IGNORE INTO queue (id, recipient, sender, kind, expires_at, env, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", q.id, q.to, q.from, q.kind, q.expiresAt, q.env, q.createdAt);
    return this.queueCount() > before;
  }
  /** @inheritdoc */
  queued(to: string): QueuedRow[] {
    return this.all("SELECT * FROM queue WHERE recipient = ? ORDER BY created_at", to).map(toQueued);
  }
  /** @inheritdoc */
  dequeue(to: string, id: string): boolean {
    return this.sql.exec("DELETE FROM queue WHERE recipient = ? AND id = ?", to, id).rowsWritten > 0;
  }
  /** @inheritdoc */
  dropQueueFor(to: string): void {
    this.sql.exec("DELETE FROM queue WHERE recipient = ? OR sender = ?", to, to);
  }
  /** @inheritdoc */
  dropQueue(): void {
    this.sql.exec("DELETE FROM queue");
  }
  /** @inheritdoc */
  pruneQueue(now: number): number {
    return this.sql.exec("DELETE FROM queue WHERE expires_at <= ?", now).rowsWritten;
  }
  /** @inheritdoc */
  queueCount(): number {
    return num(this.first("SELECT COUNT(*) AS n FROM queue")?.n);
  }
  /** @inheritdoc */
  audit(a: AuditRow): void {
    this.sql.exec("INSERT INTO audit (ts, action, device_id, ip_hash) VALUES (?, ?, ?, ?)", a.ts, a.action, a.deviceId ?? null, a.ipHash ?? null);
  }
  /** @inheritdoc */
  auditList(limit: number): AuditRow[] {
    return this.all("SELECT * FROM audit ORDER BY ts DESC LIMIT ?", limit).map((r) => ({ ts: num(r.ts), action: String(r.action), ...(opt(r.device_id) ? { deviceId: String(r.device_id) } : {}), ...(opt(r.ip_hash) ? { ipHash: String(r.ip_hash) } : {}) }));
  }
  /** @inheritdoc */
  pruneAudit(before: number): void {
    this.sql.exec("DELETE FROM audit WHERE ts < ?", before);
  }
  /** @inheritdoc */
  addAgentEvent(row: Omit<AgentEventRow, "seq">, maxEvents: number): AgentEventRow {
    if (row.n === 0) this.sql.exec("DELETE FROM agent_events WHERE recipient = ? AND sender = ? AND run = ? AND n = 0", row.to, row.from, row.run);
    const seq = num(this.first("INSERT INTO agent_events (recipient, sender, run, n, env, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq", row.to, row.from, row.run, row.n, row.env, row.createdAt)?.seq);
    if (row.n > 0) {
      // The oldest batches of the run go while it holds more than maxEvents events (the newest is always kept).
      const rows = this.all("SELECT seq, n FROM agent_events WHERE recipient = ? AND sender = ? AND run = ? AND n > 0 ORDER BY seq DESC", row.to, row.from, row.run);
      let total = 0;
      const old = rows.filter((r) => (total += num(r.n)) > maxEvents && num(r.seq) !== seq).map((r) => num(r.seq));
      if (old.length) this.sql.exec(`DELETE FROM agent_events WHERE seq IN (${old.map(() => "?").join(",")})`, ...old);
    }
    return { ...row, seq };
  }
  /** @inheritdoc */
  agentEvents(to: string, since: number, limit: number): AgentEventRow[] {
    return this.all("SELECT * FROM agent_events WHERE recipient = ? AND seq > ? ORDER BY seq LIMIT ?", to, since, limit).map(toAgentEvent);
  }
  /** @inheritdoc */
  dropAgentEventsFor(deviceId: string): void {
    this.sql.exec("DELETE FROM agent_events WHERE recipient = ? OR sender = ?", deviceId, deviceId);
  }
  /** @inheritdoc */
  dropAgentEvents(): void {
    this.sql.exec("DELETE FROM agent_events");
  }
  /** @inheritdoc */
  pruneAgentEvents(before: number): number {
    return this.sql.exec("DELETE FROM agent_events WHERE created_at < ?", before).rowsWritten;
  }
  /** @inheritdoc */
  agentEventCount(since?: number): number {
    return num((since === undefined ? this.first("SELECT COUNT(*) AS n FROM agent_events") : this.first("SELECT COUNT(*) AS n FROM agent_events WHERE created_at >= ?", since))?.n);
  }
}
