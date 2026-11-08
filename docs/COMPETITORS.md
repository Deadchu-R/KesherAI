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
| Guided first-run setup with a resource level (Off Grid: Conservative / Balanced / Extreme, models per category, total download) | — | Same levels, picked from our own speed estimate for this computer, separate coding-agent pick when the chat model is weak at tools; nothing downloads before you press the button | ✅ chat, code, speech to text, embeddings · ⬜ video |
| Disk-space check before a download (Locally Uncensored) | — | Same, and show it per file | ✅ |
| Pause / resume / "skip for now" on big downloads (Locally Uncensored) | — | Pause and resume in the downloads circle (resumes from the part file) | ✅ |
| Use the app while a big download runs (Locally Uncensored) | — | Already true: downloads run in the background queue | ✅ |
| Detect existing engines (Locally Uncensored: 12) | — | LM Studio, LM Studio Bionic, Ollama, Jan, KoboldCpp, vLLM, text-generation-webui, GPT4All, LocalAI/llamafile, ComfyUI | ✅ |
| Choose the models folder, scan for models other apps downloaded (LM Studio: own folder only) | Each app re-downloads the same model | Scan LM Studio, Ollama (reads its manifests, so `llama3.2:3b` loads in our engine), Hugging Face cache, Jan, GPT4All, ComfyUI; use files in place, never copied | ✅ |
| Measure real speed after a model runs | Nobody does it | Replace the estimate with measured words/second from the user's own runs | ✅ |

### Coding agent

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Diff before applying, permission modes (Locally Uncensored, Bionic, Claude Code) | — | Three modes, a list of dangerous commands that always ask, "always allow" per session, a note to the agent when you deny | ✅ |
| Checkpoints (Bionic) | — | A checkpoint before every message in a separate git store; restore with one click | ✅ |
| Project rules file (`.lurules`, `AGENTS.md`) | Each app invents its own name | Read the shared `AGENTS.md` (and `CLAUDE.md`), so one file works in every tool | ✅ |
| Plan mode (Locally Uncensored: Ask / Plan / Bypass) | — | A plan step the user approves before any edit | ✅ |
| Repo map | — | Symbol index so small local models find code without reading everything (code_map) | ✅ |
| The agent asks questions | Most agents guess | `ask_user` with suggested answers, shown as buttons, also on the phone | ✅ |
| Diagnostics after edits (OpenCode) | — | check_code runs the project's own checker (tsc, dotnet, clang, cargo, go, python) | ✅ |

### Computer use

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| The model sees the screen and clicks and types (Off Grid "Computer Use", Claude) | Cloud-only, or a closed app | Local vision models (Qwen-VL, UI-TARS) through the built-in engine, or Claude / OpenAI computer-use APIs. You allow each app first; browsers and terminals get read-only or click-only access; a big Stop button and a hotkey; it never types passwords or payment details; every action is logged and can be replayed | ✅ |
| Drive it from the phone | — | Watch the screen and approve actions from the Android app | ⬜ |

### Conversations, projects, memory

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Projects with conversations (Bionic, Jan) | — | Projects carry a folder and instructions every conversation inherits | ✅ |
| Cloud backup | Usually needs the vendor's cloud and an account | Any synced folder (Google Drive for desktop, OneDrive, Dropbox), no account | ✅ |
| Google sign-in backup (Claude-style connector) | — | `drive.file` only: KesherAI sees just its own folder, never the rest of your Drive | ✅ Google · ⬜ OneDrive |
| Document chat with cited sources (Off Grid, AnythingLLM) | — | PDF and Word by page with page citations (also from Drive); a knowledge base over whole folders next | ✅ |
| Search across all conversations | — | Full-text search over conversations and the day journal (My day → Search) | ✅ |
| Second brain: Day, Replay, Reflect, Entities, Actions (Off Grid) | macOS-first; Search still "coming" | My day: opt-in screen journal kept on this computer (Windows OCR built in, no download), local model by default, skips password managers, private windows and sign-in/bank pages, delete the last 15 minutes or any day, unified search with conversations | ✅ Windows · 🟡 macOS/Linux (no OCR without tesseract) |
| Meeting notes (Off Grid) | — | Record a meeting in My day: microphone plus the call's sound (desktop loopback), transcribed every half minute by the speech engine, then summary, decisions and action items; the audio is not kept | ✅ |

### Media

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Built-in image engine (Off Grid, Locally Uncensored via ComfyUI) | A big Python/PyTorch install | stable-diffusion.cpp downloaded for your GPU on first use (no Python); Qwen-Image and Flux get their VAE and text encoders automatically; works from the chat | ✅ |
| Managed ComfyUI (Locally Uncensored) | — | Optional, for node workflows; install ComfyUI as a separate program (GPL-3.0) | ✅ |
| Chat model calls the image model | Separate screens in most apps | Active model per category; the chat model gets `generate_image` automatically | ✅ image, video, speech · ⬜ music |
| Whisper and TTS (Off Grid) | — | Same, as active models with tools (`transcribe`, `speak`) | ✅ |
| Pipelines between models | Only ComfyUI, and only inside ComfyUI | Node editor across all categories; save a pipeline as a tool | ✅ |

