<div align="center">

# KesherAI

**One local-first home for every kind of AI model — chat, code, images, video and audio — that run on your own computer and work together.**

[עברית](README.he.md) · [Vision](docs/VISION.md) · [Architecture](docs/ARCHITECTURE.md) · [Plugins](docs/PLUGINS.md) · [API](docs/API.md) · [Contributing](CONTRIBUTING.md)

</div>

> **Status: v0.2.** Runs local models with no other app installed, a coding agent with approvals, projects and conversations with cloud-folder backup, active models per category, the phone app, in-app updates. MCP, video/audio and Pipelines are on the [roadmap](#roadmap).

## Why

Running AI locally today means juggling LM Studio for chat, ComfyUI for images, another tool for speech, a CLI for coding agents — each with its own model folder, its own UI and no way to pass work between them. KesherAI ("connection" in Hebrew) puts them under one roof:

- **Local first.** Everything works offline, with no account. Cloud APIs are optional.
- **Connect, don't reinvent.** KesherAI drives proven engines — llama.cpp, ComfyUI, Ollama, LM Studio, OpenCode — instead of rewriting them. Already use one of them? Connect it as a server and keep using it.
- **Every model in its category.** Chat, image, video, speech-to-text, text-to-speech, music, embeddings, 3D — and plugins can add more.
- **One server, many clients.** The core runs as a local server. The desktop window, your phone and any OpenAI-compatible tool are all clients of it.
- **Open for everyone.** Apache-2.0, documented code, a plugin API, and a codebase designed to be forked.

## Features

| | Today | Next |
| --- | --- | --- |
| Local engine | Built-in llama.cpp: downloaded automatically for your GPU (CUDA on NVIDIA, Vulkan otherwise, Metal on Mac). No LM Studio or Ollama needed | Managed ComfyUI for images and video |
| Models | "Start here" one-click models; Hugging Face search and downloads with SHA-256 checks; every model rated good / OK / slow / too big for your hardware, with expected times | Measured speed instead of estimates |
| Coding agent | Works in a project folder: lists, reads, searches, edits, runs commands. Three permission modes, dangerous commands always ask, diffs, undo, asks you questions | Plan mode, git checkpoints, LSP |
| Conversations | Projects with folders and instructions, conversation history, switch models mid-conversation | Search, document chat |
| Active models | Pick a model per category; the chat model calls the image model as a tool | Video, speech and music tools |
| Connections | LM Studio, Ollama, ComfyUI (auto-detected), any OpenAI-compatible server, OpenAI, Anthropic, OpenRouter, Groq | Jan, KoboldCpp, vLLM, LM Studio Bionic |
| Cloud backup | Mirror projects and conversations to a folder Google Drive, OneDrive or Dropbox syncs | Native Drive API |
| Phone | Android app (APK built by CI) and installable web app; QR pairing; approve agent actions from the phone | Push notifications, built-in TLS |
| Updates | Version shown in the app; check and install updates from Settings | Signed installers |
| Extensibility | Plugins (providers, categories, tools), `SKILL.md` skills, OpenAI-compatible API at `/v1` | MCP client and server, Pipelines |

See [docs/COMPETITORS.md](docs/COMPETITORS.md) for how this compares with other apps and the order we build in.

## Quick start

Requirements: **Node.js 22+** and **pnpm 10+** (`corepack enable`).

```bash
git clone https://github.com/Deadchu-R/KesherAI.git
cd KesherAI
pnpm install
pnpm build:packages
pnpm dev            # core server on :7420 + UI on http://localhost:5173
```

On Windows you can also double-click `start-kesherai.cmd`, which installs on first run and opens the interface in your browser.

Or the desktop app:

```bash
pnpm --filter @kesher/web build
pnpm dev:desktop
```

Then open **Models & downloads** and press **Download & run** on a model under "Start here": KesherAI installs its llama.cpp engine for your GPU, downloads the model and loads it. If LM Studio, Ollama or ComfyUI are running, KesherAI also finds them by itself under **Connections**.

### Use KesherAI from other tools

Any OpenAI client works. Model names are `<connection>/<model>`:

```bash
curl http://127.0.0.1:7420/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ollama/llama3.2:3b","messages":[{"role":"user","content":"Hi"}]}'
```

### Use it from your phone

Set `"remote": { "enabled": true }` in `~/.kesher/config.json` and restart. KesherAI then listens on your network and requires a token from other devices. Open **Settings → Phone** on the computer: scan the QR code with the phone, or copy the link into the [Android app](apps/android/README.md). Outside your home network, use [Tailscale](https://tailscale.com); do not expose the port to the internet. See [SECURITY.md](SECURITY.md).

## Repository layout

```
apps/
  desktop/        Electron shell: starts the core and shows the UI
  web/            React UI, used by the desktop window and by phones (installable PWA)
  android/        Android app (Capacitor) that connects to your computer
packages/
  shared/         types, schemas, branding.config.ts, features.config.ts
  providers/      the Provider interface + adapters (OpenAI-compatible, Anthropic, ComfyUI)
  downloads/      Hugging Face search, download queue, hardware detection
  plugin-sdk/     what plugins import
  skills/         SKILL.md loader
  agent/          the agent loop, code tools, permissions
  core/           the local HTTP server everything talks to
plugins/
  example-hello/  a plugin to copy
docs/             guides for contributors, plugin authors and forks
```

Each package has its own README explaining what it owns.

## Documentation

| Read this | If you want to |
| --- | --- |
| [docs/VISION.md](docs/VISION.md) | understand what KesherAI is meant to become |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | find your way around the code |
| [docs/PLUGINS.md](docs/PLUGINS.md) | write a plugin |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | connect a new engine, server or API |
| [docs/API.md](docs/API.md) | build a client or script against the core server |
| [docs/FORKING.md](docs/FORKING.md) | rebrand or trim KesherAI in your own fork |
| [docs/COMPETITORS.md](docs/COMPETITORS.md) | see what other apps do and what we build next |
| [docs/LEGAL.md](docs/LEGAL.md) | know which licences apply |
| [CONTRIBUTING.md](CONTRIBUTING.md) | send a pull request |

API reference generated from the code comments: `pnpm docs:api` (published to GitHub Pages by CI).

## Roadmap

0. **Foundations** — monorepo, core server, local chat, cloud APIs, OpenAI-compatible API. ✅
1. **Run without other apps** — built-in llama.cpp engine, one-click models, hardware ratings. ✅ (images: managed ComfyUI next)
2. **Code agent, conversations, projects** — tools, permissions, approvals, questions, undo, cloud-folder backup. ✅ (MCP next)
3. **Phone** — Android app, QR pairing, approvals from the phone. ✅ (notifications, TLS next)
4. **Video, audio & Pipelines** — video models, Whisper, TTS, a node editor connecting models.
5. **Community** — plugin marketplace, new categories, KesherAI as an MCP server.

The detailed, prioritised list is in [docs/COMPETITORS.md](docs/COMPETITORS.md#next-up-in-order).

## License

[Apache License 2.0](LICENSE). Use it, change it, ship it, fork it.
