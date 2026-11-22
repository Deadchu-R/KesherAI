/**
 * The hub's store with what it reads all the time kept in memory, so storage is read once per wake instead of on every
 * frame and request (Cloudflare's free plan counts every row read and written, and refuses both once a daily quota is
 * used up). The Durable Object is the only writer, so a cache filled once and updated on each write stays exact.
 *
 * Kept in memory:
 * - every device row, loaded in one read the first time one is needed (device tokens, presence and relaying use them).
 *   Until that read works (storage refusing reads), devices seeded from the open sockets' attachments stand in, so
 *   connected devices keep relaying to each other; the first read that works replaces them;
 * - settings, per key on first read (`paused`, `cloudOff`, the IP salt, push subscriptions, ...);
 * - the newest 100 audit lines, the queue's size and the connector's connections (the owner page reads them every
 *   20 seconds).
 *
 * A write goes to storage first and reaches the cache only when storage took it, so a refused write never leaves the
 * cache saying something storage does not (except {@link CachedStore.remember}, for best-effort state).
 */
import { storageCode } from "./storage-guard.js";
import type { AgentEventRow, AuditRow, DeviceRow, HubStore, OauthClientRow, OauthCodeRow, OauthGrantRow, PairingRow, QueuedRow, SessionRow, TicketRow } from "./store.js";

/** Audit lines kept in memory (the owner page shows 100). */
const AUDIT_KEPT = 100;

/** {@link HubStore} with devices, settings, recent audit lines and the queue size cached in memory. */
export class CachedStore implements HubStore {
  /** Every device (in creation order) once loaded; undefined until a load works. */
  private devs?: Map<string, DeviceRow>;
  /** Devices known before a load worked (from socket attachments, or a signed token's claims). */
  private readonly seeds = new Map<string, DeviceRow>();
  /** Why the last load failed (rethrown when nothing in memory can answer). */
  private loadError: unknown;
  private readonly settings = new Map<string, string | undefined>();
  private auditRows?: AuditRow[];
  /** The Claude connector's connections (a few rows; the owner page lists them every 20 seconds, `/mcp` checks them). */
  private grantRows?: Map<string, OauthGrantRow>;
  private queueSize?: number;
  /** Rows that can expire written so far (sessions, pairings, tickets, queue, audit, OAuth): the cleanup skips when
   * this did not change since it last ran. */
  expiringWrites = 0;

  /** @param inner - The real store (in production, the guarded SQLite store). */
  constructor(private readonly inner: HubStore) {}

  /** Whether every device row is in memory (a miss then means the device does not exist). */
  get loaded(): boolean {
    return this.devs !== undefined;
  }

  /**
   * Adds devices known without storage (the open sockets' attachments after a wake). Ignored once loaded.
   *
   * @param rows - Device rows.
   */
  seed(rows: DeviceRow[]): void {
    if (this.devs) return;
    for (const r of rows) this.seeds.set(r.id, structuredClone(r));
  }

  /**
   * Updates a device in memory only (state whose best-effort write storage refused, or a signed token's claims while
   * storage refuses reads). A device that is not known yet is added only before the load (as a seed).
   *
   * @param row - The device row.
   */
  remember(row: DeviceRow): void {
    if (this.devs) {
      if (this.devs.has(row.id)) this.devs.set(row.id, structuredClone(row));
    } else this.seeds.set(row.id, structuredClone(row));
  }

  /** Loads every device once; undefined (and the reason kept) when storage refuses. */
  private ensure(): Map<string, DeviceRow> | undefined {
    if (this.devs) return this.devs;
    try {
      this.devs = new Map(this.inner.devices().map((d) => [d.id, d]));
      this.seeds.clear();
      return this.devs;
    } catch (e) {
      if (!storageCode(e)) throw e;
      this.loadError = e;
      return undefined;
    }
  }

  /** The rows to answer from: all of them, or the seeds; throws the load's error when there is neither. */
  private known(): Map<string, DeviceRow> {
    const m = this.ensure();
    if (m) return m;
    if (this.seeds.size) return this.seeds;
    throw this.loadError;
  }

