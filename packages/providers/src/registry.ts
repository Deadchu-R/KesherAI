import { parseModelId, type ModelInfo } from "@kesher/shared";
import type { Provider, ProviderConfig, ProviderFactory } from "./provider.js";

/** Result of {@link ProviderRegistry.listAllModels}: models plus per-provider errors. */
export interface ModelListing {
  models: ModelInfo[];
  /** Providers that failed to answer, with the reason. The UI shows these as warnings. */
  errors: Array<{ providerId: string; message: string }>;
}

/**
 * Holds local work (chat, image and video calls of providers that run on
 * this computer) until it may start — e.g. while the graphics card cools.
 */
export interface ProviderGate {
  /** Resolves when the call may start; may throw (cancelled, failed to load). */
  before(providerId: string, signal?: AbortSignal): Promise<void>;
  /** Called once when the call ends. */
  after(): void;
}

/** Methods that put a local model to work; the argument after the request is the abort signal. */
const GATED = new Set(["chat", "chatWithTools", "generateImage", "generateVideo"]);

/**
 * Keeps the live providers and routes a global model id to the provider
 * that serves it.
 *
 * Factories are registered once (built-ins by the core server, others by
 * plugins). Providers are created from user config with {@link add}.
 */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();
  private readonly providers = new Map<string, { provider: Provider; config: ProviderConfig }>();
  private gate?: ProviderGate;
  private allowed?: (providerId: string) => boolean;

  /**
   * Limits which providers may be used (business mode): the others' models
   * are not listed and calls to them are refused.
   *
   * @param allowed - Says whether a provider may be used; undefined allows all.
   */
  setPolicy(allowed: ((providerId: string) => boolean) | undefined): void {
    this.allowed = allowed;
  }

  /**
   * @param id - Provider id.
   * @returns Whether the current policy lets it be used.
   */
  permitted(id: string): boolean {
    return !this.allowed || this.allowed(id);
  }

  /**
   * Sends every local provider's work through a gate (see {@link ProviderGate}).
   *
   * @param gate - The gate, or undefined to remove it.
   */
  setGate(gate: ProviderGate | undefined): void {
    this.gate = gate;
  }

  /** Wraps a local provider so its work passes the gate (read at call time). */
  private gated(provider: Provider): Provider {
    return new Proxy(provider, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== "string" || !GATED.has(prop) || typeof value !== "function") return value;
        const fn = value as (...args: unknown[]) => unknown;
        const id = target.id;
        if (prop === "chat") {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const registry = this;
          return async function* (...args: unknown[]) {
            const gate = registry.gate;
            if (!gate) return yield* fn.apply(target, args) as AsyncIterable<unknown>;
            await gate.before(id, args[1] as AbortSignal | undefined);
            try {
              yield* fn.apply(target, args) as AsyncIterable<unknown>;
            } finally {
              gate.after();
            }
          };
        }
        return async (...args: unknown[]) => {
          const gate = this.gate;
          if (!gate) return fn.apply(target, args);
          await gate.before(id, args[1] as AbortSignal | undefined);
          try {
            return await fn.apply(target, args);
          } finally {
            gate.after();
          }
        };
      },
    });
  }

  /**
   * Makes a provider `type` available.
   *
   * @param factory - The factory to register.
   * @throws Error if a factory with the same `type` already exists.
   */
  registerFactory(factory: ProviderFactory): void {
    if (this.factories.has(factory.type)) throw new Error(`Provider type "${factory.type}" is already registered`);
    this.factories.set(factory.type, factory);
  }

  /** @returns Every registered factory, for the "Add connection" dialog. */
  listFactories(): ProviderFactory[] {
    return [...this.factories.values()];
  }

  /**
   * Creates a provider from config and adds it, replacing any provider with
   * the same id.
   *
   * @param config - Provider settings.
   * @returns The new provider.
   * @throws Error if the id is invalid or the type is unknown.
   */
  add(config: ProviderConfig): Provider {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(config.id)) {
      throw new Error(`Invalid provider id "${config.id}": use letters, digits, "-" and "_"`);
    }
    const factory = this.factories.get(config.type);
    if (!factory) throw new Error(`Unknown provider type "${config.type}"`);
    const created = factory.create(config);
    const provider = created.location === "local" ? this.gated(created) : created;
    this.providers.set(config.id, { provider, config });
    return provider;
  }

  /**
   * Removes a provider.
   *
   * @param id - Provider id.
   * @returns `true` if it existed.
   */
  remove(id: string): boolean {
    this.lastModels.delete(id);
    return this.providers.delete(id);
  }

  /**
   * @param id - Provider id.
   * @returns The provider, or `undefined`.
   */
  get(id: string): Provider | undefined {
    return this.providers.get(id)?.provider;
  }

  /** @returns All providers with the config they were created from. */
  list(): Array<{ provider: Provider; config: ProviderConfig }> {
    return [...this.providers.values()];
  }

  /**
   * Asks every provider for its models in parallel. One slow or offline
   * provider never hides the others' models.
   *
   * @param timeoutMs - Per-provider timeout.
   * @returns All models found, and the providers that failed.
   */
  async listAllModels(timeoutMs = 5000): Promise<ModelListing> {
    const listing: ModelListing = { models: [], errors: [] };
    const ask: Provider[] = [];
    for (const { provider } of this.list().filter(({ provider }) => this.permitted(provider.id))) {
      const id = provider.id;
      // A computer that said it is going to sleep: no waiting on it.
      const away = this.away.get(id);
      if (away) {
        listing.errors.push({ providerId: id, message: away });
        continue;
      }
      // Another computer (a "server" provider) with a list from the last minutes: shown at once, refreshed behind the scenes,
      // so opening a chat never waits on a computer that was already found.
      const cached = this.lastModels.get(id);
      if (provider.location === "server" && cached && Date.now() - cached.at < 10 * 60_000) {
        listing.models.push(...cached.models);
        if (Date.now() - cached.at > 60_000) this.refreshInBackground(provider);
        continue;
      }
      ask.push(provider);
    }
    // Servers on another network (another computer through the internet) get longer: their own list asks their providers first.
    const wait = (p: Provider) => (p.location === "server" ? Math.max(timeoutMs, 15_000) : timeoutMs);
    const results = await Promise.allSettled(ask.map((provider) => provider.listModels(AbortSignal.timeout(wait(provider)))));
    results.forEach((r, i) => {
      const providerId = ask[i]!.id;
      if (r.status === "fulfilled") {
        this.lastModels.set(providerId, { at: Date.now(), models: r.value });
        listing.models.push(...r.value);
      } else {
        // A slow or briefly unreachable server keeps showing the models it had a moment ago.
        const last = this.lastModels.get(providerId);
        if (last) listing.models.push(...last.models);
        listing.errors.push({ providerId, message: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      }
    });
    return listing;
  }

  /** The last model list each provider gave, and when (shown while it is slow to answer). */
  private readonly lastModels = new Map<string, { at: number; models: ModelInfo[] }>();
  private readonly refreshing = new Set<string>();
  /** Providers whose computer said it is going away (sleep, shutdown), with the line to show. */
  private readonly away = new Map<string, string>();

  private refreshInBackground(provider: Provider): void {
    if (this.refreshing.has(provider.id)) return;
    this.refreshing.add(provider.id);
    void provider
      .listModels(AbortSignal.timeout(20_000))
      .then((models) => this.lastModels.set(provider.id, { at: Date.now(), models }), () => undefined)
      .finally(() => this.refreshing.delete(provider.id));
  }

  /**
   * Remembers a provider's models (e.g. right after reaching another computer), so they show at once.
   *
   * @param providerId - The provider.
   * @param models - Its models.
   */
  rememberModels(providerId: string, models: ModelInfo[]): void {
    this.lastModels.set(providerId, { at: Date.now(), models });
  }

  /**
   * Marks a provider's computer as away (it announced sleep or shutdown), or back.
   *
   * @param providerId - The provider.
   * @param why - The line to show while away; undefined = back.
   */
  setAway(providerId: string, why: string | undefined): void {
    if (why) this.away.set(providerId, why);
    else this.away.delete(providerId);
  }

  /** @returns Why the provider's computer is away, if it said so. */
  awayReason(providerId: string): string | undefined {
    return this.away.get(providerId);
  }

  /**
   * Finds the provider for a global model id.
   *
   * @param modelId - e.g. `lmstudio/qwen3-14b`.
   * @returns The provider and the id to pass to it.
   * @throws Error if no provider with that id exists.
   */
  resolve(modelId: string): { provider: Provider; providerModelId: string } {
    const { providerId, providerModelId } = parseModelId(modelId);
    const provider = this.get(providerId);
    if (!provider) throw new Error(`No provider "${providerId}" — add it under Connections`);
    if (!this.permitted(providerId)) throw new Error(`${provider.name} is turned off by your organisation's business mode.`);
    return { provider, providerModelId };
  }
}
