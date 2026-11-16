# Future features

Features we wrote down for later, checked against the code on 2026-11-16 (the first version of this list, written
from notes, had many items that already exist; they are marked ✅ here so the list stays honest).
Status: ⬜ to do · 🔧 partly there · ✅ already in KesherAI · 👤 waits on the owner.

## Game engines and creative tools
- ⬜ Godot support: an editor plugin (GDScript/C#) that sees scenes, nodes and scripts and changes them in words
- ⬜ UEFN / Verse (Fortnite) support and UE6 preparation (a Verse view of a Blueprint, then conversion)
- ⬜ Minecraft and Roblox modding
- ⬜ Fab search and install from the chat
- ✅ The installed Unreal plugins listed, built for another engine version (unreal-plugins.ts)
- ✅ KesherAI as a model provider for Unreal and Unity AI: a guide in Settings → For developers → API (Unity AI Gateway with Claude Code or Codex pointed at KesherAI; Unreal plugins with an OpenAI-compatible provider); KesherAI's Anthropic API answered a Claude Code style tool call on the PC. 👤 The check inside Unity AI itself needs a Unity AI Gateway seat
- ⬜ Depth and normals turned into styled frames (like Unreal Canvas)
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
- ⬜ Figma-like sharing and collaboration with other users (careful security review first)
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
- ✅ WSL targets: a project opened at \\wsl.localhost\<distro>\… runs its commands in that Linux distribution (wsl.exe -d … --cd …); ⬜ SSH targets
- 👤 DeepSeek V4-Flash test (board t59; downloading on the PC)

## Models and hardware
- ✅ Training picture LoRAs from the interface
- ⬜ Training a chat model (LoRA/QLoRA on own texts) and a voice
- ✅ Game helper over a running game
- ✅ ROG Ally: controller hints, rumble when an answer is ready, an on-screen keyboard
- ⬜ A check on a real controller after each interface change (C6)
- ✅ Graphics card guard (temperature limit, unloading, low priority); ✅ a second, small side model
- ✅ A CPU and RAM limit for KesherAI's own engines (Settings → Computer: off by default, with a one-tap suggestion of 85% memory and 80% processor)
- ✅ Heavy data on the 4 TB drive: the models folder and the self-work copies' folder can be chosen, and the models already there move over in the background
- ⬜ As-you-type suggestions in any app (Magic Tab), needs a small model always loaded
- ⬜ Phone build targets chosen by phone model (OnePlus, Samsung…) for Unity, Unreal and web builds

## Content and import
- ✅ WhatsApp and Instagram chats imported, with the relationship-analyst persona (AskBrandon style)
- ✅ Films for you (#/stremio): taste from a Letterboxd export and ratings in KesherAI, recommendations by the chat model matched on Stremio's catalogue (Cinemeta), and a Stremio addon row "KesherAI: for you" (its address holds a revocable app key). ⬜ Stremio's own watch history (Stremio gives addons no access to it)

## Waiting on the owner 👤
- 👤 SignPath application and 2FA (signed installer)
- 👤 The extension in the Edge and Firefox stores
- 👤 OneDrive app ID
- 👤 Figma token
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