  /** @inheritdoc */
  getSetting(key: string): string | undefined {
    if (this.settings.has(key)) return this.settings.get(key);
    const v = this.inner.getSetting(key);
    this.settings.set(key, v);
    return v;
  }
  /** @inheritdoc */
  setSetting(key: string, value: string | undefined): void {
    this.inner.setSetting(key, value);
    this.settings.set(key, value);
  }
  /** @inheritdoc */
  devices(): DeviceRow[] {
    return [...this.known().values()].map((d) => structuredClone(d));
  }
  /** @inheritdoc */
  device(id: string): DeviceRow | undefined {
    const m = this.ensure();
    const d = m ? m.get(id) : this.seeds.get(id);
    if (!m && !d) throw this.loadError;
    return d && structuredClone(d);
  }
  /** @inheritdoc */
  deviceByTokenHash(hash: string): DeviceRow | undefined {
    const m = this.ensure();
    const d = [...(m ?? this.seeds).values()].find((x) => x.tokenHash === hash);
    if (!m && !d) throw this.loadError;
    return d && structuredClone(d);
  }
  /** @inheritdoc */
  putDevice(row: DeviceRow): void {
    this.inner.putDevice(row);
    if (this.devs) this.devs.set(row.id, structuredClone(row));
    else this.seeds.set(row.id, structuredClone(row));
  }
  /** @inheritdoc */
  deleteDevice(id: string): void {
    this.inner.deleteDevice(id);
    this.devs?.delete(id);
    this.seeds.delete(id);
  }

  /** @inheritdoc */
  putSession(row: SessionRow): void {
    this.inner.putSession(row);
    this.expiringWrites++;
  }
  /** @inheritdoc */
  session(hash: string): SessionRow | undefined {
    return this.inner.session(hash);
  }
  /** @inheritdoc */
  deleteSession(hash: string): void {
    this.inner.deleteSession(hash);
  }
  /** @inheritdoc */
  deleteAllSessions(): void {
    this.inner.deleteAllSessions();
  }
  /** @inheritdoc */
  pruneSessions(idleBefore: number, createdBefore: number): void {
    this.inner.pruneSessions(idleBefore, createdBefore);
  }

  /** @inheritdoc */
  putPairing(row: PairingRow): void {
    this.inner.putPairing(row);
    this.expiringWrites++;
  }
  /** @inheritdoc */
  pairingByCode(codeHash: string): PairingRow | undefined {
    return this.inner.pairingByCode(codeHash);
  }
  /** @inheritdoc */
  pairingByPoll(pollHash: string): PairingRow | undefined {
    return this.inner.pairingByPoll(pollHash);
  }
  /** @inheritdoc */
  deletePairing(codeHash: string): void {
    this.inner.deletePairing(codeHash);
  }
  /** @inheritdoc */
  pairingCount(now: number): number {
    return this.inner.pairingCount(now);
  }
  /** @inheritdoc */
  prunePairings(now: number): void {
    this.inner.prunePairings(now);
  }

  /** @inheritdoc */
  putTicket(row: TicketRow): void {
    this.inner.putTicket(row);
    this.expiringWrites++;
  }
  /** @inheritdoc */
  takeTicket(hash: string): TicketRow | undefined {
    return this.inner.takeTicket(hash);
  }
  /** @inheritdoc */
  pruneTickets(now: number): void {
    this.inner.pruneTickets(now);
  }

  /** @inheritdoc */
  enqueue(row: QueuedRow): boolean {
    const added = this.inner.enqueue(row);
    this.expiringWrites++;
    if (added && this.queueSize !== undefined) this.queueSize++;
    return added;
  }
  /** @inheritdoc */
  queued(to: string): QueuedRow[] {
    return this.inner.queued(to);
  }
  /** @inheritdoc */
  dequeue(to: string, id: string): boolean {
    const gone = this.inner.dequeue(to, id);
    if (gone && this.queueSize !== undefined) this.queueSize = Math.max(0, this.queueSize - 1);
    return gone;
  }
  /** @inheritdoc */
  dropQueueFor(to: string): void {
    this.inner.dropQueueFor(to);
    this.queueSize = undefined;
  }
  /** @inheritdoc */
  dropQueue(): void {
    this.inner.dropQueue();
    this.queueSize = 0;
  }
  /** @inheritdoc */
  pruneQueue(now: number): number {
    const n = this.inner.pruneQueue(now);
    if (this.queueSize !== undefined) this.queueSize = Math.max(0, this.queueSize - n);
    return n;
  }
  /** @inheritdoc */
  queueCount(): number {
    this.queueSize ??= this.inner.queueCount();
    return this.queueSize;
  }

