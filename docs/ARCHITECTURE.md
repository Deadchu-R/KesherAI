# Architecture

KesherAI is one local **core server** with many **clients**. The core owns every model connection, file and setting; clients only talk to it over HTTP. This is the same split OpenCode uses, and it is what makes remote access from a phone free: the phone is just another client.

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
| `@kesher/agent` | `AgentSession` (the tool-calling loop), code tools, permissions, system prompt | shared |
| `@kesher/core` | The HTTP server; wires everything together | all of the above |
| `apps/web` | The React UI | shared (types only at runtime: categories, branding) |
| `apps/desktop` | Electron shell: runs core in-process, opens a window, folder picker | core |
| `apps/android` | Capacitor shell: a connect screen, then the UI served by the computer | — |

Dependencies only point down this table. `shared` never imports anything from KesherAI; nothing imports `core` except `desktop`.

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

## A conversation, end to end

Every conversation — chat or code — is an `AgentSession` (`packages/agent/src/session.ts`), owned by the `ConversationManager` (`packages/core/src/conversations.ts`):

1. `POST /api/conversations/:id/messages` → the manager loads the session (from `library/conversations/<id>.json` the first time), refreshes its tools and system prompt, and calls `send`.
2. The session calls the model through `modelTurnFor`, which uses the provider's `chatWithTools` (streamed text arrives as `assistant_delta` events).
3. For each tool call, `decide` (`permissions.ts`) says run or ask. Asking emits `approval_request` with a diff or the command and waits; `ask_user` emits `question` and waits.
4. The tool runs inside the workspace (`resolveInWorkspace` refuses paths outside it), its result goes back to the model, and the loop continues until the model answers without calling tools.
5. Every event is pushed over SSE to every client watching (desktop, phone) and saved to the library a moment later; with a sync folder, the file is copied there too.

Tools come from three places: the code tools (code conversations only), a tool per active media model (`generate_image` today), and plugin tools.

## The built-in engine

`LlamaEngine` (`packages/core/src/llamacpp.ts`) downloads llama.cpp's official release for this computer from GitHub — CUDA 12 plus its runtime on NVIDIA, Vulkan on other Windows GPUs, Metal on Mac, CPU on Linux without NVIDIA — unpacks it with `tar`, and starts `llama-server` on `127.0.0.1:8081` with `--jinja` for tool calling. The running server is registered as the `llamacpp` provider, so the rest of the app treats it like any other OpenAI-compatible server. The last model loaded is loaded again on start-up.

## Model ids

A global model id is `<providerId>/<providerModelId>`, built with `makeModelId` and split with `parseModelId`. Provider ids cannot contain `/`; provider model ids can (`hf/Qwen/Qwen3-14B`). The same ids are used in the UI, in `/v1` as the OpenAI `model` name, and in saved conversations.

## Data folder

```
~/.kesher/                 (KESHER_DATA_DIR overrides; forks get ~/.<appId>)
  config.json              providers, tokens, engine paths, active models, sync folder — mode 0600
  library/projects/<id>.json
  library/conversations/<id>.json
  engines/llama.cpp/<build>/
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
- **No database yet.** Config is one JSON file; projects, conversations and assets are files. Files sync through any cloud folder without conflicts on different conversations. SQLite may come with full-text search.
- **One agent for everything.** Chat and code share `AgentSession`, so approvals, questions, streaming and history work the same everywhere, including on the phone.
- **Feature flags at the edges.** `features.config.ts` decides which routes register and which screens show; core logic never checks flags.
