# Core server API

Everything the KesherAI UI does goes through this HTTP API, so anything you build — a phone app, a script, a bot — can do the same.

- **Base URL:** `http://127.0.0.1:7420` (port from `config.json`).
- **Format:** JSON in and out. Errors are `{ "error": "message" }` with a 4xx/5xx status.
- **Streaming:** Server-Sent Events. Each event is one `data: <json>` line followed by a blank line.
- **Authentication:** none from the same computer. From other devices (when `remote.enabled` is on), send `Authorization: Bearer <token>`, or `?token=<token>` where headers are impossible (`<img>`, `EventSource`). Get the token from `GET /api/remote` on the computer itself.

The request and response types referenced below are exported from `@kesher/shared`.

## System

Requests that arrive through a tunnel or proxy (they carry `cf-connecting-ip`, `x-forwarded-for` and similar headers) are always treated as remote, even though they reach the server over 127.0.0.1. After 20 wrong tokens from one address in 10 minutes, it gets `429` for a while.


| Method & path | Description |
| --- | --- |
| `GET /api/health` | `{ ok, version, productName, features, remote: { enabled } }` |
| `GET /api/categories` | All categories (built-in and from plugins): `CategoryDefinition[]` |
| `GET /api/hardware` | `{ platform, cpu, ramTotal, ramFree, gpus[], unifiedMemory }` |
| `POST /api/remote/anywhere` | Only from this computer. `{ on }` — "Access from anywhere": starts or stops a Cloudflare quick tunnel (downloads `cloudflared` the first time). Returns `{ installed, running, url?, error? }` |
| `GET /api/remote` | Only from this computer (never through a tunnel). Also returns `anywhere` and `tunnel`. `{ enabled, keepAwake, token, port, addresses: [{ address, tailscale, mac, broadcast }] }` for pairing a device. `mac` and `broadcast` let the phone wake this computer ([WAKE_ON_LAN.md](WAKE_ON_LAN.md)) |
| `GET /api/plugins` | Plugins found, with `status` (`active`, `disabled`, `error`) and `error` |
| `GET /api/tools` | Tools registered by plugins: `{ name, description, inputSchema, pluginId }[]` |
| `GET /api/plugins/ui` | What active plugins add: `{ pages, panels, styles, composerActions }` |
| `GET /api/plugin-files/:token/:id/*` | A plugin's own file (pages, scripts, styles); the token is in the path for sandboxed frames |
| `POST /api/plugins/install` | Install from Git: `{ source: "owner/repo" \| "https://…" }` → `{ id }` |
| `PUT /api/plugins/:id` | `{ enabled }`; reloads plugins |
| `DELETE /api/plugins/:id` | Remove a plugin the user installed |
| `GET/PUT /api/plugins/:id/storage/:key` | A plugin page's saved JSON `{ value }` |
| `GET /api/plugins/catalog` | Public plugins (GitHub topic `kesherai-plugin`) |
| `GET /api/usage` | Tokens across conversations: totals, `byModel`, `byDay`, costliest requests |
| `GET /api/conversations/:id/usage` | Per request: tokens, calls, wasted tokens, failed steps, nudges, reworks, tools |
| `POST /api/conversations/:id/coach` | The coach's suggestions `{ suggestions, learned, stats }`; body `{ modelId? }` |
| `GET/DELETE /api/coach/profile`, `PUT /api/coach/settings` | What the coach learned about the user; `{ learn, modelId }` |
| `GET /api/conversations/activity` | Which conversations are `running` or `waiting` now |
| `GET /api/engines/image/progress`, `GET /api/engines/image/log` | The image engine's live progress, and its last run's full output |
| `POST /api/tools/:name` | Runs a tool. Body: the tool's input. Returns `{ result }` |
| `GET /api/skills` | Installed skills: `{ name, description, dir }[]` |
| `GET /api/skills/:name` | One skill with its `body` (the SKILL.md instructions) |

## Models and connections

