/**
 * "Free cloud helpers": a pool of free cloud model providers (Groq, OpenRouter :free, Cloudflare Workers AI, Mistral's
 * free plan, Zhipu GLM-4-Flash) that KesherAI moves between by itself, inside each one's free limits.
 *
 * - {@link RateLimiter}: per-provider minute and day counters; a 429 (with `Retry-After` or the provider's own reset
 *   header) blocks the provider until it may be tried again.
 * - {@link CircuitBreaker}: after repeated errors a provider is skipped for a while; a rejected key pauses it longer.
 * - {@link FreeCloudPool}: picks the first provider in the user's order that is set up, allowed and not limited, and
 *   falls through to the next on a limit or an error. A model that costs money is never called.
 * - {@link FreeOnlyProvider}: the connection itself (type `free-cloud`): an OpenAI-style provider that lists and calls
 *   only free models.
 * - {@link FreeCloudPoolProvider}: the model "Free cloud (automatic)" that a chat can pick.
 *
 * Keys are the connections' `apiKey` (sealed in the config like all keys). They are never put in a message: every error
 * text passes {@link redact} first.
 */
import { makeModelId, type ChatStreamEvent, type ModelInfo } from "@kesher/shared";
import {
  OpenAICompatibleProvider,
  fetchOk,
  type HttpError,
  type Provider,
  type ProviderChatRequest,
  type ProviderConfig,
  type ProviderFactory,
  type ProviderRegistry,
  type ProviderToolChatRequest,
  type ProviderToolChatResult,
} from "@kesher/providers";
import type { ModelTurn } from "@kesher/agent";
import { FREE_PROVIDERS, freeProvider, modelListUrl, paidModelReason, parseModelList, type FreeProviderInfo, type ListedModel } from "./free-cloud-catalog.js";
import { guardMessages } from "./privacy-guard.js";

/** What the pool is used for. `pick`: the user chose "Free cloud" for a chat. `chat`: the local model is busy or off. */
export type FreeUse = "pick" | "chat" | "background";

/** The settings of the pool (config.freeCloud). */
export interface FreeCloudSettings {
  /** Provider ids, the order they are tried in. */
  order: string[];
  /** Providers switched off by the user. */
  disabled: string[];
  /** Use the pool when the local model for a chat is busy or not loaded. Off by default. */
  chatFallback: boolean;
  /** Use the pool for background and helper work (research tasks). On by default. */
  backgroundFallback: boolean;
  /** The model per provider (empty: the provider's default). */
  models: Record<string, string>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Removes secrets from a text that may reach a screen, a log or a task note: the key itself and anything shaped like
 * a bearer token or an `sk-` / `gsk_` key.
 *
 * @param text - The text (an error message).
 * @param keys - Keys to remove whatever they look like.
 * @returns The text with `[key]` where a secret was.
 */
export function redact(text: string, ...keys: Array<string | undefined>): string {
  let out = text;
  for (const k of keys) if (k && k.length >= 6) out = out.split(k).join("[key]");
  return out.replace(/\b(?:sk|gsk|csk|hf|pk)[-_][A-Za-z0-9_-]{12,}/g, "[key]").replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [key]");
}

/**
 * Reads a wait time written the way providers write it: `7.66s`, `2m59.56s`, `1h2m`, `120ms`, or plain seconds.
 *
 * @param text - The value.
 * @returns Milliseconds, or undefined when it is not a time.
 */
export function parseDuration(text: string): number | undefined {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0;
  let any = false;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    any = true;
    const n = Number(m[1]);
    ms += m[2] === "h" ? n * HOUR : m[2] === "m" ? n * MINUTE : m[2] === "s" ? n * 1000 : n;
  }
  return any ? Math.round(ms) : undefined;
}

/** The next 00:00 UTC after `now` (free daily allowances reset there). */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * How long a 429 says to wait: `Retry-After` (seconds or a date), then the provider's reset headers
 * (`x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`, `x-ratelimit-reset` as an epoch in ms or seconds,
 * `ratelimit-reset`), then "try again in 7.66s" in the message. A per-day limit waits for the next 00:00 UTC.
 *
 * @param headers - The answer's rate-limit headers (lower-case).
 * @param message - The error text.
 * @param now - Now (ms).
 * @returns The wait in ms, or undefined when nothing says.
 */
