import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Who reached KesherAI from outside this computer (the phone, the tunnel,
 * the home network) — shown in Settings → Phone, so the user can see that
 * only their own devices came in. Never addresses' contents: no tokens, no
 * query strings, no bodies.
 *
 * - Every request, one by one (the last 1000): time, address, device, method, path, result, time taken.
 * - Successful visits are counted per address (first and last time, how many).
 * - Refused ones (wrong token, other websites) are kept one by one (the last 200).
 * - Five refused tries from one address in ten minutes raise an alert.
 */

/** One refused request. */
export interface Refused {
  at: string;
  address: string;
  method: string;
  path: string;
  /** 401 wrong token, 403 other website, 429 too many tries. */
  status: number;
  via: "tunnel" | "network";
}

/** One request from outside, for the full request log. */
export interface RequestEntry {
  at: string;
  address: string;
  method: string;
  path: string;
  status: number;
  via: "tunnel" | "network";
  /** The paired device's name, when it came in with its own key. */
  device?: string;
  ms?: number;
}

/** Visits that got in, per address. */
export interface Visitor {
  address: string;
  first: string;
  last: string;
  count: number;
  via: "tunnel" | "network";
  /** The browser or app, shortened. */
  agent?: string;
}

const PATH_KEEP = /^\/(api|v1|mcp|comfy-ui)(\/[\w.-]{0,40}){0,3}/;

/** Keeps the log, in memory and in access-log.json. */
export class AccessLog {
  private refused: Refused[] = [];
  private requests: RequestEntry[] = [];
  private refusedTimes: number[] = [];
  private visitors = new Map<string, Visitor>();
  private timer?: NodeJS.Timeout;
  private loaded: Promise<void>;
  private readonly bursts = new Map<string, number[]>();

  /**
   * @param file - access-log.json.
   * @param alert - Tells the user (computer and phone).
   */
  constructor(
    private readonly file: string,
    private readonly alert: (title: string, body: string) => void = () => undefined,
  ) {
    this.loaded = readFile(file, "utf8")
      .then((t) => {
        const j = JSON.parse(t) as { refused?: Refused[]; visitors?: Visitor[]; requests?: RequestEntry[] };
        this.refused = j.refused ?? [];
        this.requests = j.requests ?? [];
        for (const v of j.visitors ?? []) this.visitors.set(v.address, v);
      })
      .catch(() => undefined);
  }

  /**
   * Notes one request from outside.
   *
   * @param r - What happened.
   * @param r.address - The visitor's address.
   * @param r.method - GET, POST…
   * @param r.path - The path (only its first parts are kept).
   * @param r.status - 200 when it got in, else the refusal.
   * @param r.via - Through the tunnel or the home network.
   * @param r.agent - The User-Agent header.
   */
  note(r: { address: string; method: string; path: string; status: number; via: "tunnel" | "network"; agent?: string; device?: string; ms?: number }): void {
    const at = new Date().toISOString();
    // Every request, one by one (the last 1000): when, who, what, how it went.
    this.requests.unshift({ at, address: r.address, method: r.method, path: PATH_KEEP.exec(r.path)?.[0] ?? "/", status: r.status, via: r.via, ...(r.device ? { device: r.device } : {}), ...(r.ms !== undefined ? { ms: r.ms } : {}) });
    this.requests.length = Math.min(this.requests.length, 1000);
    const agent = r.agent ? r.agent.replace(/[^\w ./;()-]/g, "").slice(0, 80) : undefined;
    if (r.status < 400) {
      const v = this.visitors.get(r.address);
      if (v) Object.assign(v, { last: at, count: v.count + 1, via: r.via, ...(agent ? { agent } : {}) });
      else this.visitors.set(r.address, { address: r.address, first: at, last: at, count: 1, via: r.via, ...(agent ? { agent } : {}) });
      if (this.visitors.size > 100) this.visitors.delete([...this.visitors.values()].sort((a, b) => a.last.localeCompare(b.last))[0]!.address);
    } else {
      this.refused.unshift({ at, address: r.address, method: r.method, path: PATH_KEEP.exec(r.path)?.[0] ?? r.path.slice(0, 1).replace(/[^/]/g, ""), status: r.status, via: r.via });
      this.refused.length = Math.min(this.refused.length, 200);
      const now = Date.now();
      const times = (this.bursts.get(r.address) ?? []).filter((t) => now - t < 10 * 60_000);
      times.push(now);
      this.bursts.set(r.address, times);
      // Many refusals from many addresses (someone spreading guesses): one alert an hour.
      this.refusedTimes = [...this.refusedTimes.filter((x) => now - x < 3_600_000), now];
      if (this.refusedTimes.length === 40) this.alert("Many refused tries on KesherAI", "40 requests were refused in the last hour, from several addresses. Your key is long and cannot be guessed, but if this goes on, turn on \"only paired devices through the internet link\" or make a new token (Settings → Phone).");
      if (times.length === 5) {
        this.alert("Someone tried to get into KesherAI", `${r.address} was refused 5 times in 10 minutes (${r.via === "tunnel" ? "through the internet link" : "on your network"}). If it was not you, turn off remote access or make a new token (Settings → Phone).`);
      }
    }
    this.save();
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.loaded.then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify({ refused: this.refused, visitors: [...this.visitors.values()], requests: this.requests }));
      }).catch(() => undefined);
    }, 5000);
    this.timer.unref?.();
  }

  /** @returns The log for Settings, newest first. */
  async list(): Promise<{ visitors: Visitor[]; refused: Refused[]; requests: RequestEntry[] }> {
    await this.loaded;
    return { visitors: [...this.visitors.values()].sort((a, b) => b.last.localeCompare(a.last)), refused: this.refused, requests: this.requests };
  }

  /** Empties the log. */
  async clear(): Promise<void> {
    await this.loaded;
    this.refused = [];
    this.requests = [];
    this.visitors.clear();
    this.save();
  }
}