| Method & path | Description |
| --- | --- |
| `GET /api/models` | `{ models: ModelInfo[], errors: { providerId, message }[] }` from every provider |
| `GET /api/models/local` | Model files KesherAI can use, from its models folder and the added folders: `{ path, name, size, source, gguf, estimate }[]` |
| `GET /api/models/folders` | `{ modelsDir, defaultDir, folders: { folder, source }[] }` |
| `PUT /api/models/folders` | Only from this computer. `{ modelsDir?: string \| null, folders?: { folder, source }[] }` — change the download folder (`null` = default) and the folders KesherAI reads models from in place |
| `POST /api/models/scan` | Only from this computer. Finds models in LM Studio, Ollama, the Hugging Face cache, Jan, GPT4All, ComfyUI and the added folders: `{ folder, source, added, totalSize, models[] }[]`. Adds nothing by itself |
| `GET /api/providers` | Connections, with `healthy`, `autodetected`, `capabilities`, `hasApiKey` (keys are never returned) |
| `GET /api/providers/presets` | Ready-made connections for the "Add" dialog |
| `GET /api/providers/types` | Provider types available (built-in and from plugins) |
| `POST /api/providers` | Adds or replaces a connection and saves it. Body: `ProviderConfig` |
| `DELETE /api/providers/:id` | Removes a connection |
| `GET /api/models/recommended` | The "Start here" models, each with `downloaded` and a performance `estimate` for this computer |
| `POST /api/models/setup` | "Set it up for me". `{ ids: string[] }` — installs the engine, downloads each model if missing, loads the first. Returns 202 |
| `POST /api/models/recommended/:id/run` | One click: installs the engine if needed, downloads the model if needed, loads it. Returns 202; follow progress in the engine status |

## Built-in engine (llama.cpp)

| Method & path | Description |
| --- | --- |
| `GET /api/engines/llamacpp` | `{ installed, version, running, modelPath, job?: { phase, message }, log[] }`. `job.phase` is `installing`, `downloading-model`, `loading` or `error` |
| `POST /api/engines/llamacpp/install` | Downloads the right llama.cpp build for this computer (CUDA on NVIDIA, Vulkan otherwise, Metal on Mac) in the background |
| `POST /api/engines/llamacpp/load` | `{ modelPath, name? }` — loads a GGUF from the models folder or an added folder (Ollama blobs too); it appears as `llamacpp/<file name>` and becomes the active chat model if none is set |
| `POST /api/engines/llamacpp/stop` | Stops the running model |

## Performance estimates

`/api/models/recommended`, `/api/hub/files` (model weights) and `/api/models/local` include an `estimate` for this computer:

```json
{ "rating": "good", "fit": "fits", "tokensPerSecond": 42.1, "wordsPerSecond": 31.6, "gpuShare": 1,
  "tasks": [{ "task": "short-answer", "seconds": 3.6 }, { "task": "long-answer", "seconds": 23.8 },
            { "task": "read-file", "seconds": 1.8 }, { "task": "load", "seconds": 6.2 }] }
```

`rating` is `good` (≥ 20 tokens/s), `ok` (≥ 7), `slow` or `too-big`. Estimates come from GPU memory bandwidth and model size and are usually within a factor of two.

## Generation

### `POST /api/chat` — streamed

Body (`ChatRequest`):

```json
{ "modelId": "ollama/llama3.2:3b", "messages": [{ "role": "user", "content": "Hello" }], "temperature": 0.7 }
```

Response: an SSE stream of `ChatStreamEvent`:

```
data: {"type":"delta","text":"Hi"}

data: {"type":"delta","text":" there!"}

data: {"type":"done","usage":{"inputTokens":9,"outputTokens":3}}
```

Closing the connection stops generation.

### `POST /api/images`

Body (`ImageRequest`): `{ modelId, prompt, negativePrompt?, width = 1024, height = 1024, steps = 20, seed? }`.
Response: `{ assets: Asset[] }`. Each image is at `GET /api/assets/<id>`.

### `GET /api/assets/:id`

The file, with its MIME type.

## Projects and conversations

Every conversation is an agent session. A `chat` conversation has the media tools of the active models; a `code` conversation also has file and terminal tools inside its folder.

| Method & path | Description |
| --- | --- |
| `GET /api/projects` | Projects: `{ id, name, workspace?, instructions?, createdAt, updatedAt }[]` |
| `POST /api/projects` | `{ name, workspace?, instructions? }` |
| `PATCH /api/projects/:id` | Change name, folder or instructions |
| `DELETE /api/projects/:id` | Deletes the project; its conversations are kept, outside any project |
| `GET /api/conversations?projectId=` | Summaries, newest first. `projectId=none` for conversations outside projects |
| `POST /api/conversations` | `{ kind: "chat" \| "code", projectId?, modelId?, mode?, workspace? }`. `modelId` defaults to the active chat model; `workspace` to the project's folder |
| `GET /api/conversations/:id` | Summary + `session` (`AgentSessionInfo`: status, mode, pending approvals and questions, `canUndo`) + `events` |
| `PATCH /api/conversations/:id` | `{ title?, modelId?, mode?, projectId? }` |
| `DELETE /api/conversations/:id` | Deletes it |
| `GET /api/conversations/:id/events?after=<seq>` | SSE: saved events after `seq`, then live ones. Text streams as `assistant_delta` (seq 0); after each change an `{ "type": "info", ...AgentSessionInfo }` event |
| `POST /api/conversations/:id/messages` | `{ text }` — starts work; 409 while the agent is busy |
| `POST /api/conversations/:id/approvals/:requestId` | `{ decision: "allow" \| "always" \| "deny", feedback? }` |
| `POST /api/conversations/:id/answers/:questionId` | `{ text }` — answers an `ask_user` question |
| `POST /api/conversations/:id/stop` | Stops the agent; open approvals are denied |
| `POST /api/conversations/:id/undo` | Reverts the agent's last file change |

