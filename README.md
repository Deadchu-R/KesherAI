<div align="center">

# Kesher

**One local-first home for every kind of AI model — chat, code, images, video and audio — that run on your own computer and work together.**

[עברית](README.he.md) · [Vision](docs/VISION.md) · [Architecture](docs/ARCHITECTURE.md) · [Plugins](docs/PLUGINS.md) · [API](docs/API.md) · [Contributing](CONTRIBUTING.md)

</div>

> **Status: early (v0.1).** Chat, the in-app downloader, image generation through ComfyUI, the OpenAI-compatible API, remote access, skills and plugins work. The code agent, MCP, video/audio and Pipelines are on the [roadmap](#roadmap). Kesher is a working name.

## Why

Running AI locally today means juggling LM Studio for chat, ComfyUI for images, another tool for speech, a CLI for coding agents — each with its own model folder, its own UI and no way to pass work between them. Kesher ("connection" in Hebrew) puts them under one roof:

- **Local first.** Everything works offline, with no account. Cloud APIs are optional.
- **Connect, don't reinvent.** Kesher drives proven engines — llama.cpp, ComfyUI, Ollama, LM Studio, OpenCode — instead of rewriting them. Already use one of them? Connect it as a server and keep using it.
- **Every model in its category.** Chat, image, video, speech-to-text, text-to-speech, music, embeddings, 3D — and plugins can add more.
- **One server, many clients.** The core runs as a local server. The desktop window, your phone and any OpenAI-compatible tool are all clients of it.
- **Open for everyone.** Apache-2.0, documented code, a plugin API, and a codebase designed to be forked.

## Features

| | Today | Next |
| --- | --- | --- |
| Chat | Streaming chat with any OpenAI-compatible server (llama.cpp, LM Studio, Ollama, vLLM, OpenAI, OpenRouter, Groq…) and Anthropic | Tool calling between models |
| Downloads | Search Hugging Face from the app, resumable downloads with SHA-256 checks, hardware fit estimate | Bundles ("Flux Dev complete"), Ollama pull |
| Local engines | Starts llama.cpp's `llama-server` for downloaded GGUF files | Managed ComfyUI install, whisper.cpp, TTS |
| Images | Text-to-image through ComfyUI (default or your own exported workflow) | Cloud image APIs, inpainting |
| Interop | OpenAI-compatible API at `/v1`, so LobeHub, OpenCode or any SDK can use Kesher's models | Kesher as an MCP server |
| Remote | Use the UI from your phone with a pairing token | QR pairing, push notifications, built-in TLS |
| Extensibility | Plugins (providers, categories, tools), `SKILL.md` skills | MCP client, LobeHub marketplace import, Pipelines editor |
| Code | — | Code agent in the style of Claude Code, with permissions, diffs and checkpoints |

## Quick start

Requirements: **Node.js 22+** and **pnpm 10+** (`corepack enable`).

```bash
git clone https://github.com/Deadchu-R/kesher.git
cd kesher
pnpm install
pnpm build:packages
pnpm dev            # core server on :7420 + UI on http://localhost:5173
```

Or the desktop app:

```bash
pnpm --filter @kesher/web build
pnpm dev:desktop
```

Then open **Connections**. If LM Studio, Ollama or ComfyUI are running, Kesher has already found them. Otherwise add a cloud API, or go to **Models & downloads**, download a GGUF model and press **Load in llama.cpp** (set `engines.llamaServerPath` in `~/.kesher/config.json` to your `llama-server` binary first).

### Use Kesher from other tools

Any OpenAI client works. Model names are `<connection>/<model>`:

```bash
curl http://127.0.0.1:7420/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ollama/llama3.2:3b","messages":[{"role":"user","content":"Hi"}]}'
```

### Use it from your phone

Set `"remote": { "enabled": true }` in `~/.kesher/config.json` and restart. Kesher then listens on your network and requires a token from other devices. Get it with `curl http://127.0.0.1:7420/api/remote` on the computer, then open `http://<computer>:7420/?token=<token>` on the phone. Outside your home network, use [Tailscale](https://tailscale.com) or WireGuard; do not expose the port to the internet. See [SECURITY.md](SECURITY.md).

## Repository layout

```
apps/
  desktop/        Electron shell: starts the core and shows the UI
  web/            React UI, used by the desktop window and by phones
packages/
  shared/         types, schemas, branding.config.ts, features.config.ts
  providers/      the Provider interface + adapters (OpenAI-compatible, Anthropic, ComfyUI)
  downloads/      Hugging Face search, download queue, hardware detection
  plugin-sdk/     what plugins import
  skills/         SKILL.md loader
  core/           the local HTTP server everything talks to
plugins/
  example-hello/  a plugin to copy
docs/             guides for contributors, plugin authors and forks
```

Each package has its own README explaining what it owns.

## Documentation

| Read this | If you want to |
| --- | --- |
| [docs/VISION.md](docs/VISION.md) | understand what Kesher is meant to become |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | find your way around the code |
| [docs/PLUGINS.md](docs/PLUGINS.md) | write a plugin |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | connect a new engine, server or API |
| [docs/API.md](docs/API.md) | build a client or script against the core server |
| [docs/FORKING.md](docs/FORKING.md) | rebrand or trim Kesher in your own fork |
| [CONTRIBUTING.md](CONTRIBUTING.md) | send a pull request |

API reference generated from the code comments: `pnpm docs:api` (published to GitHub Pages by CI).

## Roadmap

0. **Foundations** — monorepo, core server, local chat, cloud APIs, OpenAI-compatible API. *(this release)*
1. **Downloads & images** — Hugging Face downloader, ComfyUI managed and external, Flux and SDXL.
2. **Code agent, MCP & skills** — tools, permissions, diffs and checkpoints; MCP client; skills in context.
3. **Remote** — phone PWA, QR pairing, TLS, notifications.
4. **Video, audio & Pipelines** — video models, Whisper, TTS, a node editor connecting models.
5. **Community** — plugin marketplace, new categories, Kesher as an MCP server.

Each phase has a gate it must pass before the next opens; see [docs/VISION.md](docs/VISION.md#roadmap).

## License

[Apache License 2.0](LICENSE). Use it, change it, ship it, fork it.
