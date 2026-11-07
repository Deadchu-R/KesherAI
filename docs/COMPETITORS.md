# Competitors and how KesherAI does better

This is the list we build from. Every row names something another app does, where it falls short, and the upgrade KesherAI aims for. **Rule: we take ideas, never code** — several of these projects use licences (AGPL, proprietary) whose code we may not copy. See [LEGAL.md](LEGAL.md).

Last reviewed: November 2026. Status: ✅ done in KesherAI · 🟡 partly · ⬜ planned.

## Who is out there

| App | Licence / price | What it covers | Main gaps |
| --- | --- | --- | --- |
| [Locally Uncensored](https://github.com/PurpleDoubleD/locally-uncensored) | AGPL-3.0, free (optional paid cloud) | Chat, image and video through a managed ComfyUI, coding agent, MCP, detects 12 local engines, remote access with QR pairing, Android app | AGPL limits who can build on it; branded around "uncensored"; no documented plugin SDK or SKILL.md skills; no RTL/Hebrew |
| [Off Grid AI Desktop](https://getoffgridai.co/articles/off-grid-ai-desktop-the-only-fully-local-multimodal-ai-app-in-2026/) | Open source, free; paid Pro tier | Chat (bundled llama.cpp), vision, image generation, Whisper, Kokoro TTS, document chat, MCP connectors | No coding agent, no remote/phone access yet, macOS and Windows only |
| [Jan](https://jan.ai) | Apache-2.0, free | Chat with local and cloud models, agent mode, MCP connectors | No image, video or audio generation |
| AnythingLLM | MIT, free | Chat over documents, no-code agents, MCP, Android app | No media generation, no coding agent |
| LM Studio + Bionic | Proprietary, free | Best-in-class model downloads and local server; Bionic adds projects, file and shell tools, skills, checkpoints | Closed source; chat models only (no image/video); two separate apps |
| Open WebUI | Source-available | Self-hosted web chat for teams, plugins | A server to deploy, not a desktop app; no local engine management |
| LocalAI | MIT | One OpenAI-compatible server for text, image, audio | Server only; no friendly app |
| Msty | Proprietary, freemium | Polished chat, split chats, knowledge stacks | Closed; no media generation |

## Feature-by-feature

### Running models without other apps

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Bundled llama.cpp engine (Off Grid, Locally Uncensored) | One big GPU pack up front (Locally Uncensored downloads 7.5 GB for all GPU engines at once) | Download each engine only when first needed: chat on NVIDIA is ~680 MB (CUDA build + runtime), other GPUs ~38 MB (Vulkan) | ✅ |
| One-click model download (LM Studio) | Chat models only | Every category; "Start here" list that installs the engine, downloads and loads in one click | ✅ chat · ⬜ others |
| "Fits my hardware" badge (LM Studio, Locally Uncensored) | Yes/no only | Good / OK / slow / too big, plus expected time for a short answer, a long answer, reading a file and loading the model | ✅ |
| Guided first-run setup with a resource level (Off Grid: Conservative / Balanced / Extreme, models per category, total download) | — | Same levels, picked from our own speed estimate for this computer, separate coding-agent pick when the chat model is weak at tools; nothing downloads before you press the button | ✅ chat and code · ⬜ speech, read-aloud, embeddings, video |
| Disk-space check before a download (Locally Uncensored) | — | Same, and show it per file | ⬜ |
| Pause / resume / "skip for now" on big downloads (Locally Uncensored) | — | Resumable downloads exist; add pause and a skip button in the first-run flow | 🟡 |
| Use the app while a big download runs (Locally Uncensored) | — | Already true: downloads run in the background queue | ✅ |
| Detect existing engines (Locally Uncensored: 12) | — | LM Studio, LM Studio Bionic, Ollama, ComfyUI today; add Jan, KoboldCpp, vLLM | 🟡 |
| Measure real speed after a model runs | Nobody does it | Replace the estimate with measured words/second from the user's own runs | ⬜ |

### Coding agent

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Diff before applying, permission modes (Locally Uncensored, Bionic, Claude Code) | — | Three modes, a list of dangerous commands that always ask, "always allow" per session, a note to the agent when you deny | ✅ |
| Checkpoints (Bionic) | — | Undo of the last change now; git checkpoint per turn next | 🟡 |
| Project rules file (`.lurules`, `AGENTS.md`) | Each app invents its own name | Read the shared `AGENTS.md` (and `CLAUDE.md`), so one file works in every tool | ✅ |
| Plan mode (Locally Uncensored: Ask / Plan / Bypass) | — | A plan step the user approves before any edit | ⬜ |
| Repo map | — | Symbol index so small local models find code without reading everything | ⬜ |
| The agent asks questions | Most agents guess | `ask_user` with suggested answers, shown as buttons, also on the phone | ✅ |
| LSP diagnostics after edits (OpenCode) | — | Same, starting with TypeScript, C# and C++ | ⬜ |

### Conversations, projects, memory

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Projects with conversations (Bionic, Jan) | — | Projects carry a folder and instructions every conversation inherits | ✅ |
| Cloud backup | Usually needs the vendor's cloud and an account | Any synced folder (Google Drive for desktop, OneDrive, Dropbox), no account | ✅ |
| Google sign-in backup (Claude-style connector) | — | `drive.file` only: KesherAI sees just its own folder, never the rest of your Drive | ✅ Google · ⬜ OneDrive |
| Document chat with cited sources (Off Grid, AnythingLLM) | — | Same, using the active embedding model | ⬜ |
| Search across all conversations | — | Full-text search in the sidebar | ⬜ |

### Media

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Managed ComfyUI (Locally Uncensored) | — | Install ComfyUI as a separate program (it is GPL-3.0), download the PyTorch GPU build only on first image request | ⬜ |
| Chat model calls the image model | Separate screens in most apps | Active model per category; the chat model gets `generate_image` automatically | ✅ image · ⬜ video, speech, music |
| Whisper and TTS (Off Grid) | — | Same, as active models with tools (`transcribe`, `speak`) | ⬜ |
| Pipelines between models | Only ComfyUI, and only inside ComfyUI | Node editor across all categories; save a pipeline as a tool | ⬜ |

### Phone and remote

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| QR pairing (Locally Uncensored) | — | QR for every address, Tailscale first | ✅ |
| Android app (Locally Uncensored, AnythingLLM) | — | APK built by GitHub Actions on every change | ✅ |
| Approve agent actions from the phone | Rare | Same approval and question cards on the phone | ✅ |
| Cloudflare tunnel (Locally Uncensored) | Exposes the computer to the internet | Prefer Tailscale; built-in TLS before any public option | ⬜ |
| Wake the computer from the phone | Nobody does it | Wake-on-LAN button in the Android app, plus "keep awake while remote access is on" | ✅ |
| Push notification when a long job ends | — | Planned with the Android app | ⬜ |

### Openness

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Plugins (Locally Uncensored, Open WebUI) | Undocumented or app-specific | Documented SDK, manifest, example plugin, `pnpm create-plugin` | ✅ |
| Skills | Each app its own format | Standard `SKILL.md`, compatible with Claude Code, Codex and LobeHub | ✅ |
| OpenAI-compatible API (most) | — | Same, plus Anthropic-style later; Kesher as an MCP server next | 🟡 |
| Hebrew and RTL | None of them | Full Hebrew interface, RTL layout | ✅ |
| Updates inside the app (Locally Uncensored: signed updates) | — | Check and install from Settings today; signed installers later | 🟡 |

## Next up, in order

1. Managed ComfyUI with on-demand GPU download → images without any other app.
2. Measured speed replacing estimates; disk-space check; pause and skip on first-run downloads.
3. Plan mode and git checkpoints for the coding agent.
4. Whisper, TTS and embeddings as active models with tools, added to "Set it up for me".
5. More engine auto-detection (Jan, KoboldCpp, vLLM).
6. Conversation search and document chat.
7. Push notifications and built-in TLS for the phone.