### Phone and remote

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| QR pairing (Locally Uncensored) | — | QR for every address, Tailscale first | ✅ |
| Android app (Locally Uncensored, AnythingLLM) | — | APK built by GitHub Actions on every change | ✅ |
| Approve agent actions from the phone | Rare | Same approval and question cards on the phone | ✅ |
| Cloudflare tunnel (Locally Uncensored) | Exposes the computer to the internet | Prefer Tailscale; built-in TLS before any public option | ✅ |
| Wake the computer from the phone | Nobody does it | Wake-on-LAN button in the Android app, plus "keep awake while remote access is on" | ✅ |
| Push notification when a long job ends | — | Planned with the Android app | ✅ |

### Openness

| Idea (who) | Their weak spot | KesherAI upgrade | Status |
| --- | --- | --- | --- |
| Plugins (Locally Uncensored, Open WebUI) | Undocumented or app-specific | Documented SDK, manifest, example plugin, `pnpm create-plugin` | ✅ |
| Skills | Each app its own format | Standard `SKILL.md`, compatible with Claude Code, Codex and LobeHub | ✅ |
| OpenAI-compatible API (most) | — | Same, plus Anthropic-style later; Kesher as an MCP server next | ✅ |
| Hebrew and RTL | None of them | Full Hebrew interface, RTL layout | ✅ |
| Updates inside the app (Locally Uncensored: signed updates) | — | Check and install from Settings today; signed installers later | 🟡 |

## Next up, in order

0. Category tabs on the Models screen, conversation search, integrations (MCP), and computer use with local vision models.

1. Managed ComfyUI with on-demand GPU download → images without any other app. ✅
2. Measured speed replacing estimates; disk-space check; pause and skip on first-run downloads. ✅
3. Plan mode and git checkpoints for the coding agent. ✅
4. Whisper, TTS and embeddings as active models with tools, added to "Set it up for me". ✅
5. More engine auto-detection (Jan, KoboldCpp, vLLM). ✅
6. Conversation search and document chat. ✅
7. Push notifications and built-in TLS for the phone. ✅ notifications · ⬜ TLS (future list)

## From the November 2026 review (Msty, LM Studio, AnythingLLM, Open WebUI)

Working on now, in this order:

1. Knowledge base over folders and web pages, kept up to date, with sources (AnythingLLM, Msty Knowledge Stacks) ✅ (Knowledge page, `search_knowledge` tool)
2. Personas: assistants with their own instructions, model, tools and knowledge (Msty, Open WebUI) ✅ (Personas page; instructions, model and knowledge base)
3. Conversation branches: edit an earlier message, compare branches (Msty Branch Explorer) ✅ (✎ edit and resend, ⑂ branch from a reply)
4. Prompt library with variables and `/` commands (Msty Prompts Studio) ✅ (Prompts page, `/` menu in every message box, `{{input}}`)
5. Context explorer: what the model sees now and how many tokens each part takes (Msty) ✅ ("Context" panel in every conversation)
6. Several chats at once on one local model (LM Studio 0.4 parallel requests) ✅ ("Chats at once" on the Models page; llama-server slots)
7. Phone notification when a long job on the computer finishes ✅ (Settings → Notifications, through ntfy)
8. Small fixes: disk space, pause, measured speed, more engines ✅
9. Speech as agent tools: transcribe and speak ✅ (`transcribe_audio`, `speak_text`)
10. KesherAI as an MCP server for other apps ✅ (`/mcp`, stdio bridge, Settings snippets)
11. Anthropic-style API and separate access keys per app (LM Studio permission tokens) ✅ (`/v1/messages`, `kai-` keys in Settings)
12. Community store for skills and prompts too (Msty Discover Hub) ✅ (Community → Prompts and personas, Skills; `use_skill`)
13. Control the computer from the phone: watch and approve ✅ ("Watch and approve" page, live screen, approvals pill)
14. Pipelines with loops and conditions (Msty Turnstiles), and managed ComfyUI ✅ (Pipelines page; ComfyUI installed and run from the Models page)

Later (priority to be decided):

- Built-in TLS for remote access ✅ (HTTPS through Tailscale); signed installers (needs a code-signing certificate) ⬜
- OneDrive backup ✅ (one-click cloud folders: OneDrive, Google Drive, Dropbox, iCloud)
- A command line (`kesher chat`) and a window-less server mode (LM Studio llmster) ✅ (docs/CLI.md)

