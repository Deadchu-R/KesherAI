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
- 🔧 KesherAI as a model provider for Unreal and Unity AI: the OpenAI-compatible `/v1` endpoint exists; a guide and a check with each engine's assistant are missing
- ⬜ Depth and normals turned into styled frames (like Unreal Canvas)
- ✅ Music as a chat tool (make_music, ACE-Step 1.5 / XL)
- ✅ Known engine bugs checked before each build (known-issues.ts)

## Remote control and several computers
- ✅ Remote desktop: the computer's screen from the phone, PIN protected (remote-desktop.ts)
- ✅ A fixed outside address: own Cloudflare domain or Tailscale Funnel
- ✅ Choosing which computer runs a chat (model menu), and splitting work across computers (split_across_computers)
- ✅ Connecting from the laptop to the home PC (My devices)
- ✅ The computer's load in remote (CPU, RAM, cards, temperatures) with Terminate
- 🔧 Switching computers: the top bar's computer menu lists them and opens each in its own window; a visible tabs strip (and on the phone) is missing

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
- ⬜ A project index (fast search over assets, scripts, Blueprints) for token efficiency

## Code
- ✅ The editor is Monaco (VS Code's own editor)
- ✅ Library store for languages and engines
- ✅ Gemini through the user's own subscription (sign-in)
- ⬜ SSH and WSL targets
- 👤 DeepSeek V4-Flash test (board t59; downloading on the PC)

## Models and hardware
- ✅ Training picture LoRAs from the interface
- ⬜ Training a chat model (LoRA/QLoRA on own texts) and a voice
- ✅ Game helper over a running game
- ✅ ROG Ally: controller hints, rumble when an answer is ready, an on-screen keyboard
- ⬜ A check on a real controller after each interface change (C6)
- ✅ Graphics card guard (temperature limit, unloading, low priority); ✅ a second, small side model
- ⬜ A CPU and RAM limit for KesherAI's own engines
- ✅ Heavy data on the 4 TB drive: the models folder and the self-work copies' folder can be chosen, and the models already there move over in the background
- ⬜ As-you-type suggestions in any app (Magic Tab), needs a small model always loaded
- ⬜ Phone build targets chosen by phone model (OnePlus, Samsung…) for Unity, Unreal and web builds

## Content and import
- ✅ WhatsApp and Instagram chats imported, with the relationship-analyst persona (AskBrandon style)
- ⬜ Stremio plugin (watching patterns, recommendations, Letterboxd)

## Waiting on the owner 👤
- 👤 SignPath application and 2FA (signed installer)
- 👤 The extension in the Edge and Firefox stores
- 👤 OneDrive app ID
- 👤 Figma token
- 👤 Decide on the Chrome Web Store $5 fee