export function retryAfterMs(headers: Record<string, string>, message: string, now: number): number | undefined {
  let wait: number | undefined;
  const ra = headers["retry-after"];
  if (ra) {
    const secs = parseDuration(ra);
    const date = secs === undefined ? Date.parse(ra) : NaN;
    wait = secs ?? (Number.isNaN(date) ? undefined : Math.max(0, date - now));
  }
  if (wait === undefined) {
    const found = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "ratelimit-reset"].flatMap((k) => (headers[k] !== undefined ? [parseDuration(headers[k])] : [])).filter((v): v is number => v !== undefined);
    if (found.length) wait = Math.max(...found);
  }
  if (wait === undefined && headers["x-ratelimit-reset"]) {
    const n = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(n)) wait = Math.max(0, (n > 1e12 ? n : n * 1000) - now);
  }
  if (wait === undefined) {
    const m = /try again in\s+([0-9hms.]+)/i.exec(message)?.[1];
    if (m) wait = parseDuration(m);
  }
  if (/per day|daily|\bRPD\b|free-models-per-day|requests per day/i.test(message)) wait = Math.max(wait ?? 0, nextUtcMidnight(now) - now);
  return wait;
}

/** Why a provider cannot take a request now. */
export type Blocked = { ok: true } | { ok: false; until: number; why: "minute" | "day" | "backoff" };

/**
 * Counts a provider's requests against its free limits and remembers when a 429 said to wait.
 * Without a header, repeated 429s wait 30 s, 1 min, 2 min, 4 min... up to 15 min.
 */
export class RateLimiter {
  private stamps: number[] = [];
  private day = "";
  private dayUsed = 0;
  private blockedUntil = 0;
  private strikes = 0;

  /**
   * @param limits - Requests per minute and per day (0 = not counted).
   */
  constructor(private readonly limits: { rpm: number; rpd: number }) {}

  /**
   * Whether a request may go now.
   *
   * @param now - Now (ms).
   * @returns Ok, or until when and why not.
   */
  check(now: number): Blocked {
    this.roll(now);
    if (this.blockedUntil > now) return { ok: false, until: this.blockedUntil, why: "backoff" };
    if (this.limits.rpd && this.dayUsed >= this.limits.rpd) return { ok: false, until: nextUtcMidnight(now), why: "day" };
    if (this.limits.rpm && this.stamps.length >= this.limits.rpm) return { ok: false, until: this.stamps[0]! + MINUTE, why: "minute" };
    return { ok: true };
  }

  /** Counts a request that was sent. */
  note(now: number): void {
    this.roll(now);
    this.stamps.push(now);
    this.dayUsed++;
  }

  /** A request worked: the backoff starts over. */
  success(): void {
    this.strikes = 0;
  }

  /**
   * A 429 came back: wait as the answer says, or longer each time when it does not.
   *
   * @param headers - The answer's rate-limit headers.
   * @param message - The error text.
   * @param now - Now (ms).
   * @returns Until when the provider is blocked.
   */
  rejected(headers: Record<string, string>, message: string, now: number): number {
    const said = retryAfterMs(headers, message, now);
    const wait = said !== undefined ? Math.max(1000, said) : Math.min(15 * MINUTE, 30_000 * 2 ** this.strikes);
    this.strikes++;
    this.blockedUntil = Math.max(this.blockedUntil, now + wait);
    return this.blockedUntil;
  }

  /** The counters, for the card. */
  usage(now: number): { minute: number; day: number; blockedUntil: number } {
    this.roll(now);
    return { minute: this.stamps.length, day: this.dayUsed, blockedUntil: this.blockedUntil > now ? this.blockedUntil : 0 };
  }

  /** What to keep across a restart. */
  snapshot(): { day: string; dayUsed: number; blockedUntil: number } {
    return { day: this.day, dayUsed: this.dayUsed, blockedUntil: this.blockedUntil };
  }

  /** Reads {@link snapshot}. */
  restore(s: { day?: string; dayUsed?: number; blockedUntil?: number } | undefined, now: number): void {
    if (!s) return;
    this.day = typeof s.day === "string" ? s.day : "";
    this.dayUsed = Number.isFinite(s.dayUsed) ? Math.max(0, Number(s.dayUsed)) : 0;
    this.blockedUntil = Number.isFinite(s.blockedUntil) ? Number(s.blockedUntil) : 0;
    this.roll(now);
  }

  private roll(now: number): void {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayUsed = 0;
    }
    while (this.stamps.length && this.stamps[0]! <= now - MINUTE) this.stamps.shift();
  }
}