## Second review, November 2026 (Off Grid AI Desktop 0.0.56, Locally Uncensored 3.0.6)

Working on now, in this order:

1. Routines: pipelines and prompts on a schedule, with a notification (Off Grid "Routines") ✅
2. Split chat: two to four panes on different models, one question to all (Off Grid) ✅ ("Compare models")
3. One search across chats, knowledge, "My day" and meetings (Off Grid unified search) ✅
4. Serving others: a request log per access key (tokens, model) and staying awake while serving (Off Grid Gateway, LU local API log) ✅
5. Engine updates: a newer llama.cpp without an app update (Off Grid) ✅
6. "Enhance prompt" before images and video (LU prompt rewriting) ✅
7. A download speed limit (LU) ✅ (the downloads circle, saved in config)
8. Voice conversation on the computer: talk, hear the answer, interrupt (LU voice, Off Grid hands-free) ✅ (the voice-wave button by the microphone)

Later (priority to be decided):

- Meetings: tell speakers apart ✅ (me and the others, from the microphone and the call apart), a chat about each meeting ✅; telling the people on the call apart ✅ (sherpa-onnx, pyannote segmentation + 3D-Speaker, on this computer; the call audio is kept only until the write-up); a transcript that follows playback ⬜
- Browser tasks through an extension, signed in where the user already is ✅ (apps/browser-extension; Settings → Your browser)
- Send a model from the computer to the phone ✅ (phone → On this phone → From your computer, over the network with resume)
- LoRAs on the Images page ✅ (find, choose with a strength, remove); batch image tools ✅ (remove background with ormbg in the window, 4× upscale with Real-ESRGAN, ZIP)

## Third review, November 2026 (OpenCode 2.2, LobeHub 2.2, LM Studio 0.4 and Bionic, Locally Uncensored 3.0.8, Off Grid AI, and phone apps)

The app stays free: nothing on this list needs a paid service. One list, in order of priority.

**1. The phone app**

1. Share to KesherAI from any app (text, links, images, files) ✅
2. A home-screen widget: new chat, talk, photo (Conduit, PocketPal) ✅
3. Voice call mode on the phone: talk and hear the answer, hands-free (Conduit, Layla) ✅ (with a computer; the phone's own recognizer and voice)
4. Find computers on the network by scanning, and pair with a QR code shown on the computer (Off Grid "Scan Network", LU QR pairing) ✅ (QR existed; scan + "Allow" on the computer with a matching code)
5. Watch and approve the agent's computer use from the phone ✅ ("Watch and approve" page with the live screen, Stop, and a notification when something waits)
6. Image generation on the phone itself (Layla: Stable Diffusion 1.5) ✅ (stable-diffusion.cpp built for Android; SD 1.5 Q4_0)

**2. Every kind of model on the computer, and downloading it**

7. One-click setup for video, like chat and speech ⬜
8. Kokoro text to speech on this computer: a natural local voice for answers and voice conversations (Off Grid) ⬜
9. Images: edit with a mask (inpainting) and image to image (LU, Off Grid) ⬜
10. Music generation, as a tool the chat can call (LU) ⬜
11. Hardware benchmark: tokens per second for each model on this computer (LU, PocketPal) ⬜

**3. High-importance features**

12. Personal memory you can see and edit (LobeHub, LU) ⬜
13. Long chats summarize their older part automatically (LU) ⬜
14. "Keep going until done": a goal checked by a reviewer pass before the agent stops (OpenCode `/goal`) ⬜
15. Agent Builder: describe an assistant in words, get a persona with tools and knowledge (LobeHub) ⬜
16. Import chats from ChatGPT, Claude and Gemini exports (LU) ⬜
17. Export a chat as Markdown or PDF (LM Studio) ⬜
18. Browser extension without the Chrome store: a package from Settings, and the free Edge and Firefox add-on stores ⬜
18a. Everything modular: a plugin can be a whole separate app inside KesherAI (its own pages and windows, its own files), that asks the local models for what it needs (chat, images, speech, vision) through a stable plugin API, and installs straight from the plugin store with one click ⬜
18b. The first official plugin, as the example for others: a Photoshop-like image editor (layers, brushes, selection, filters), with the local models inside it (generate into a layer, fill a selection, remove background, upscale) ⬜

**4. The rest**

19. Agent groups: several personas on one task (LobeHub) ⬜
20. Pages: a document written together with the agent (LobeHub) ⬜
21. A meeting transcript that follows playback (keeps the recording, as an option) ⬜
22. OneDrive sign-in, like Google ⬜
23. Signed Windows installer through SignPath (waiting for the application) ⬜
24. Chrome Web Store listing for the extension (a one-time $5 fee; only if it is worth it) ⬜
