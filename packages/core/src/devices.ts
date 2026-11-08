import { createHash, randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { ProviderConfig, ProviderRegistry } from "@kesher/providers";
import type { GoogleDrive } from "./google.js";
import type { McpManager, McpServerConfig } from "./mcp.js";
import { unityRelay } from "./mcp.js";

/**
 * "My devices": computers signed in to the same Google account find each
 * other through a small file in the user's own KesherAI folder in Drive, so
 * a weak laptop can use the strong computer's models (the work runs on that
 * computer's graphics card, the answer comes back), and the connections the
 * user set up (API keys, MCP servers) follow them to every computer.
 *
 * A computer appears to the others only when the user turns on "Let my
 * other devices use this computer". It is reached through its "access from
 * anywhere" address (a Cloudflare tunnel) or its home-network address, with
 * its remote-access token, which only the user's own Google account can
 * read in Drive.
 */

/** One computer in the user's account. */
export interface DeviceEntry {
  id: string;
  name: string;
  platform: string;
  /** Addresses to try, best first. */
  urls: string[];
  token: string;
  gpu?: string;
  version?: string;
  updatedAt: string;
}

/** What the settings page shows about another computer. */
export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  gpu?: string;
  me: boolean;
  online: boolean;
  url?: string;
  models: number;
  lastSeen: string;
  providerId?: string;
}

/** The `devices` section of the config. */
export interface DevicesConfig {
  id?: string;
  /** Let my other devices use this computer. */
  share: boolean;
  /** Sync API keys and MCP servers between my computers. */
  syncSettings: boolean;
  /** Per synced item: hash of what this computer has, and when it last changed. */
  stamps: Record<string, { hash: string; at: number }>;
}

interface SyncedItem<T> {
  config: T;
  at: number;
}
interface SettingsFile {
  providers: Record<string, SyncedItem<ProviderConfig>>;
  mcp: Record<string, SyncedItem<McpServerConfig>>;
}

const UNITY_RELAY = "<unity-relay>";
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");
const isLocalUrl = (u?: string) => !!u && /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(u);

/**
 * Merges this computer's items with the ones in Drive: the newer change wins
 * for each item (deleting an item on one computer does not delete it on the
 * others).
 *
 * @param local - This computer's items by id.
 * @param remote - Drive's items by id.
 * @param stamps - This computer's change times (updated in place).
 * @param prefix - Namespace for the stamps (`p:` providers, `m:` MCP).
 * @param now - The time.
 * @returns What to change here, and what Drive should hold.
 */
export function mergeSynced<T>(local: Record<string, T>, remote: Record<string, SyncedItem<T>>, stamps: DevicesConfig["stamps"], prefix: string, now = Date.now()): { apply: T[]; merged: Record<string, SyncedItem<T>> } {
  const merged: Record<string, SyncedItem<T>> = { ...remote };
  const apply: T[] = [];
  for (const [id, cfg] of Object.entries(local)) {
    const h = hash(cfg);
    const k = prefix + id;
    if (stamps[k]?.hash !== h) stamps[k] = { hash: h, at: now };
  }
  for (const [id, r] of Object.entries(remote)) {
    const k = prefix + id;
    const mine = stamps[k];
    if (!local[id] || (mine && r.at > mine.at && hash(r.config) !== mine.hash)) {
      apply.push(r.config);
      stamps[k] = { hash: hash(r.config), at: r.at };
    }
  }
  for (const [id, cfg] of Object.entries(local)) {
    const k = prefix + id;
    const r = remote[id];
    if (!r || stamps[k]!.at >= r.at) merged[id] = { config: apply.find((x) => x === remote[id]?.config) ?? cfg, at: stamps[k]!.at };
  }
  return { apply, merged };
}

/** Finds and uses the user's other computers, and syncs their connections. */
export class Devices {
  private timer?: NodeJS.Timeout;
  private views: DeviceView[] = [];
  private entries: DeviceEntry[] = [];
  private lastError?: string;
  private lastRun?: string;
  private running?: Promise<void>;

