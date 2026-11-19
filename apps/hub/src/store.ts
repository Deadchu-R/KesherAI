/**
 * What the hub keeps, behind one small interface: the Durable Object's SQLite in production (`sql-store.ts`) and
 * {@link MemoryStore} in tests. Only metadata, hashes and sealed messages; never a token, a task text or a result
 * (docs/RESEARCH_LOG.md, "Kesher Cloud hub", addendum).
 */
import type { HubAgent, HubDeviceKind, HubOptIn, SealedKind } from "../../../packages/shared/src/hub.js";

/** A paired device. Times are ms since 1970. */
export interface DeviceRow {
  id: string;
  name: string;
  kind: HubDeviceKind;
  /** ECDH public key, raw base64url. */
  publicKey: string;
  /** SHA-256 hex of the device token; the token itself is never stored. */
  tokenHash: string;
  tokenIssuedAt: number;
  createdAt: number;
  lastSeen?: number;
  /** What it last reported. */
  busy: boolean;
  optIn: HubOptIn;
  agents: HubAgent[];
  version?: string;
}

/** A signed-in browser session (hash of the cookie value). */
export interface SessionRow {
  hash: string;
  createdAt: number;
  lastUsed: number;
}

/** A pairing in progress (RFC 8628 style): the code and the poll secret are kept as hashes. */
export interface PairingRow {
  codeHash: string;
  pollHash: string;
  publicKey: string;
  kind: HubDeviceKind;
  name: string;
  expiresAt: number;
  approved: boolean;
}

/** A one-use socket ticket (hash), 60 seconds. */
export interface TicketRow {
  hash: string;
  deviceId: string;
  expiresAt: number;
}

/** A sealed message waiting for its recipient's ack. */
export interface QueuedRow {
  id: string;
  to: string;
  from: string;
  kind: SealedKind;
  expiresAt: number;
  /** The envelope as JSON (sealed). */
  env: string;
  createdAt: number;
}

/** One audit line: metadata only (no task text, no result, no email). */
export interface AuditRow {
  ts: number;
  action: string;
  deviceId?: string;
  /** Salted hash of the IP, shortened. */
  ipHash?: string;
}

/** The hub's storage. Synchronous, like the Durable Object's SQLite API. */
export interface HubStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string | undefined): void;

  devices(): DeviceRow[];
  device(id: string): DeviceRow | undefined;
  deviceByTokenHash(hash: string): DeviceRow | undefined;
  putDevice(row: DeviceRow): void;
  deleteDevice(id: string): void;

  putSession(row: SessionRow): void;
  session(hash: string): SessionRow | undefined;
  deleteSession(hash: string): void;
  deleteAllSessions(): void;
  pruneSessions(idleBefore: number, createdBefore: number): void;

  putPairing(row: PairingRow): void;
  pairingByCode(codeHash: string): PairingRow | undefined;
  pairingByPoll(pollHash: string): PairingRow | undefined;
  deletePairing(codeHash: string): void;
  pairingCount(now: number): number;
  prunePairings(now: number): void;

  putTicket(row: TicketRow): void;
  /** Returns the ticket and deletes it (one use). */
  takeTicket(hash: string): TicketRow | undefined;
  pruneTickets(now: number): void;

  /** Adds a message; false when that id is already queued. */
  enqueue(row: QueuedRow): boolean;
  /** Messages for one device, oldest first. */
  queued(to: string): QueuedRow[];
  /** Deletes one message (on ack); true when it was there. */
  dequeue(to: string, id: string): boolean;
  dropQueueFor(to: string): void;
  dropQueue(): void;
  pruneQueue(now: number): number;
  queueCount(): number;

  audit(row: AuditRow): void;
  auditList(limit: number): AuditRow[];
  pruneAudit(before: number): void;
}

/** The store in memory, for tests (same behaviour as the SQLite one). */
export class MemoryStore implements HubStore {
  private settings = new Map<string, string>();
  private devs = new Map<string, DeviceRow>();
  private sessions = new Map<string, SessionRow>();
  private pairings = new Map<string, PairingRow>();
  private tickets = new Map<string, TicketRow>();
  private queue: QueuedRow[] = [];
  private log: AuditRow[] = [];

