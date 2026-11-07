# Adding a provider

A provider connects KesherAI to a source of models: a local engine, a server the user runs, or a cloud API. Before writing one, check whether the source speaks the OpenAI Chat Completions API — if it does, you only need a **preset** (step 0), not code.

## 0. Is it OpenAI-compatible? Add a preset

Add one entry to `packages/providers/src/presets.ts`:

```ts
{
  config: { id: "mistral", type: "openai-compatible", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", location: "cloud" },
  description: "Mistral's models through their API.",
  needsApiKey: true,
},
```

Set `autodetect: true` only for servers that run on the user's own machine on a fixed default port. Done — open a pull request.

## 1. Implement `Provider`

Otherwise, create a class that implements `Provider` from `packages/providers/src/provider.ts`.

```ts
import { makeModelId, type ModelInfo } from "@kesher/shared";
import type { Provider, ProviderConfig, ProviderImageRequest, GeneratedFile } from "@kesher/providers";

export class AcmeImagesProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly location = "cloud" as const;
  readonly capabilities = { image: true };

  constructor(private readonly config: ProviderConfig) {
    if (!config.apiKey) throw new Error(`Provider "${config.id}" needs an apiKey`);
    this.id = config.id;
    this.name = config.name ?? "Acme Images";
  }

  async checkHealth(signal?: AbortSignal) {
    try {
      return (await fetch("https://api.acme.example/health", { signal })).ok;
    } catch {
      return false; // never throw from checkHealth
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{
      id: makeModelId(this.id, "acme-xl"), providerId: this.id, providerModelId: "acme-xl",
      name: "Acme XL", category: "image", location: "cloud",
    }];
  }

  async generateImage(req: ProviderImageRequest, signal?: AbortSignal): Promise<GeneratedFile[]> {
    const res = await fetch("https://api.acme.example/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: req.providerModelId, prompt: req.prompt, width: req.width, height: req.height }),
      signal,
    });
    if (!res.ok) throw new Error(`Acme returned ${res.status}`);
    return [{ data: new Uint8Array(await res.arrayBuffer()), mimeType: "image/png", meta: { prompt: req.prompt } }];
  }
}
```

### Rules every provider follows

| Rule | Why |
| --- | --- |
| The constructor does no network I/O. | Providers are created at start-up; a slow server must not delay the app. |
| `checkHealth` never throws and times out quickly. | It powers the green/red status in Connections. |
| `listModels` throws on failure. | The registry turns the error into a visible warning without hiding other providers. |
| Pass `signal` to every `fetch`. | The user's Stop button and closed connections must stop work on the server. |
| `chat` yields `delta` events and ends with exactly one `done` or `error`. | Clients rely on it to know the reply is complete. |
| Error messages say what to do. | They are shown to users as-is. |
| Set `capabilities` to match the methods you implement. | Routes check it before calling. |

Use `fetchOk` and `readSSE` from `packages/providers/src/sse.ts` for HTTP errors and streamed responses.

## 2. Add a factory

```ts
export const acmeImagesFactory: ProviderFactory = {
  type: "acme-images",
  displayName: "Acme Images",
  categories: ["image"],
  create: (config) => new AcmeImagesProvider(config),
};
```

## 3. Register it

- **In KesherAI itself:** export it from `packages/providers/src/index.ts` and add it to `BUILT_IN_FACTORIES`.
- **As a plugin:** call `ctx.registerProviderFactory(acmeImagesFactory)` in your plugin's `activate`. See [PLUGINS.md](PLUGINS.md).

## 4. Test it

Write a `*.test.ts` next to it. You do not need the real service: start a tiny `node:http` server that answers like it (see `packages/downloads/src/downloader.test.ts`), point `baseUrl` at it, and assert on the results. Run `pnpm test`.

## Adding a new capability

If your source does something no capability covers yet (video, speech), add the method to `Provider` with a request type, a flag in `ProviderCapabilities`, a route in `packages/core/src/routes/generate.ts`, a schema in `@kesher/shared`, and the endpoint in [API.md](API.md). Open an issue first so the shape is agreed before several providers implement it.
