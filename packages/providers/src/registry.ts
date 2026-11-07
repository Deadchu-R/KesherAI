import { parseModelId, type ModelInfo } from "@kesher/shared";
import type { Provider, ProviderConfig, ProviderFactory } from "./provider.js";

/** Result of {@link ProviderRegistry.listAllModels}: models plus per-provider errors. */
export interface ModelListing {
  models: ModelInfo[];
  /** Providers that failed to answer, with the reason. The UI shows these as warnings. */
  errors: Array<{ providerId: string; message: string }>;
}

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
    const provider = factory.create(config);
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
    const entries = this.list();
    const results = await Promise.allSettled(
      entries.map(({ provider }) => provider.listModels(AbortSignal.timeout(timeoutMs))),
    );
    const listing: ModelListing = { models: [], errors: [] };
    results.forEach((r, i) => {
      const providerId = entries[i]!.provider.id;
      if (r.status === "fulfilled") listing.models.push(...r.value);
      else listing.errors.push({ providerId, message: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    });
    return listing;
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
    return { provider, providerModelId };
  }
}