/**
 * Skips a provider after repeated errors. Closed: requests go. After `threshold` errors in a row it opens for
 * `openMs`; then one trial goes through (half-open), and one more error opens it again. A rejected key opens it for
 * an hour at once (trying a wrong key again and again helps nobody).
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  /**
   * @param threshold - Errors in a row that open it.
   * @param openMs - How long it stays open.
   */
  constructor(private readonly threshold = 3, private readonly openMs = 10 * MINUTE) {}

  /** Whether a request may go now (a trial after the pause counts). */
  allow(now: number): boolean {
    return now >= this.openUntil;
  }

  /** When it closes again (0 when closed). */
  until(now: number): number {
    return this.openUntil > now ? this.openUntil : 0;
  }

  /** A request worked. */
  success(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  /**
   * A request failed.
   *
   * @param now - Now (ms).
   * @param hard - The key was rejected: open at once, for an hour.
   */
  failure(now: number, hard = false): void {
    this.failures++;
    if (hard) this.openUntil = now + HOUR;
    else if (this.failures >= this.threshold) this.openUntil = now + this.openMs;
  }
}

/** What a failed call means for the provider. */
export type FailureKind = "limit" | "auth" | "error" | "abort";

/**
 * @param err - What the call threw.
 * @returns The status and rate-limit headers when it is an HTTP error from a provider.
 */
function httpInfo(err: unknown): { status?: number; headers: Record<string, string> } {
  const e = err as Partial<HttpError> | undefined;
  const status = typeof e?.status === "number" ? e.status : Number(/→\s*(\d{3})\b/.exec((err as Error)?.message ?? "")?.[1]) || undefined;
  return { ...(status ? { status } : {}), headers: e?.rateHeaders ?? {} };
}

/** Thrown when no provider could take the request; the text says so, with when to try again. */
export class FreeCloudUnavailable extends Error {
  /** @param retryInMs - The soonest a provider may be tried again, when one is only waiting. */
  constructor(message: string, readonly retryInMs?: number) {
    super(message);
    this.name = "FreeCloudUnavailable";
  }
}

/** One provider's state for the card. */
export interface FreeProviderStatus {
  id: string;
  /** A key (and, for Cloudflare, the account) is set. */
  configured: boolean;
  enabled: boolean;
  /** `ready`; `limited` (wait, with `until`); `paused` (errors, with `until`); `nokey`; `off`. */
  state: "ready" | "limited" | "paused" | "nokey" | "off";
  until?: number;
  minute: { used: number; limit: number };
  day: { used: number; limit: number };
  model: string;
  /** The last error, with secrets removed. */
  lastError?: string;
  lastOkAt?: number;
}

/** Where the pool keeps the day counters across restarts. */
export interface FreeCloudStore {
  load(): Record<string, { day?: string; dayUsed?: number; blockedUntil?: number }>;
  save(state: Record<string, { day: string; dayUsed: number; blockedUntil: number }>): void;
}

/** What the pool needs from the app. */
export interface FreeCloudDeps {
  registry: ProviderRegistry;
  settings: () => FreeCloudSettings;
  now?: () => number;
  store?: FreeCloudStore;
}

interface Member {
  info: FreeProviderInfo;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  lastError?: string;
  lastOkAt?: number;
}

/** The pool. */
export class FreeCloudPool {
  private readonly members = new Map<string, Member>();
  private readonly now: () => number;

  /** @param d - The registry, the settings and (for tests) a clock and a store. */
  constructor(private readonly d: FreeCloudDeps) {
    this.now = d.now ?? Date.now;
    const saved = d.store?.load() ?? {};
    for (const info of FREE_PROVIDERS) {
      const limiter = new RateLimiter(info.limits);
      limiter.restore(saved[info.id], this.now());
      this.members.set(info.id, { info, limiter, breaker: new CircuitBreaker() });
    }
  }

  private config(id: string): ProviderConfig | undefined {
    return this.d.registry.list().find((r) => r.config.id === id)?.config;
  }

  private persist(): void {
    if (!this.d.store) return;
    const out: Record<string, { day: string; dayUsed: number; blockedUntil: number }> = {};
    for (const [id, m] of this.members) out[id] = m.limiter.snapshot();
    this.d.store.save(out);
  }

  /** The model used for a provider: the user's choice, else the default. */
  modelFor(id: string): string {
    return this.d.settings().models[id] || freeProvider(id)?.defaultModel || "";
  }

  /** @returns Whether the settings allow this use. */
  private allowed(use: FreeUse): boolean {
    const s = this.d.settings();
    return use === "pick" || (use === "chat" ? s.chatFallback : s.backgroundFallback);
  }

