# Core server API

Everything the KesherAI UI does goes through this HTTP API, so anything you build — a phone app, a script, a bot — can do the same.

- **Base URL:** `http://127.0.0.1:7420` (port from `config.json`).
- **Format:** JSON in and out. Errors are `{ "error": "message" }` with a 4xx/5xx status.
- **Streaming:** Server-Sent Events. Each event is one `data: <json>` line followed by a blank line.
- **Authentication:** none from the same computer. From other devices (when `remote.enabled` is on), send `Authorization: Bearer <token>`, or `?token=<token>` where headers are impossible (`<img>`, `EventSource`). Get the token from `GET /api/remote` on the computer itself.

The request and response types referenced below are exported from `@kesher/shared`.

## System

| Method & path | Description |
| --- | --- |
| `GET /api/health` | `{ ok, version, productName, features, remote: { enabled } }` |
| `GET /api/categories` | All categories (built-in and from plugins): `CategoryDefinition[]` |
| `GET /api/hardware` | `{ platform, cpu, ramTotal, ramFree, gpus[], unifiedMemory }` |
| `GET /api/remote` | Only from this computer. `{ enabled, token, port }` for pairing a device |
| `GET /api/plugins` | Plugins found, with `status` (`active`, `disabled`, `error`) and `error` |
| `GET /api/tools` | Tools registered by plugins: `{ name, description, inputSchema, pluginId }[]` |
| `POST /api/tools/:name` | Runs a tool. Body: the tool's input. Returns `{ result }` |
| `GET /api/skills` | Installed skills: `{ name, description, dir }[]` |
| `GET /api/skills/:name` | One skill with its `body` (the SKILL.md instructions) |

## Models and connections

| Method & path | Description |
| --- | --- |
| `GET /api/models` | `{ models: ModelInfo[], errors: { providerId, message }[] }` from every provider |
| `GET /api/models/local` | Files in KesherAI's models folder: `{ path, name, size }[]` |
| `GET /api/providers` | Connections, with `healthy`, `autodetected`, `capabilities`, `hasApiKey` (keys are never returned) |
| `GET /api/providers/presets` | Ready-made connections for the "Add" dialog |
| `GET /api/providers/types` | Provider types available (built-in and from plugins) |
| `POST /api/providers` | Adds or replaces a connection and saves it. Body: `ProviderConfig` |
| `DELETE /api/providers/:id` | Removes a connection |
| `GET /api/engines/llamacpp` | Managed llama-server status and recent log |
| `POST /api/engines/llamacpp/load` | `{ modelPath }` — starts llama-server with a GGUF from the models folder; its model appears under provider `llamacpp` |
| `POST /api/engines/llamacpp/stop` | Stops it |

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

## Downloads

| Method & path | Description |
| --- | --- |
| `GET /api/hub/search?q=&pipelineTag=&filter=` | Hugging Face search: `{ repo, category, downloads, likes, gated, tags }[]` |
| `GET /api/hub/files?repo=` | Files in a repo: `{ path, size, sha256, url }[]` |
| `POST /api/downloads` | `{ repo, path, category }` — queues a download. Returns a `DownloadJob` |
| `GET /api/downloads` | All jobs |
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
