# Architecture

Kesher is one local **core server** with many **clients**. The core owns every model connection, file and setting; clients only talk to it over HTTP. This is the same split OpenCode uses, and it is what makes remote access from a phone free: the phone is just another client.

```
  Desktop window      Phone browser       Other tools (LobeHub, OpenCode, SDKs)
  (apps/desktop)      (apps/web, PWA)     via /v1 (OpenAI-compatible)
        │                   │                         │
        └──────── HTTP + Server-Sent Events ──────────┘
                            │
                ┌───────────┴────────────┐
                │  packages/core          │  Fastify server on 127.0.0.1:7420
                │  routes/ · services     │
                │  ┌───────────────────┐  │
                │  │ ProviderRegistry  │──┼──► providers: llama.cpp, LM Studio, Ollama,
                │  │ AssetStore        │  │              ComfyUI, OpenAI, Anthropic, plugins…
                │  │ DownloadManager   │──┼──► Hugging Face
                │  │ PluginHost        │  │
                │  │ LlamaServerManager│──┼──► llama-server child process
                │  └───────────────────┘  │
                └─────────────────────────┘
```

## Packages and their jobs

| Package | Owns | Depends on |
| --- | --- | --- |
| `@kesher/shared` | Types, zod schemas, categories, branding, feature flags. No I/O. | zod |
| `@kesher/providers` | The `Provider` interface, adapters, presets, `ProviderRegistry` | shared |
| `@kesher/downloads` | Hugging Face search, `DownloadManager`, hardware detection | shared |
| `@kesher/skills` | `SKILL.md` discovery and loading | — |
| `@kesher/plugin-sdk` | What plugins import: `definePlugin`, `PluginContext`, manifest schema | shared, providers |
| `@kesher/core` | The HTTP server; wires everything together | all of the above |
| `apps/web` | The React UI | shared (types only at runtime: categories, branding) |
| `apps/desktop` | Electron shell: runs core in-process, opens a window | core |

Dependencies only point down this table. `shared` never imports anything from Kesher; nothing imports `core` except `desktop`.

## Start-up order

`createKesherServer` in `packages/core/src/server.ts` is the one place where things are created. Read it top to bottom:

1. Load `~/.kesher/config.json` and create the data folders.
2. Register the built-in provider types (`openai-compatible`, `anthropic`, `comfyui`).
3. Load plugins — they may register more provider types, categories and tools.
4. Create providers from the config file. This comes after plugins so that providers of plugin types work.
5. Probe well-known local ports (LM Studio, Ollama, ComfyUI) and add whatever answers.
6. Register routes, the remote-access check, and the static UI.

## A chat request, end to end

1. The UI sends `POST /api/chat` with `{ modelId: "lmstudio/qwen3-14b", messages }`.
2. `routes/generate.ts` validates the body with `ChatRequestSchema` from `@kesher/shared`.
3. `ProviderRegistry.resolve` splits the id at the first `/` into provider `lmstudio` and model `qwen3-14b`.
4. The route switches the reply to Server-Sent Events and iterates `provider.chat(...)`.
5. `OpenAICompatibleProvider.chat` calls LM Studio's `/v1/chat/completions` with `stream: true`, parses its SSE stream (`readSSE`) and yields `{ type: "delta", text }` events.
6. Each event is written to the UI as one `data:` line, then `{ type: "done" }`.
7. If the user presses Stop, the browser aborts the request; the route's `closed` signal aborts the provider's `fetch`, so generation stops on the server too.

An image request is the same shape, except the provider returns files, which the route saves in the `AssetStore` and returns as asset ids (`/api/assets/<id>`).

## Model ids

A global model id is `<providerId>/<providerModelId>`, built with `makeModelId` and split with `parseModelId`. Provider ids cannot contain `/`; provider model ids can (`hf/Qwen/Qwen3-14B`). The same ids are used in the UI, in `/v1` as the OpenAI `model` name, and in saved conversations.

## Data folder

```
~/.kesher/                 (KESHER_DATA_DIR overrides; forks get ~/.<appId>)
  config.json              providers, tokens, engine paths — mode 0600
  models/<category>/<repo>/<file>
  assets/<id>.<ext> + <id>.json
  plugins/<plugin-id>/     user-installed plugins
  plugin-data/<plugin-id>/ each plugin's private folder
  skills/<skill>/SKILL.md
```

## Design choices worth knowing

- **Everything is a provider.** A local engine, a server the user runs and a cloud API look the same to the rest of the app. New sources never require changes outside `packages/providers` or a plugin.
- **One failing provider never hides others.** `listAllModels` uses `Promise.allSettled` and returns errors separately.
- **Server-Sent Events, not WebSockets,** for streaming: they work through every proxy, need no library, and survive the phone's browser going to sleep better.
- **No database yet.** Config is one JSON file and assets are files. SQLite arrives with chat history (phase 2).
- **Feature flags at the edges.** `features.config.ts` decides which routes register and which screens show; core logic never checks flags.