  /** @inheritdoc */
  getSetting(key: string): string | undefined {
    return this.settings.get(key);
  }
  /** @inheritdoc */
  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.settings.delete(key);
    else this.settings.set(key, value);
  }
  /** @inheritdoc */
  devices(): DeviceRow[] {
    return [...this.devs.values()].map((d) => structuredClone(d));
  }
  /** @inheritdoc */
  device(id: string): DeviceRow | undefined {
    const d = this.devs.get(id);
    return d && structuredClone(d);
  }
  /** @inheritdoc */
  deviceByTokenHash(hash: string): DeviceRow | undefined {
    return this.devices().find((d) => d.tokenHash === hash);
  }
  /** @inheritdoc */
  putDevice(row: DeviceRow): void {
    this.devs.set(row.id, structuredClone(row));
  }
  /** @inheritdoc */
  deleteDevice(id: string): void {
    this.devs.delete(id);
  }
  /** @inheritdoc */
  putSession(row: SessionRow): void {
    this.sessions.set(row.hash, { ...row });
  }
  /** @inheritdoc */
  session(hash: string): SessionRow | undefined {
    const s = this.sessions.get(hash);
    return s && { ...s };
  }
  /** @inheritdoc */
  deleteSession(hash: string): void {
    this.sessions.delete(hash);
  }
  /** @inheritdoc */
  deleteAllSessions(): void {
    this.sessions.clear();
  }
  /** @inheritdoc */
  pruneSessions(idleBefore: number, createdBefore: number): void {
    for (const [k, s] of this.sessions) if (s.lastUsed < idleBefore || s.createdAt < createdBefore) this.sessions.delete(k);
  }
  /** @inheritdoc */
  putPairing(row: PairingRow): void {
    this.pairings.set(row.codeHash, { ...row });
  }
  /** @inheritdoc */
  pairingByCode(codeHash: string): PairingRow | undefined {
    const p = this.pairings.get(codeHash);
    return p && { ...p };
  }
  /** @inheritdoc */
  pairingByPoll(pollHash: string): PairingRow | undefined {
    const p = [...this.pairings.values()].find((x) => x.pollHash === pollHash);
    return p && { ...p };
  }
  /** @inheritdoc */
  deletePairing(codeHash: string): void {
    this.pairings.delete(codeHash);
  }
  /** @inheritdoc */
  pairingCount(now: number): number {
    return [...this.pairings.values()].filter((p) => p.expiresAt > now).length;
  }
  /** @inheritdoc */
  prunePairings(now: number): void {
    for (const [k, p] of this.pairings) if (p.expiresAt <= now) this.pairings.delete(k);
  }
  /** @inheritdoc */
  putTicket(row: TicketRow): void {
    this.tickets.set(row.hash, { ...row });
  }
  /** @inheritdoc */
  takeTicket(hash: string): TicketRow | undefined {
    const t = this.tickets.get(hash);
    this.tickets.delete(hash);
    return t;
  }
  /** @inheritdoc */
  pruneTickets(now: number): void {
    for (const [k, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(k);
  }
  /** @inheritdoc */
  enqueue(row: QueuedRow): boolean {
    if (this.queue.some((q) => q.id === row.id)) return false;
    this.queue.push({ ...row });
    return true;
  }
  /** @inheritdoc */
  queued(to: string): QueuedRow[] {
    return this.queue.filter((q) => q.to === to).sort((a, b) => a.createdAt - b.createdAt).map((q) => ({ ...q }));
  }
  /** @inheritdoc */
  dequeue(to: string, id: string): boolean {
    const n = this.queue.length;
    this.queue = this.queue.filter((q) => !(q.to === to && q.id === id));
    return this.queue.length < n;
  }
  /** @inheritdoc */
  dropQueueFor(to: string): void {
    this.queue = this.queue.filter((q) => q.to !== to && q.from !== to);
  }
  /** @inheritdoc */
  dropQueue(): void {
    this.queue = [];
  }
  /** @inheritdoc */
  pruneQueue(now: number): number {
    const n = this.queue.length;
    this.queue = this.queue.filter((q) => q.expiresAt > now);
    return n - this.queue.length;
  }
  /** @inheritdoc */
  queueCount(): number {
    return this.queue.length;
  }
  /** @inheritdoc */
  audit(row: AuditRow): void {
    this.log.push({ ...row });
  }
  /** @inheritdoc */
  auditList(limit: number): AuditRow[] {
    return this.log.slice(-limit).reverse();
  }
  /** @inheritdoc */
  pruneAudit(before: number): void {
    this.log = this.log.filter((a) => a.ts >= before);
  }
}
