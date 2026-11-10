# Vision

KesherAI ("connection" in Hebrew) is an open-source desktop app that brings every kind of AI model — chat, code, images, video, audio and more — into one interface, runs them on your own computer, and lets them work together.

## Principles

Every decision is checked against these five:

1. **Local first.** Everything works without internet and without an account. Cloud is an add-on, never a requirement.
2. **Connect, don't reinvent.** KesherAI does not write its own diffusion or LLM engine. It manages and connects proven ones: llama.cpp, ComfyUI, whisper.cpp, Ollama, LM Studio and OpenCode.
3. **Everything open to the user.** Any external server can be connected, and any model can be placed in its category — from a download, a local file, a server or an API.
4. **One server, many clients.** The core engine runs as a local server (like OpenCode). The desktop app, the phone and the CLI are only its clients.
5. **Accessible and usable.** Permissive open-source licence, an interface in English and Hebrew with RTL support, one-click install.

## Model categories

Every model is registered with a category, a provider and capabilities. The category decides which screen it appears on and which tool it exposes to other models.

| Category | Example models | Default local engine | External sources |
| --- | --- | --- | --- |
| Chat & code | Qwen, Llama, Gemma, DeepSeek, gpt-oss | llama.cpp (GGUF), MLX on Mac | Ollama, LM Studio, OpenAI, Anthropic, Google, OpenRouter |
| Images | Flux, SDXL, SD 3.5 | Managed ComfyUI | External ComfyUI, fal, Replicate |
| Video | Wan, LTX-Video, HunyuanVideo | Managed ComfyUI | fal, Replicate, cloud video providers |
| Speech to text | Whisper | whisper.cpp | OpenAI, Groq |
| Text to speech | Kokoro, Piper | Python sidecar | ElevenLabs, OpenAI |
| Music & SFX | Stable Audio Open, ACE-Step | Managed ComfyUI | Cloud providers |
| Embeddings | nomic-embed, bge | llama.cpp | OpenAI, Voyage |
| 3D and more | Hunyuan3D, TRELLIS | Managed ComfyUI | — |

Four ways to add a model to a category:

1. **Download inside the app** from Hugging Face — the category is set automatically from the repo's tags and `pipeline_tag`.
2. **A local file** (GGUF, safetensors) — drop it in and pick a category.
3. **An external server** — KesherAI reads the server's model list (`/v1/models`, or ComfyUI's `/object_info`) and assigns categories.
4. **A cloud API** — an API key, and the provider's models land in their categories.

New categories are declared by plugins, so the community can add model types without changing the core.

## External servers and APIs

Every source of models is a **provider** with the same interface: `listModels`, `capabilities`, and per-category operations (`chat`, `generateImage`, `generateVideo`, `speak`, `transcribe`). This is how the tools that inspired KesherAI plug in as servers — users never have to do everything inside KesherAI.

| Server or service | How it connects | What you get |
| --- | --- | --- |
| LM Studio | OpenAI-compatible API at `localhost:1234/v1` | Chat and embedding models already downloaded there |
| Ollama | API at `localhost:11434` | Chat models, and `pull` to download |
| ComfyUI | `POST /prompt` with an API-format workflow, progress over the `/ws` WebSocket, results from `/history` and `/view` (port 8188) | Image, video, audio and 3D, including custom nodes |
| OpenCode | `opencode serve` exposes an HTTP server with OpenAPI and an SDK | Coding-agent sessions driven from KesherAI |
| LobeHub | Import skills and MCP servers from its marketplace; LobeHub can also use KesherAI as an OpenAI-compatible provider | Skills, MCP and agents |
| Flux | Through ComfyUI (local) or cloud providers such as fal and Replicate | Image generation |
| Cloud providers | API key: OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, ElevenLabs, fal, Replicate | Every category |
| Any OpenAI-compatible server | Base URL + optional key | vLLM, LocalAI, TGI and similar |

**The reverse direction matters just as much:** KesherAI exposes an OpenAI-compatible API locally, so LobeHub, OpenCode, Continue or any other tool can use the models KesherAI manages.

## Model downloads

Like LM Studio, KesherAI hosts no models — it searches and downloads directly from Hugging Face, and can `pull` through Ollama. The difference: downloads cover every category, not only LLMs.

- **Search and discovery** through the Hugging Face Hub API, filtered by category, format (GGUF, safetensors, MLX), size and quantization.
- **"Fits my computer":** GPU, VRAM and RAM detection, and a memory estimate per file before downloading, shown as a green, yellow or red badge.
- **Reliable downloads:** HTTP `Range` requests, resume after disconnects, SHA-256 checks against the LFS metadata, a prioritised queue.
- **Right place automatically:** GGUF into KesherAI's models folder; checkpoints, LoRAs and VAEs into the matching ComfyUI folders.
- **Bundles:** "Flux Dev complete" downloads the UNet, text encoders, VAE and the workflow that uses them in one go.
- **Gated models:** an optional Hugging Face token for models that require accepting a licence.
- **Safety:** warnings for pickle files (`.ckpt`, `.bin`) and a preference for safetensors and GGUF.
- **Licences:** each model's licence is shown before download, because the user accepts it, not KesherAI.

