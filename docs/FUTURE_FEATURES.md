# Future features

Features we wrote down for later, checked against the code on 2026-11-16 (the first version of this list, written
from notes, had many items that already exist; they are marked ✅ here so the list stays honest).
Status: ⬜ to do · 🔧 partly there · ✅ already in KesherAI · 👤 waits on the owner.

## Game engines and creative tools
- ✅ Godot support (#/godot): the KesherAI Bridge addon (GDScript, works for C# projects), the chat sees and changes scenes, nodes and scripts as undo steps, runs the game and reads its log; checked in a real Godot 4.7.2 editor
- ✅ UEFN / Verse: the chat lists UEFN projects and reads and writes .verse devices in them (Blueprints read through the bridge can be written as Verse); 👤 building is in UEFN itself (Verse → Build Verse Code), not tried on the PC (no UEFN project there yet)
- ✅ Minecraft and Roblox modding (mod_new / mod_build: Fabric, NeoForge, Bedrock, Rojo; checked on the PC 2026-11-17)
- ✅ Fab search from the chat (0.6.32x, tested on the PC 2026-11-17: fab_search through KesherAI's own pane, its tab closes 2 min after; never buys). Was: no public Fab API. Roee, 2026-11-17: open fab.com in KesherAI's own browser pane behind the scenes (his signed-in session) and mirror it to him; KesherAI searches, reads and compares, he clicks "Add to library"; never buys
- ✅ The installed Unreal plugins listed, built for another engine version (unreal-plugins.ts)
- ✅ KesherAI as a model provider for Unreal and Unity AI: a guide in Settings → For developers → API (Unity AI Gateway with Claude Code or Codex pointed at KesherAI; Unreal plugins with an OpenAI-compatible provider); KesherAI's Anthropic API answered a Claude Code style tool call on the PC. 👤 The check inside Unity AI itself needs a Unity AI Gateway seat
- ✅ Depth and normals turned into styled frames (Nodes → ready flows: "A styled frame from the engine's depth and normals", ControlNet 1.1 depth + normals on SD 1.5; how to export the passes from Unreal and Unity). 🔧 Not yet run on the PC (the card was busy tonight)
- ✅ Music as a chat tool (make_music, ACE-Step 1.5 / XL)
- ✅ Known engine bugs checked before each build (known-issues.ts)

## Remote control and several computers
- ✅ Remote desktop: the computer's screen from the phone, PIN protected (remote-desktop.ts)
- ✅ A fixed outside address: own Cloudflare domain or Tailscale Funnel
- ✅ Choosing which computer runs a chat (model menu), and splitting work across computers (split_across_computers)
- ✅ Connecting from the laptop to the home PC (My devices)
- ✅ The computer's load in remote (CPU, RAM, cards, temperatures) with Terminate
- ✅ Switching computers: tabs in the top bar for the other computers (desktop app), each in its own window; on the phone, tabs at the top of the side menu

## Looks and personalization
- ✅ Change the design in words, pictures from the web, presets, full dark for HDR, the look synced between devices, reset to defaults
- ✅ Import a look from Figma (variables or styles) — needs the owner's Figma token to try
- 🔧 Figma-like sharing and collaboration: designed (docs/COLLABORATION.md), waiting for Roee's review before building; read-only chat links that expire already exist
- ✅ Reset to defaults and reinstall the latest version, from Settings

## Agents and automation
- ✅ Telegram bot with approval buttons
- ✅ Heartbeat routines (speak only when something needs you)
- ✅ "Learn to do X": the model writes a skill, shown before saving (learn_skill)
- ✅ Smart approvals: a reviewer for plain commands in auto-edit, and approvals for good or for a set time
- ✅ Pause on update and continue where it stopped (chats and self-work)
- ✅ Named, specialized agents; a background feature-research routine
- ✅ An interface check and speed check on every version (scripts/ui-check.mjs)
- ✅ A plugin's permissions, code and "checked or not" shown before install; a learned skill shown before it is saved
- ✅ A project index: code_map, find_symbol and find_assets (classes, functions, Unity/Unreal/Godot assets by name), cached by file time (KesherAI: 883 files in 0.4 s, again in 0.06 s)

## Code
- ✅ The editor is Monaco (VS Code's own editor)
- ✅ Library store for languages and engines
- ✅ Gemini through the user's own subscription (sign-in)
- ✅ WSL targets: a project opened at \\wsl.localhost\<distro>\… runs its commands in that Linux distribution (wsl.exe -d … --cd …); ✅ SSH targets (SSHFS-Win + Windows ssh; the New project dialog; checked on the PC 2026-11-17, no server to connect to yet)
- 👤 DeepSeek V4-Flash test (board t59; downloading on the PC)

## Models and hardware
- ✅ Tools suggest a better model when they start (Roee, 2026-11-18; built the same day as a 0–100 score per tool and computer, `@kesher/shared` model-fit, a line in Study, chat reports and Code): each tool (Study, chat reports, the code agent, pictures, voice…) knows what it needs (Hebrew, context length, vision, tool use, speed) and, when a model on the computer (or one to download) fits the job better than the one loaded, says so in one line with its size and "switch" / "keep"; it never switches by itself. Seen tonight: a 32K context was too small for long Hebrew reports, and Study is best with DictaLM.
- ✅ Training picture LoRAs from the interface
- ✅ Training a chat model (LoRA with unsloth on a dataset made from her chats and documents, Models → Training); ✅ a voice of her own (Models → Training: Chatterbox Multilingual, Hebrew too, from a 10–30 s clip kept only with consent); checked on the PC 2026-11-17: Hebrew WAV on the graphics card after the setuptools<81 fix; the engines moved to E:
- ✅ Game helper over a running game
- ✅ ROG Ally: controller hints, rumble when an answer is ready, an on-screen keyboard
- ⬜ A check on a real controller after each interface change (C6)
- ✅ Graphics card guard (temperature limit, unloading, low priority); ✅ a second, small side model
- ✅ A CPU and RAM limit for KesherAI's own engines (Settings → Computer: off by default, with a one-tap suggestion of 85% memory and 80% processor)
- ✅ Heavy data on the 4 TB drive: the models folder and the self-work copies' folder can be chosen, and the models already there move over in the background
- ⬜ As-you-type suggestions in any app (Magic Tab): designed (RESEARCH_LOG: UI Automation + a key hook + a small model), needs a native piece and testing at the keyboard
- ✅ Phone build targets chosen by phone model (Settings → For developers → Target phones; Unity and Unreal builds use them; a plugged-in phone is read by USB)

## Content and import
- ✅ WhatsApp and Instagram chats imported, with the relationship-analyst persona (AskBrandon style)
- ✅ Films for you (#/stremio): taste from a Letterboxd export and ratings in KesherAI, recommendations by the chat model matched on Stremio's catalogue (Cinemeta), and a Stremio addon row "KesherAI: for you" (its address holds a revocable app key). ✅ Stremio's own watch history (addons get no access; Roee chose both ways, built 2026-11-18): ✅ sign in to Stremio inside KesherAI (the password goes only to Stremio; the library's watched items, times and dates through api.strem.io datastoreGet), ✅ Trakt (Stremio's official Trakt integration scrobbles there; KesherAI reads Trakt's API with device-code sign-in; needs a Trakt app client id from Roee)
- ✅ MyAnimeList in Films for you (Roee, 2026-11-17; built: the export .xml/.gz or his public list by name with his Client ID, anime picks in their own Stremio row "KesherAI: anime for you"): taste from his MAL list (an export, or his public list by username through MAL's API v2 with a Client ID), like the Letterboxd import, so the Stremio addon "KesherAI: for you" also recommends anime (matched on Stremio's anime catalogues by title and year)

## Research to do
- ✅ A deep look at open-source projects (Roee, 2026-11-17; RESEARCH_LOG parts 1–2 and t134, and every gap it found is closed except 👤 publishing small board tasks as GitHub issues and 👤 the npm SDK): how the code, editing it, adding to it (plugins, forks, contributions) feels for users and for developers elsewhere (VS Code, Zed, Godot, Blender, Obsidian, ComfyUI, LobeHub, Open WebUI…), and how it feels in KesherAI: getting started, reading the code, CODE_GUIDE, plugin and skill authoring, forking, tests, the PR path; then a list of what to change, in the future list.
  - Part 1 done (RESEARCH_LOG): ✅ a plugin dev mode (development folders reload on save, Plugins → Development; `pnpm plugin:check`); ✅ the GitHub labels exist and CONTRIBUTING links them (2026-11-18); 👤 publishing small board tasks as issues (asks Roee first); ✅ a devcontainer and the 6 GB build note in CONTRIBUTING (2026-11-17); ✅ a safe development profile (`--data-dir`) in CONTRIBUTING (2026-11-17); ✅ hosted API docs (GitHub Pages workflow on every release, with a guard against personal paths; 2026-11-18). Part 2 done: ✅ undo per file in the run receipt (↶ on each file); ✅ per hunk (↶ on each change in Review, 2026-11-18); ✅ one review view of all a run's changes (Review, like Zed); ✅ follow the agent in the editor pane (👁 Follow in the workspace); per-change review stays the default.

## Waiting on the owner 👤
- 👤 SignPath application and 2FA (signed installer)
- 👤 The extension in the Edge and Firefox stores
- 👤 OneDrive app ID
- 👤 Figma token
- ✅ The heavy folder: engines, worker, unreal and outputs on E: (2026-11-17)
- 👤 Decide on the Chrome Web Store $5 fee

## Roee's choices for the night of 2026-11-16 (until 07:00)
Every addition is an optional component: he chooses whether to use it, and a clean option without it always exists.
- Allowed: new code dependencies, a Windows OpenSSH server (local only), installing dev tools (Godot, Java/Fabric, depth models, a small Magic Tab model), accounts already signed in (Epic, Stremio); no passwords, no purchases.
- Self-work may be paused for an install and resumed after, as long as it resumes cleanly.
- Study: a Hebrew-strong model chosen by Claude (DictaLM 3.0 24B), each course picks its model. Recordings: kept by default, with the choice to delete after a set time or never; ask the first time whether to change it.
- Godot: GDScript and C#. Minecraft: Java Fabric, Java NeoForge and Bedrock. Roblox: built without his account (he tests).
- Collaboration: a short-lived invite link, a link for read or edit, and long-term invites by email like Figma, with a page of who is approved, alerts on anything unusual, and a ban button.
- Voice training: tested on a free voice tonight. Chat training: files he picks, and his KesherAI chats (he picks which).
- Project index: AutoShooter (Unreal) and KesherAI. SSH/WSL: WSL on the PC. Magic Tab: Tab accepts. CPU/RAM limit: off, with a suggestion.
- Stremio: watch history, a Letterboxd CSV, and ratings in KesherAI. Depth frames: from Unreal/Unity screenshots.
- Computer tabs on the phone: at the top of the side menu. Unreal and Unity AI with KesherAI as the provider: tested on a test project.
- Phone build targets: up to the APK; installing on the phone waits for the weekend (no cable).
- Morning report at 07:00, here in the chat.
- Study model switch: when a student asks while the code model is loaded, switch automatically once chats and self-work are idle, then switch back.
- Recordings move to the computer on sync (kept on the phone until then), playable from both.
- If something breaks tonight: fix it first without waiting; go back to the previous version only if there is no other way.
- Self-work: new rounds of small tasks all night, while watching the computer's health (temperatures, memory).

## The chat at Claude/Gemini level (Roee, 2026-11-17; designs in the design doc, RESEARCH_LOG)
- ✅ 1. The answer shows what the model made (images, video, music, file cards) and math, Mermaid, quotes, inline images, copy/run on code, link cards
- ✅ 2. "+" like Gemini/ChatGPT: one "Files" that reads any type (Whisper for audio and video, a few video frames, code files, OCR)
- ✅ 3. The model team: a small translation model (TranslateGemma 4B) for the answer's prose, the other-alphabets bias, reply-language settings (chat / code); a coding brain that fits the card (Qwen 3.8 27B or Gemma 4 31B, test both) 👤 downloads
- ✅ 4. Artifacts in a side panel (sandboxed)
- ✅ 5. A design canvas (frames, comments, export)

## Students, still missing (RESEARCH_LOG "Students, part 18", 2026-11-17)
- ✅ Moodle: courses, what is due and lecture files through the browser pane on her sign-in (built 2026-11-17, to check on the PC)
- ✅ My week: deadlines broken into steps and placed in her week, Google Calendar when connected (built 2026-11-17)
- ✅ A video overview of a lecture (narrated slides)
- ✅ A slide deck from her material: present in KesherAI, PDF, PPTX optional (2026-11-17)
- ✅ A writing coach on her own draft (never writes it for her) (2026-11-17)
- ✅ The course's sources with an APA 7 list (2026-11-17); ✅ Zotero import (BibTeX / RIS) and Chicago (2026-11-17)
- ✅ A mind map of a course or a topic (2026-11-17)
- ✅ Oral exam practice by voice (2026-11-17); ✅ presentation practice (rehearsal, 2026-11-17)
- ✅ Read-along for lectures from PDFs (2026-11-17); ✅ OCR for scans (scanned PDFs, 2026-11-17)
- ✅ Comparison tables (2026-11-17); ✅ open as a sheet (2026-11-17)
- ✅ A YouTube lecture as a lecture
- ✅ Teach-back (Feynman)
- ✅ Mastery per topic, and a nudge when one drops
- ✅ Graphs of functions with sliders; ✅ another way to solve (homework, 2026-11-17)
- ✅ Save a page or a selection from the browser to a course
- ✅ A study game: match terms to meanings against the clock
- ✅ A guided first setup of Study in four explained steps, and a Getting started list (computer, remote, phone alone; students part 38, 2026-11-17)
- ✅ Back on track after days off: a backlog cleared a little each day with an end date (computer and phone; students part 39, 2026-11-18)
- ✅ "This question is wrong" after a quiz: checked against the lecture, the key fixed or the question taken out, or her own answer marked right (computer and phone; students part 40, 2026-11-18)
- ✅ Attendance: "were you there?" after each class, per-course rules (N absences or N%) and what is left (computer and phone; students part 41, 2026-11-18)
- ✅ Ask the course by voice on the phone, and hear the answer (2026-11-18)
- ✅ On the phone alone too: explain it back, writing coach, My week, highlights, My mistakes, the 5-minute lesson, match, image cards from a photo (2026-11-17)

## Next after the students' list (Roee, 2026-11-17)
- ✅ Students part 27 (all eight): mock exam, grades and weighted average, timetable, fill-in-the-blank and confidence, reading with highlights, one-page sheet, questions during a recording (the video overview was already there).
- ✅ KesherAI's own document types on the canvas, like Claude's (Roee: "alternatives at the canvas level", as little dependence on PowerPoint/Word/Excel as possible): Slides (edit, present, PDF), Docs (editor, export), Sheets (a grid with formulas, CSV). The model fills them and she edits them herself. Slides first (a lecture's slides open there). Waiting for Roee to confirm this reading. — Slides, Docs (Pages joined in) and Sheets built (0.6.335–0.6.336). Import of PPTX/DOCX/XLSX and XLSX export are built (/api/import, the Excel button). Still open: Google Docs/Slides when connected.
- ✅ Screen lens (RESEARCH_LOG "Screen lens, part 1"): Ctrl+Alt+L on the screen under the cursor, ask / search / translate (drawn over the lines by Windows OCR) / summarize / copy text, continue in chat; the browser extension marks a part of the page; the phone with a screenshot (0.6.337). The phone's share sheet goes straight into the lens (a shared picture with explain / translate / summarize / text, on the phone alone, 2026-11-17). A circle (any scribble) marks the box around it (2026-11-17). Still open: the lens on the phone's own screen (Android overlay).

## Open source: easier to change and extend (RESEARCH_LOG "Open source for users and developers", 2026-11-17)
- ⬜ Publish `@kesher/plugin-sdk` to npm and a template repository, so a plugin lives in its own repo (like obsidian-sample-plugin).
- ✅ Settings → Plugins → "Load a folder (development)": runs a plugin from any folder, reloads it when its files change, shows a broken manifest (2026-11-17).
- ✅ `pnpm plugin:check <folder>`: the manifest, the permissions asked, the size, and one load in a test core, before publishing (2026-11-17).
- ✅ A 10-minute "your first change" walk-through in CONTRIBUTING.md (2026-11-17); ✅ "good first issue" and "help wanted" labels on GitHub, linked from CONTRIBUTING (2026-11-18).