  /**
   * @param d - What it works with.
   */
  constructor(
    private readonly d: {
      config: DevicesConfig;
      remote: { enabled: boolean; token?: string; anywhere: boolean };
      port: () => number;
      providers: () => ProviderConfig[];
      addProvider: (p: ProviderConfig, persist: boolean) => Promise<void>;
      registry: ProviderRegistry;
      google: GoogleDrive;
      mcp: McpManager;
      tunnelUrl: () => string | undefined;
      /** The HTTPS address through Tailscale, when it is on. */
      httpsUrl?: () => Promise<string | undefined>;
      startTunnel: () => Promise<string | undefined>;
      gpu: () => Promise<string | undefined>;
      version: () => Promise<string>;
      save: () => Promise<void>;
    },
  ) {}

  /** This computer's id (made once). */
  private get id(): string {
    this.d.config.id ??= randomUUID();
    return this.d.config.id;
  }

  /** Starts checking every few minutes. */
  start(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.sync().catch(() => undefined), 3 * 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.sync().catch(() => undefined), 15_000).unref?.();
  }

  /** Stops checking. */
  close(): void {
    clearInterval(this.timer);
  }

  /** @returns The settings page's view. */
  status() {
    return { connected: this.d.google.connected, share: this.d.config.share, syncSettings: this.d.config.syncSettings, me: { id: this.id, name: hostname() }, devices: this.views, lastRun: this.lastRun ?? null, error: this.lastError ?? null };
  }

  /**
   * The user's other shared computers, with their addresses and tokens, for
   * the phone app (which already holds this computer's token) to add them.
   */
  peers(): Array<{ name: string; urls: string[]; token: string; gpu?: string; online: boolean }> {
    return this.entries
      .filter((e) => e.id !== this.id)
      .map((e) => {
        const v = this.views.find((x) => x.id === e.id);
        return { name: e.name, urls: v?.url ? [v.url, ...e.urls.filter((u) => u !== v.url)] : e.urls, token: e.token, ...(e.gpu ? { gpu: e.gpu } : {}), online: !!v?.online };
      });
  }

  /**
   * One of the user's other computers, by id, with its best address and token
   * (for the desktop app's "Open" in My devices; never sent to a page).
   */
  peer(id: string): { name: string; url: string; token: string } | undefined {
    const e = this.entries.find((x) => x.id === id && x.id !== this.id);
    if (!e) return undefined;
    const v = this.views.find((x) => x.id === id);
    const url = v?.url ?? e.urls[0];
    return url && e.token ? { name: e.name, url, token: e.token } : undefined;
  }

  /**
   * Turns sharing this computer with the user's other devices on or off.
   * Turning it on also turns on remote access and "access from anywhere".
   */
  async setShare(on: boolean): Promise<void> {
    this.d.config.share = on;
    if (on) {
      this.d.remote.enabled = true;
      this.d.remote.anywhere = true;
      if (!this.d.remote.token) this.d.remote.token = randomUUID().replace(/-/g, "");
    }
    await this.d.save();
    if (on) await this.d.startTunnel().catch(() => undefined);
    await this.sync();
  }

  /** Turns syncing of API keys and MCP servers on or off. */
  async setSyncSettings(on: boolean): Promise<void> {
    this.d.config.syncSettings = on;
    await this.d.save();
    if (on) await this.sync();
  }

  private lanUrls(): string[] {
    if (!this.d.remote.enabled) return [];
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${this.d.port()}`);
    // Tailscale (100.64.0.0/10) first: it works from anywhere, like the tunnel.
    return out.sort((a, b) => Number(/\/\/100\./.test(b)) - Number(/\/\/100\./.test(a)));
  }

  /** Publishes this computer, finds the others, and syncs settings. */
  sync(): Promise<void> {
    this.running ??= this.syncOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async syncOnce(): Promise<void> {
    if (!this.d.google.connected) return;
    try {
      // Every devices.json KesherAI can see (each computer may have its own KesherAI folder); the newest entry of each computer wins.
      const files = this.d.google.readAllJson ? await this.d.google.readAllJson<{ devices?: DeviceEntry[] }>("devices.json") : [(await this.d.google.readJson<{ devices: DeviceEntry[] }>("devices.json")) ?? { devices: [] }];
      const newest = new Map<string, DeviceEntry>();
      for (const f of files) for (const x of f?.devices ?? []) {
        if (!x?.id || typeof x.updatedAt !== "string") continue;
        const had = newest.get(x.id);
        if (!had || Date.parse(x.updatedAt) > Date.parse(had.updatedAt)) newest.set(x.id, x);
      }
      let devices = [...newest.values()].filter((x) => x.id !== this.id && Date.now() - Date.parse(x.updatedAt) < 30 * 86_400_000);
      if (this.d.config.share && this.d.remote.token) {
        const tunnel = this.d.tunnelUrl() ?? (this.d.remote.anywhere ? await this.d.startTunnel().catch(() => undefined) : undefined);
        const https = await this.d.httpsUrl?.().catch(() => undefined);
        const urls = [...(https ? [https] : []), ...(tunnel ? [tunnel] : []), ...this.lanUrls()];
        const gpu = await this.d.gpu().catch(() => undefined);
        devices = [...devices, { id: this.id, name: hostname(), platform: process.platform, urls, token: this.d.remote.token, ...(gpu ? { gpu } : {}), version: await this.d.version(), updatedAt: new Date().toISOString() }];
      }
      await this.d.google.writeJson("devices.json", { devices });
      this.entries = devices;
      this.views = await Promise.all(devices.map((x) => this.useDevice(x)));
      if (this.d.config.syncSettings) await this.syncSettings();
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.lastRun = new Date().toISOString();
    }
  }

  /** Finds a working address for another computer and adds its models here. */
  private async useDevice(x: DeviceEntry): Promise<DeviceView> {
    const view: DeviceView = { id: x.id, name: x.name, platform: x.platform, ...(x.gpu ? { gpu: x.gpu } : {}), me: x.id === this.id, online: false, models: 0, lastSeen: x.updatedAt };
    if (view.me) return { ...view, online: true };
    const providerId = `device-${x.id.slice(0, 8)}`;
    for (const url of x.urls) {
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/v1/models`, { headers: { authorization: `Bearer ${x.token}` }, signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const j = (await res.json()) as { data?: unknown[] };
        await this.d.addProvider({ id: providerId, type: "openai-compatible", name: `${x.name} (your computer)`, location: "server", baseUrl: `${url.replace(/\/$/, "")}/v1`, apiKey: x.token }, false);
        return { ...view, online: true, url, models: j.data?.length ?? 0, providerId };
      } catch {
        /* try the next address */
      }
    }
    this.d.registry.remove(providerId);
    return view;
  }

  /** API keys (cloud connections) and MCP servers: the newer change wins on every computer. */
  private async syncSettings(): Promise<void> {
    const remote = (await this.d.google.readJson<SettingsFile>("settings.json")) ?? { providers: {}, mcp: {} };
    // Only connections that make sense on another computer: cloud ones with a key, not this computer's local engines or devices.
    const localProviders = Object.fromEntries(this.d.providers().filter((p) => !p.id.startsWith("device-") && p.apiKey && !isLocalUrl(p.baseUrl)).map((p) => [p.id, p]));
    // Unity's relay path is per computer: synced as a placeholder, filled in on each computer.
    const localMcp = Object.fromEntries((await this.d.mcp.exportRaw()).map((m) => [m.id, m.preset === "unity" && m.transport === "stdio" ? { ...m, command: UNITY_RELAY } : m]));
    const stamps = this.d.config.stamps;
    const p = mergeSynced(localProviders, remote.providers ?? {}, stamps, "p:");
    const m = mergeSynced(localMcp, remote.mcp ?? {}, stamps, "m:");
    for (const cfg of p.apply) await this.d.addProvider(cfg, true);
    for (const cfg of m.apply) {
      // Unity's relay lives in each computer's own home folder.
      const fixed = cfg.command === UNITY_RELAY ? { ...cfg, command: unityRelay() } : cfg;
      await this.d.mcp.upsert(fixed).catch(() => undefined);
    }
    await this.d.save();
    await this.d.google.writeJson("settings.json", { providers: p.merged, mcp: m.merged });
  }
}