## Code agent

A "Code" screen gives an agent in the style of Claude Code that works on a project folder, with any chat model that supports tool calling — local or cloud.

- **Built-in tools:** read, write and edit files, `glob`, `grep`, run terminal commands, web search, a todo list.
- **Permissions:** three modes — ask before every change, auto-approve edits, and fully automatic inside the folder only. Dangerous commands always need approval.
- **Diffs and undo:** every change is shown as a diff, and KesherAI takes a git checkpoint before each step.
- **Project context:** reads `AGENTS.md` (and `CLAUDE.md` for compatibility) and supports `@` file mentions.
- **Sub-agents and mixed models:** a large model plans, a small local model handles simple tasks.
- **Alternative engine:** sessions can run through an OpenCode server, shown in the same interface.
- **LSP (later):** diagnostics after edits, like OpenCode.

## Skills and MCP

KesherAI uses the existing open formats, so skills and MCP servers from LobeHub, Claude Code and Codex work without conversion.

- **Skills** — a folder with a `SKILL.md` (frontmatter with `name` and `description`, then instructions and helper files). Only descriptions go into context; the full skill loads when the model picks it. Sources: `~/.kesher/skills`, the project folder, git or ZIP import, and LobeHub's skills marketplace.
- **MCP** — a full MCP client with `stdio` for local servers and Streamable HTTP (with OAuth) for remote ones. A graphical setup instead of JSON editing, plus import of an existing `mcp.json`.
- **KesherAI as an MCP server** — the core exposes model capabilities (`generate_image`, `transcribe`…) as MCP tools, so Claude Code, OpenCode or LobeHub can use your local models.
- **Security:** every MCP server and code-running skill needs approval at install, showing the command it will run.

## Models talking to each other

Two mechanisms share one Asset Store: every output — text, image, video or audio — gets an id, a type and metadata, and any model can take it as input.

1. **A chat model as conductor (automatic).** Every active category is exposed to the chat model as a tool. Ask "make a logo for the company and narrate a sentence over it", and the model calls `generate_image` then `speak`; the results appear in the conversation.
2. **Pipelines (manual, ComfyUI-style).** A node editor where each node is a model or an action. For example: chat writes a prompt → Flux makes an image → a video model animates it → TTS adds narration → ffmpeg joins it all.

A Pipeline is saved as a JSON file that can be shared, run from the phone, or exposed as a new tool to the chat model.

## Remote access from a phone

The phone connects to the same core server the desktop app uses, so all work — chat, image generation, coding sessions — runs on the computer, and the phone only sends prompts and sees results live.

- **Client:** a PWA served by the computer itself, built for mobile. No app store, no cloud server.
- **Pairing:** scanning a QR code on the computer creates a per-device token. Every device is listed and can be revoked.
- **Transport:** directly on the home network; outside it, Tailscale or WireGuard (recommended), or Cloudflare Tunnel for a public address. KesherAI runs no relay server of its own.
- **Security:** listens on `127.0.0.1` only by default; remote mode is opt-in, always with a token (TLS planned). Terminal commands and file edits sent from the phone need approval according to the permission mode, and every remote action is logged.
- **Notifications:** a message to the phone when a long job (video, download) finishes.

This is the lesson from OpenCode: network server mode must require a password, and localhost is the default.

## Documentation, plugins and forks

Any developer should be able to understand the code, write a plugin or fork the project without asking anyone. So documentation is part of the code, not a separate document that goes stale.

**In the code**

- Every public interface, type and function is documented in TSDoc: what it does, parameters, return value and an example. CI fails if a public export is undocumented.
- Every package under `packages/` starts with a short README: what it owns, what it exposes, and who it talks to.
- Shared zod schemas are the single source of every data shape; TypeScript types are derived from them.

**The `docs/` folder**

| File | For | What's in it |
| --- | --- | --- |
| `ARCHITECTURE.md` | every new developer | how the parts connect, a request end to end |
| `PLUGINS.md` | plugin authors | plugin structure, the manifest, the API, lifecycle, publishing |
| `PROVIDERS.md` | anyone connecting an engine or API | implementing `Provider` step by step |
| `API.md` | anyone building a client | the core server, streaming, authentication |
| `FORKING.md` | forks | rebranding, switching features off, staying in sync with upstream |
| `LEGAL.md` | everyone | licences of dependencies and models, what may and may not be copied |
| `CONTRIBUTING.md` | contributors | dev setup, code style, pull requests |

A documentation site is built from `docs/` and the TSDoc comments (TypeDoc) and published to GitHub Pages on every merge to `main`.

**Plugins** — a folder with `kesher-plugin.json` (id, version, permissions) and an entry module. Extension points: a new model provider, a new category, a Pipelines node, an agent tool, a UI screen, and packaged skills or MCP servers. `pnpm create-plugin` scaffolds a working plugin in one command, and an example plugin lives in the repo.