  /**
   * The providers a request may try now, in the user's order: set up, switched on, not at a limit, not paused.
   *
   * @param use - What it is for.
   * @returns The connection ids (empty when the settings do not allow this use).
   */
  candidates(use: FreeUse): string[] {
    if (!this.allowed(use)) return [];
    const now = this.now();
    return this.orderedIds().filter((id) => this.usable(id, now));
  }

  private orderedIds(): string[] {
    const s = this.d.settings();
    const known = new Set(this.members.keys());
    return [...s.order.filter((id) => known.has(id)), ...[...known].filter((id) => !s.order.includes(id))].filter((id, i, all) => all.indexOf(id) === i);
  }

  private configured(id: string): boolean {
    return !!this.config(id)?.apiKey && !!this.d.registry.get(id) && !this.d.settings().disabled.includes(id);
  }

  private usable(id: string, now: number): boolean {
    const m = this.members.get(id);
    return !!m && this.configured(id) && m.limiter.check(now).ok && m.breaker.allow(now);
  }

  /**
   * Runs a call on the first provider that can take it; on a limit or an error goes on to the next one.
   *
   * @param use - What it is for (the settings must allow it).
   * @param fn - The call, given the provider's connection id and the free model to use. A thrown error with
   *   `noFallback` set (text was already shown) ends the run instead of trying another provider.
   * @param signal - Stops the run.
   * @returns The call's value and who answered.
   * @throws {@link FreeCloudUnavailable} when none could.
   */
  async run<T>(use: FreeUse, fn: (id: string, model: string) => Promise<T>, signal?: AbortSignal): Promise<{ value: T; providerId: string; model: string }> {
    if (!this.allowed(use)) throw new FreeCloudUnavailable("Free cloud helpers are not allowed for this use (Settings › Models › Free cloud helpers).");
    const ids = this.orderedIds().filter((id) => this.configured(id));
    if (!ids.length) throw new FreeCloudUnavailable("No free cloud provider is set up: add a key in Settings › Models › Free cloud helpers.");
    let last = "";
    for (const id of ids) {
      if (signal?.aborted) throw new Error("Stopped.");
      const m = this.members.get(id)!;
      const key = this.config(id)?.apiKey;
      const model = this.modelFor(id);
      // A model that costs money is refused here, before any call, and the next provider is tried.
      const paid = paidModelReason(id, model);
      if (paid) {
        m.lastError = `Refused: ${paid}`;
        last = m.lastError;
        continue;
      }
      const now = this.now();
      if (!m.limiter.check(now).ok || !m.breaker.allow(now)) continue;
      m.limiter.note(now);
      try {
        const value = await fn(id, model);
        m.limiter.success();
        m.breaker.success();
        m.lastOkAt = this.now();
        delete m.lastError;
        this.persist();
        return { value, providerId: id, model };
      } catch (err) {
        if (signal?.aborted) throw err;
        const kind = this.fail(m, err, key);
        this.persist();
        last = m.lastError ?? "";
        if ((err as { noFallback?: boolean }).noFallback || kind === "abort") throw err;
      }
    }
    const now = this.now();
    const waits = [...this.members.values()].flatMap((m) => [m.limiter.usage(now).blockedUntil, m.breaker.until(now)]).filter((u) => u > now);
    const retry = waits.length ? Math.min(...waits) - now : undefined;
    const when = retry !== undefined ? ` Retry in ${Math.max(1, Math.ceil(retry / MINUTE))}m.` : "";
    throw new FreeCloudUnavailable(`Free cloud limit reached (429): every free provider is at its limit or paused.${when}${last ? ` Last: ${last}` : ""}`, retry);
  }

  /** Records a failed call on a member; returns what it meant. */
  private fail(m: Member, err: unknown, key: string | undefined): FailureKind {
    const now = this.now();
    const message = redact((err as Error)?.message ?? String(err), key);
    const { status, headers } = httpInfo(err);
    m.lastError = message.slice(0, 240);
    if (status === 429) {
      m.limiter.rejected(headers, message, now);
      return "limit";
    }
    if (status === 401 || status === 403) {
      m.breaker.failure(now, true);
      m.lastError = `The key was rejected (${status}). Check it in Settings.`;
      return "auth";
    }
    if (/Stopped|aborted/i.test(message) && !status) return "abort";
    m.breaker.failure(now);
    return "error";
  }