  /** @inheritdoc */
  audit(row: AuditRow): void {
    this.inner.audit(row);
    this.expiringWrites++;
    if (this.auditRows) this.auditRows = [{ ...row }, ...this.auditRows].slice(0, AUDIT_KEPT);
  }
  /** @inheritdoc */
  auditList(limit: number): AuditRow[] {
    if (limit > AUDIT_KEPT) return this.inner.auditList(limit);
    this.auditRows ??= this.inner.auditList(AUDIT_KEPT);
    return this.auditRows.slice(0, limit).map((a) => ({ ...a }));
  }
  /** @inheritdoc */
  pruneAudit(before: number): void {
    this.inner.pruneAudit(before);
    if (this.auditRows) this.auditRows = this.auditRows.filter((a) => a.ts >= before);
  }

  /** @inheritdoc */
  addAgentEvent(row: Omit<AgentEventRow, "seq">, maxEvents: number): AgentEventRow {
    return this.inner.addAgentEvent(row, maxEvents);
  }
  /** @inheritdoc */
  agentEvents(to: string, since: number, limit: number): AgentEventRow[] {
    return this.inner.agentEvents(to, since, limit);
  }
  /** @inheritdoc */
  dropAgentEventsFor(deviceId: string): void {
    this.inner.dropAgentEventsFor(deviceId);
  }
  /** @inheritdoc */
  dropAgentEvents(): void {
    this.inner.dropAgentEvents();
  }
  /** @inheritdoc */
  capAgentEvents(max: number): void {
    this.inner.capAgentEvents(max);
  }
  /** @inheritdoc */
  pruneAgentEvents(before: number): number {
    return this.inner.pruneAgentEvents(before);
  }
  /** @inheritdoc */
  agentEventCount(since?: number): number {
    return this.inner.agentEventCount(since);
  }

  /** @inheritdoc */
  putOauthClient(row: OauthClientRow): void {
    this.inner.putOauthClient(row);
    this.expiringWrites++;
  }
  /** @inheritdoc */
  oauthClient(id: string): OauthClientRow | undefined {
    return this.inner.oauthClient(id);
  }
  /** @inheritdoc */
  oauthClientCount(): number {
    return this.inner.oauthClientCount();
  }
  /** @inheritdoc */
  pruneOauthClients(before: number): void {
    this.inner.pruneOauthClients(before);
  }
  /** @inheritdoc */
  putOauthCode(row: OauthCodeRow): void {
    this.inner.putOauthCode(row);
    this.expiringWrites++;
  }
  /** @inheritdoc */
  takeOauthCode(hash: string): OauthCodeRow | undefined {
    return this.inner.takeOauthCode(hash);
  }
  /** @inheritdoc */
  pruneOauthCodes(now: number): void {
    this.inner.pruneOauthCodes(now);
  }
  /** Every connection, loaded once. */
  private allGrants(): Map<string, OauthGrantRow> {
    this.grantRows ??= new Map(this.inner.grants().map((g) => [g.id, g]));
    return this.grantRows;
  }
  /** @inheritdoc */
  putGrant(row: OauthGrantRow): void {
    this.inner.putGrant(row);
    this.expiringWrites++;
    this.grantRows?.set(row.id, { ...row });
  }
  /** @inheritdoc */
  grants(): OauthGrantRow[] {
    return [...this.allGrants().values()].map((g) => ({ ...g })).sort((a, b) => a.createdAt - b.createdAt);
  }
  /** @inheritdoc */
  grantByAccess(hash: string): OauthGrantRow | undefined {
    const g = [...this.allGrants().values()].find((x) => x.accessHash === hash);
    return g && { ...g };
  }
  /** @inheritdoc */
  grantByRefresh(hash: string): OauthGrantRow | undefined {
    const g = [...this.allGrants().values()].find((x) => x.refreshHash === hash || x.prevRefreshHash === hash);
    return g && { ...g };
  }
  /** @inheritdoc */
  deleteGrant(id: string): boolean {
    const gone = this.inner.deleteGrant(id);
    this.grantRows?.delete(id);
    return gone;
  }
  /** @inheritdoc */
  deleteAllGrants(): void {
    this.inner.deleteAllGrants();
    this.grantRows = new Map();
  }
  /** @inheritdoc */
  pruneGrants(now: number): void {
    this.inner.pruneGrants(now);
    if (this.grantRows) for (const [k, g] of this.grantRows) if (g.refreshExpiresAt <= now) this.grantRows.delete(k);
  }
}