Events (`AgentEvent` in `@kesher/shared`): `user`, `assistant_delta`, `assistant`, `tool_call`, `approval_request` (with `preview`: a diff or the command), `approval_result`, `question`, `answer`, `tool_result` (with `diff`, `assetIds`), `undo`, `status`, `note`.

Permission modes: `ask` (every change and command asks), `auto-edit` (file changes run, commands ask), `auto` (both run). Dangerous commands — recursive deletes, `git push`, piping downloads into a shell, admin rights — always ask.

## Settings, version and updates

| Method & path | Description |
| --- | --- |
| `GET /api/settings` | `{ activeModels: { [category]: modelId }, syncFolder, remote: { enabled, keepAwake } }` |
| `PUT /api/settings` | `{ activeModels?, syncFolder?, remote? }`. Setting a sync folder imports newer files from it, then copies the whole library there. `null` turns sync off. `remote` can only be changed from this computer; turning remote access on or off needs a restart |
| `GET /api/version` | `{ version, commit?, install: "git" \| "package" }` |
| `GET /api/updates` | Fetches from GitHub: `{ newCommits[], latestVersion, localChanges[] }` |
| `POST /api/updates/apply` | `git pull`, `pnpm install`, build — in the background |
| `GET /api/updates/progress` | `{ running, step, log[], error?, restartRequired? }` |

## Google Drive

See [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md) for setup.

| Method & path | Description |
| --- | --- |
| `GET /api/google` | `{ configured, connected, email, lastSync, lastError, customClient }` |
| `PUT /api/google/client` | `{ clientId, clientSecret }` — the user's own OAuth client |
| `POST /api/google/connect` | Only from this computer. Returns `{ url }`, Google's consent page |
| `GET /api/google/callback` | Where Google sends the browser back; shows a small page and starts a sync |
| `POST /api/google/sync` | `{ downloaded, uploaded }` |
| `POST /api/google/disconnect` | Revokes access and forgets the token |

## Conversation files

Chats keep their files in `~/.kesher/outputs/<conversation id>`; code sessions use their project folder.

| Method & path | Description |
| --- | --- |
| `GET /api/conversations/:id/files` | `{ folder, files: { path, size, modifiedAt }[] }`, newest first (skips `node_modules`, `.git`, `build`) |
| `GET /api/conversations/:id/files/download?path=` | One file, as a download |
| `GET /api/conversations/:id/files/zip` | Everything as a ZIP |

## Downloads

| Method & path | Description |
| --- | --- |
| `GET /api/hub/search?q=&pipelineTag=&filter=&sort=&limit=` | Hugging Face search. `sort`: `trending`, `downloads`, `likes`, `created`, `modified`. Returns `{ repo, author, category, downloads, likes, gated, tags, createdAt, lastModified, library, license, baseModel, parameters }[]` |
| `GET /api/hub/summary?repo=` | `{ summary }`: the first paragraphs of the model card, as plain text |
| `GET /api/hub/files?repo=` | Files in a repo: `{ path, size, sha256, url }[]` |
| `POST /api/downloads` | `{ repo, path, category }` — queues a download. Returns a `DownloadJob` |
| `GET /api/downloads` | All jobs |
| `POST /api/downloads/:id/retry` | Starts a failed or stopped download again, resuming where it stopped |
| `DELETE /api/downloads/:id` | Cancels (the partial file is kept for resuming) |
| `GET /api/downloads/events` | SSE stream of `DownloadJob` updates |

`DownloadJob`: `{ id, label, url, dest, status: queued|downloading|verifying|done|failed|cancelled, received, total, speed, error }`.

## OpenAI-compatible API

For tools that already speak OpenAI (LobeHub, OpenCode, Continue, the OpenAI SDKs). Model names are KesherAI model ids.

| Method & path | Description |
| --- | --- |
| `GET /v1/models` | Chat models in OpenAI's list format |
| `POST /v1/chat/completions` | Chat completions, with `stream: true` or without |

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:7420/v1", api_key="unused-locally")
reply = client.chat.completions.create(model="lmstudio/qwen3-14b", messages=[{"role": "user", "content": "Hi"}])
```

Tool calls, images in messages and embeddings are not supported on `/v1` yet.

## Versioning

Until 1.0, endpoints may change between minor versions; changes are listed in the release notes. After 1.0, breaking changes go under a new path prefix.