  /**
   * One tiny request to a provider (the card's Test button): counted like any other, so a limit or a wrong key shows
   * the same way it would in use.
   *
   * @param id - The connection id.
   * @param signal - Stops it.
   * @returns Whether it answered, and the reason when not (secrets removed).
   */
  async test(id: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string; model: string }> {
    const m = this.members.get(id);
    const model = this.modelFor(id);
    const provider = this.d.registry.get(id);
    const key = this.config(id)?.apiKey;
    if (!m || !provider?.chatWithTools || !key) return { ok: false, message: "No key is set.", model };
    const paid = paidModelReason(id, model);
    if (paid) return { ok: false, message: `Refused: ${paid}`, model };
    const now = this.now();
    const blocked = m.limiter.check(now);
    if (!blocked.ok) return { ok: false, message: `At its free limit; try again in ${Math.max(1, Math.ceil((blocked.until - now) / MINUTE))}m.`, model };
    m.limiter.note(now);
    try {
      await provider.chatWithTools({ providerModelId: model, messages: [{ role: "user", content: "Reply with: ok" }], tools: [], maxTokens: 1024 }, signal ?? AbortSignal.timeout(20_000));
      m.limiter.success();
      m.breaker.success();
      m.lastOkAt = this.now();
      delete m.lastError;
      this.persist();
      return { ok: true, model };
    } catch (err) {
      this.fail(m, err, key);
      this.persist();
      return { ok: false, message: m.lastError ?? "Failed.", model };
    }
  }

  /** The state of every provider, for the cards and the phone. Never holds a key. */
  status(): FreeProviderStatus[] {
    const now = this.now();
    const s = this.d.settings();
    return this.orderedIds().map((id) => {
      const m = this.members.get(id)!;
      const configured = !!this.config(id)?.apiKey && !!this.d.registry.get(id);
      const enabled = !s.disabled.includes(id);
      const u = m.limiter.usage(now);
      const block = m.limiter.check(now);
      const paused = m.breaker.until(now);
      const state: FreeProviderStatus["state"] = !configured ? "nokey" : !enabled ? "off" : paused ? "paused" : !block.ok ? "limited" : "ready";
      const until = state === "paused" ? paused : state === "limited" && !block.ok ? block.until : undefined;
      return {
        id,
        configured,
        enabled,
        state,
        ...(until ? { until } : {}),
        minute: { used: u.minute, limit: m.info.limits.rpm },
        day: { used: u.day, limit: m.info.limits.rpd },
        model: this.modelFor(id),
        ...(m.lastError ? { lastError: m.lastError } : {}),
        ...(m.lastOkAt ? { lastOkAt: m.lastOkAt } : {}),
      };
    });
  }

  /**
   * A model turn that goes through the pool (research tasks, helpers, a chat's fallback).
   *
   * @param use - What it is for.
   * @returns A turn the agent loop can call. Once text was shown, a failure is not retried elsewhere.
   */
  turn(use: FreeUse): ModelTurn {
    return async (req, signal, onText) => {
      const r = await this.run(
        use,
        async (id, model) => {
          const provider = this.d.registry.get(id);
          if (!provider?.chatWithTools) throw new Error(`${id} cannot chat.`);
          let shown = 0;
          try {
            // Free tiers that may train (Mistral, OpenRouter's free models) get sensitive things hidden: privacy-guard.ts.
            const { messages } = guardMessages(`${id}/${model}`, req.messages);
            return await provider.chatWithTools({ providerModelId: model, messages, tools: req.tools, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}) }, signal, (t) => {
              shown += t.length;
              onText(t);
            });
          } catch (e) {
            if (shown > 0) throw Object.assign(e as Error, { noFallback: true });
            throw e;
          }
        },
        signal,
      );
      return r.value;
    };
  }
}

/**
 * The free-cloud connection: an OpenAI-style provider that lists only free models and refuses to call any other.
 * Registered as type `free-cloud`; its config has the base URL and the sealed key.
 */