**Forks** — all branding (name, colours, URLs) lives in one file, `packages/shared/src/branding.config.ts`, and every large feature can be switched off in `packages/shared/src/features.config.ts`. A fork never needs to touch core code and can keep pulling upstream without conflicts.

## Roadmap

Phase 0 is the MVP: local chat that works after one install. Each phase opens only after the previous one passes its gate.

| Phase | Scope | Gate |
| --- | --- | --- |
| 0 · Foundations | Monorepo, core server, chat with llama.cpp, cloud providers, OpenAI-compatible API | Local chat works after a single install |
| 1 · Downloads & images | Hugging Face download manager, managed and external ComfyUI, Flux and SDXL | A Flux image from download to result, no terminal |
| 2 · Code agent, MCP & skills | Tools, permissions, diffs and checkpoints; MCP client; SKILL.md loading | The agent fixes a bug in a real repo with a local model |
| 3 · Remote access | Phone PWA, QR pairing, TLS and tokens, completion notifications | A prompt from the phone creates an image on the computer |
| 4 · Video, audio & Pipelines | Wan and LTX-Video, Whisper, TTS, node editor between models | — |
| 5 · Community | Plugin marketplace, new categories, KesherAI as an MCP server | — |

There are no dates: the pace depends on how many people join. Phases 3 and 4 can run in parallel if there are contributors.

**Status (v0.2):** phases 0–3 are in, except MCP, git checkpoints and managed ComfyUI. The prioritised list of what comes next, drawn from what other apps do, is in [COMPETITORS.md](COMPETITORS.md#next-up-in-order).

## Far-future plans (from Roee)

Not scheduled; kept here so they are not lost.

- **Game builds from KesherAI, in the background:** build Unity and Unreal games (Windows, Android, and the other targets each engine has) from the page, while the user keeps working: a queue, progress and logs, the finished build in the library, and a phone notification when it is done.
- **Copilot-style suggestions in the code editor:** while typing, a local model guesses the rest of the line or block and shows it greyed out; Tab inserts it (Monaco's inline completions, fed by a small fast coder model with the file and the cursor).
- **Minecraft modding:** tools for Fabric/Forge/NeoForge mods (project setup, building, running a test client).
- **Roblox:** Luau scripts and Roblox Studio (further out).
- **Game modding in general:** tools for modding other games.
- **No app is required, every app is welcome:** KesherAI should never depend on Ollama or LM Studio (or any one provider). They stay supported, but everything they do must also work without them: KesherAI's own engine runs the models (chat, code, embeddings, vision) and reuses model files already on the computer. The same goes for almost every provider: each is an option, never a requirement, and each has a built-in way to do the same job.
- **Stremio plugin:** a Stremio add-on that talks to KesherAI's local model. It learns what the user watches and likes (from Stremio's library and watch history, kept on this computer), recommends films and series to their taste, picks the stream quality and sources by how they watch (screen, connection, past choices), and links to Letterboxd (and services like it) to remind them to rate a film after watching.
- **Import from other apps:** chats from ChatGPT, Claude and Gemini exports already import (the format is read from the file itself, like LibreChat does). Still to come: settings, agents, personas, system prompts and presets from LM Studio (presets), Ollama (Modelfiles: system prompt and parameters), Open WebUI and LobeHub (agents/models with their prompts and knowledge), Jan (assistants and threads) and AnythingLLM (workspaces), plus MCP servers from Claude Desktop, Cursor and VS Code configs. A preview first, nothing overwritten without asking, originals left as they are.
- **Engine memory, visible:** show what llama.cpp's fit decided before loading (llama-fit-params: layers on the GPU, experts in system memory, context), let the user set how much VRAM to leave free (its fit margin, 1 GB by default) when a game or the Unreal/Unity editor shares the card, and warn when two models together will not fit.
- **Learn from past sessions to save tokens** (from Microsoft's TokenEconomizer, see docs/RESEARCH_LOG.md): project facts learned from repeated failures and given to every new chat or self-work run in that project; tools a project never uses left out of its requests (a visible list, one-click restore); a loop guard that notices the same check failing the same way after edits and sends one redirect note; tokens per finished item shown in self-work. Local models with small contexts gain the most.
- **Faster local agents** (research 2026-11-10): keep the prompt's beginning fixed so llama.cpp reuses its cache (and a chat stays on one slot); send local models only the tools that fit the request (chosen with the embedding model KesherAI already runs); symbol-level code tools from the language servers instead of whole-file reads; a terse-answer mode; cost (time and tokens) per finished item in self-work.
- **A near-frontier model at home: DeepSeek V4-Flash** (284B MoE, 13B active, up to 1M context; requested 2026-11-10). First as an experiment on today's PC (RTX 3090 24 GB + 96 GB RAM) with the 3-bit GGUF (about 103 GB, needs about 110 GB of RAM + VRAM): does KesherAI's engine load it (fit spreading experts into system memory), how fast it reads and writes, whether its tool calls work in code chats and self-work. Then, after a second 3090 and 128 GB of RAM (about 176 GB together), the 4-bit GGUF (about 155 GB) as the daily coder. Also needed: multi-GPU support checked end to end (fit across two cards, "fits my computer" counting both).