export class FreeOnlyProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location = "cloud" as const;
  readonly capabilities = { chat: true, tools: true };
  private readonly inner: OpenAICompatibleProvider;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  /** Models the last listing showed as priced (OpenRouter), so a call to one is refused. */
  private readonly priced = new Set<string>();

  /** @param config - The connection (id `fc-…`, base URL, key). */
  constructor(config: ProviderConfig) {
    if (!freeProvider(config.id)) throw new Error(`"${config.id}" is not a free cloud provider.`);
    if (!config.baseUrl) throw new Error(`Provider "${config.id}" needs a baseUrl`);
    this.id = config.id;
    this.name = config.name ?? config.id;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.inner = new OpenAICompatibleProvider({ ...config, type: "openai-compatible", location: "cloud" });
  }

  /** Throws when the model costs money. */
  private guard(modelId: string): void {
    const why = paidModelReason(this.id, modelId, { priced: this.priced.has(modelId) });
    if (why) throw new Error(`Refused: ${why} KesherAI never uses a paid model.`);
  }

  /**
   * Fetches the provider's list and marks the free models (the card shows them; the pool picks from them).
   *
   * @param signal - Stops it.
   */
  async listFree(signal?: AbortSignal): Promise<ListedModel[]> {
    const res = await fetchOk(modelListUrl(this.id, this.baseUrl), { headers: { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }, signal: signal ?? AbortSignal.timeout(15_000) }).catch((e: Error) => {
      throw new Error(redact(e.message, this.apiKey));
    });
    const list = parseModelList(this.id, await res.json());
    this.priced.clear();
    for (const m of list) if (m.reason && /costs money/.test(m.reason)) this.priced.add(m.id);
    return list;
  }

  /** @inheritDoc */
  checkHealth(signal?: AbortSignal): Promise<boolean> {
    return this.listFree(signal).then(() => true, () => false);
  }

  /** @inheritDoc */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const list = await this.listFree(signal);
    return list.filter((m) => m.free).map((m) => ({ id: makeModelId(this.id, m.id), providerId: this.id, providerModelId: m.id, name: m.id, category: "chat" as const, location: "cloud" as const }));
  }

  /** @inheritDoc */
  async *chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    this.guard(request.providerModelId);
    yield* this.inner.chat(request, signal);
  }

  /** @inheritDoc */
  async chatWithTools(request: ProviderToolChatRequest, signal?: AbortSignal, onText?: (delta: string) => void): Promise<ProviderToolChatResult> {
    this.guard(request.providerModelId);
    try {
      return await this.inner.chatWithTools(request, signal, onText);
    } catch (e) {
      // A provider can echo a key back in its error text; the key is never shown.
      if (e instanceof Error) e.message = redact(e.message, this.apiKey);
      throw e;
    }
  }
}

/** The factory for type `free-cloud` (registered by the server). */
export const freeCloudFactory: ProviderFactory = {
  type: "free-cloud",
  displayName: "Free cloud helper",
  categories: ["chat"],
  create: (config) => new FreeOnlyProvider(config),
};

/** The id of the pool's own model: "Free cloud (automatic)". */
export const FREE_POOL_PROVIDER = "freecloud";

/**
 * Whether a model id goes to the free cloud (a chat marked "never to the cloud" may not use it).
 *
 * @param modelId - A global model id.
 */
export function isFreeCloudModel(modelId: string): boolean {
  const p = modelId.split("/")[0] ?? "";
  return p === FREE_POOL_PROVIDER || !!freeProvider(p);
}

/** The model a chat can pick that goes through the pool: the first free provider that is not at a limit. */
export class FreeCloudPoolProvider implements Provider {
  readonly id = FREE_POOL_PROVIDER;
  readonly name = "Free cloud helpers";
  readonly location = "cloud" as const;
  readonly capabilities = { chat: true, tools: true };

  /** @param pool - The pool it goes through. */
  constructor(private readonly pool: FreeCloudPool) {}

  /** @inheritDoc */
  async checkHealth(): Promise<boolean> {
    return this.pool.candidates("pick").length > 0;
  }

  /** @inheritDoc */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.pool.status().some((s) => s.configured && s.enabled)) return [];
    return [{ id: makeModelId(FREE_POOL_PROVIDER, "auto"), providerId: FREE_POOL_PROVIDER, providerModelId: "auto", name: "Free cloud (automatic)", category: "chat", location: "cloud" }];
  }

  /** @inheritDoc */
  async *chat(request: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const r = await this.chatWithTools({ providerModelId: "auto", messages: request.messages.map((m) => ({ role: m.role, content: m.content })), tools: [], ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}) }, signal);
    if (r.text) yield { type: "delta", text: r.text };
    yield { type: "done", ...(r.usage ? { usage: r.usage } : {}) };
  }

  /** @inheritDoc */
  chatWithTools(request: ProviderToolChatRequest, signal?: AbortSignal, onText?: (delta: string) => void): Promise<ProviderToolChatResult> {
    return this.pool.turn("pick")({ messages: request.messages, tools: request.tools }, signal ?? new AbortController().signal, onText ?? (() => undefined));
  }
}
