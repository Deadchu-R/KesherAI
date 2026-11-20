# Work list (Roee and Claude)

The running list of what is being worked on, what is next and what waits on Roee. Claude keeps it up to date after
every task (and tells Roee in the chat what changed). Status: ✅ done · 🔨 in progress · ⬜ next · 👤 waits on Roee.
Longer-term plans are in [FUTURE_FEATURES.md](FUTURE_FEATURES.md); research in [RESEARCH_LOG.md](RESEARCH_LOG.md).

## Now (2026-11-19): research and code only, no new builds (Roee, 10:13)
- ✅ **Mark it and let the model work** (FUTURE_FEATURES), in all four editors:
  - ✅ Pictures: repaint the selection (earlier).
  - ✅ 3D: the "what to do with this part" box (earlier).
  - ✅ Video: ✦ With AI on the chosen clip: a picture from words, this shot in another look, or a video clip from words
    (through the chat; it goes in by itself at the clip's place and length). On main, not in a build yet.
  - ✅ Sound: ✦ With AI on the selection: music for it (through the chat; goes in by itself, cut and faded to the
    selection, under it or instead of it), or other words in a voice. On main, not in a build yet.
- ✅ The design doc: boards for ✦ With AI (video and sound) and the 3D picture / turntable buttons.
- ✅ Video: transitions between clips (Send to the chat → Between clips: dissolve, slide, wipe, circle, zoom, pixels,
  through white, fade to black; 0.3–1.2 s). Without overlap, so every time in the edit stays.
- ✅ Video: the transition shows in the player at each cut; "Between clips" is in the inspector (phone: ⚙ Clip).
- ✅ 3D turntable: its length (6, 12, 20 s) and size (the view's, or 1920×1080) from the 🎞 button's menu.
- ✅ Pictures: type text on the picture (a box by the words, the typing shows at once; Esc puts it back).
- ✅ Security scan 164: nothing to fix.
- ✅ The design doc: boards for transitions and typing text on the picture.
- ✅ Sound effects from words: Stable Audio 3 Small-SFX (ready flow, the chat's make_sound, and "A sound effect for
  it" in the sound editor). Not tried in ComfyUI on the PC yet (needs ComfyUI 0.22+ and a 3.5 GB download, with a yes).
- ✅ Fixed: ✦ With AI now finds the new song or video in the bank too (the chat keeps them there, not in its folder).
- ✅ Video: "continue this shot" (✦ With AI → Continue): the clip's last frame is set in motion through the chat's new
  animate_picture (Wan 2.2 5B), and goes in after it. Not run in ComfyUI on the PC yet.
- ✅ Video: a different transition at each cut (the clip's "Comes in with"; plain cut or any kind; seen in the player).
- ✅ Security scan 165: nothing to fix.

- ✅ 3D models with colours: TRELLIS.2 (MIT, native in ComfyUI 0.34+): the 3D editor's "A model from words, with
  colours" and "A model from a picture, with colours", and the chat's make_3d paints by default. The flow passed a real
  ComfyUI 0.46's validation in the workspace; not run with the real model (that needs the PC and a ~7.7 GB download).
- ✅ Paint an existing model (🖌 in the 3D editor): four views drawn by words (SD 1.5 + ControlNet depth) and baked onto
  it, with ComfyUI's own nodes; its geometry half ran in a real ComfyUI in the workspace.
- ✅ Security scan 166: nothing to fix.

- ✅ A study guide for a student friend (Roee, 11:50): a doc from installing to every study tool, only the study
  parts, with 17 real screenshots (desktop and phone) from 0.6.400 on a demo course.

- ✅ Helper agents (Roee, 12:39): docs/AGENT_BRIEF.md and .claude/agents (research, build); Claude leads,
  helpers research or build one task each and report back in 15 lines.
- ✅ A scene together for guests through share links (4d57785d). On main, not in a build yet.
- ✅ Sub-agents in the chat (2842e845): lead + research/build/lookup agents, a model each, strip, cards, Settings > Agents. On main, not in a build yet; the real model swap and Antigravity as an agent need a test on the PC.
- ✅ Research: helper agents inside KesherAI (lead + research/build/lookup helpers, a model per helper, GPU-aware).
- ✅ Research: a task inbox (Claude → git → KesherAI on the PC → Antigravity / local model → agy/* branch → Claude
  reviews). Roee (12:5x): Antigravity runs only when he presses Run, one at a time, for now; KesherAI may push
  only agy/* and the inbox branch. Defaults until he says otherwise: 10 Antigravity tasks a day, Gemini's default model.
- ✅ Naming (Roee, 13:20): in Hebrew they are "סוכנים" (lead: "סוכן ראשי"; "סוכן מחקר/בנייה/חיפוש"), not "עוזרים". Design doc boards renamed.
- 🔨 **Kesher Cloud hub** (Roee, 12:56): ✅ backend v1 (0d228a76); ✅ screens: the hub page, Settings > Kesher Cloud, Phone/Computer/Cloud (6254d9bc). ✅ Live at hub.roeetal.com (2026-11-19 18:40): Worker kesher-hub from main (root apps/hub, auto-deploys on push), secrets ALLOWED_EMAIL + GOOGLE_CLIENT_ID, Google sign-in works. ⬜ Pair the PC (needs a build with Settings > Kesher Cloud); ✅ Claude path set (scheduled task "Kesher hub (cloud)": API trigger only, KesherAI repo, no connectors; secrets CLAUDE_TRIGGER_ID + CLAUDE_FIRE_TOKEN). ⬜ In the app, Google sign-in in the embedded view shows a white page: hide it there and offer pairing by code / open the system browser.: a small KesherAI web app that is always on, open only to Roee's Google
  account. It knows which devices (PCs with KesherAI, the phone) and agents (Claude, Gemini/Antigravity, …) are
  on, connects them, and routes a task to a cloud tool when no device is on, so the PC need not stay on.
  Research first (Sonnet helper): hosting that is free or cheap, sign-in, how it reaches Claude only through his
  Max plan (e.g. Claude scheduled tasks / the task inbox in git) and Gemini (Jules?), security.
- ⬜ Roee (13:14): the hub at hub.roeetal.com (domain already on his Cloudflare). Later: anyone can host their
  own hub on their own site, set up from KesherAI (a plugin/setup wizard) — research before building. Roee (2026-11-20):
  a hub builder tool, quick and easy (FUTURE_FEATURES, "Hub builder").
- ⬜ Roee (13:14): the phone app's top-bar toggle Phone / Computer becomes Phone / Computer / Cloud (Cloud = the
  hub inside the app; works when the PC is off). Board PhoneWhereToggle; built with the hub screens.
- ⬜ Roee (13:16): the hub as a Claude custom connector (remote MCP on the same Worker, OAuth for his account):
  Claude stays the lead, the hub is its hands (devices, send a task to Antigravity / local model, results,
  approvals), all inside his Max plan. Research first (incl. how others do it), after hub v1.
- ⬜ Research Google's terms for unattended Antigravity in depth (Roee: "remember to check it in depth").
- ✅ Design doc: boards from the real screens (agents, hub).
- ✅ Task inbox (77169e22): Antigravity only on Roee's own Run, from the PC or the phone (one ask = one task, 30 min); push only agy/* and kesher-inbox. Needs a live test on the PC.
- ✅ Research: Google's terms for Antigravity (Run per task OK; unattended not on AI Pro; Jules/AI Studio key for that).
- ✅ The same Run ask for `@antigravity` in the chat agents (9327418a).
- ⏸ Paused (Roee, 14:40: near the weekly usage limit; resume when he has set up the hub): research on the hub as a Claude connector. Stopped at: reading Claude's custom-connector auth and tool-permission docs; nothing written to RESEARCH_LOG yet.
- 👤 Roee wants an update when the inbox is ready AND the hub site is live (needs his Google OAuth client + Cloudflare).
- ✅ Usage tracker: docs/usage (track.py + charts); re-run after each build.

## Next focus (Roee, 2026-11-20): finish the agents work, then focused usability (Gemini research in RESEARCH_LOG)
- ✅ Hub: why the PC showed Off (link never started at launch / after pairing; dead links) fixed; Claude's inbox tasks
  in the hub ("from Claude"); this chat's agents in the hub (tools/hub-report, group "Claude chat"). In 0.6.402.
- 👤 Roee: update the PC to 0.6.402, check it shows Online, turn on tasks + agent activity for it; approve the two inbox
  tasks (c-20261119-01 local, -02 Antigravity). Next chat: pair it with tools/hub-report (he approves the code).
- 👤 Chat 2 (2026-11-20): hub-report cannot reach hub.roeetal.com from this cloud session (proxy 403, host not on the
  session's network allowlist). Roee: add hub.roeetal.com to the Claude Code environment's allowed hosts, then pair.
  Inbox check 14:15: both tasks still without results/ and no agy/* branch (waiting on the PC at 0.6.402 + Run).
- 👤 Chat 3 (14:15): still 403 from the cloud (hub and Google's Gemini hosts); inbox unchanged since 2026-11-19 19:50.
- ✅ Gemini second-opinion guide (Roee's PDF): via the inbox until the hosts are allowed (GEMINI_RESEARCH.md).
- ✅ Usability gap list against the code (RESEARCH_LOG 2026-11-20; written by a parallel chat 2, which Roee closed: chat 3 continues).
- 🔨 Batch 1 server: cache_prompt + id_slot for llama.cpp, cached tokens in the usage event, stable tool order (Opus agent).
- ✅ Batch 1 server (cache_prompt, id_slot, cached tokens, stable tool order) and screens (token line under answers, cache in Context); fixed: Store apps counted as games paused the inbox.
- ✅ Design doc boards for the token line; 0.6.403 available.
- ⬜ PC Health: show the drive of each program/game; a 'move to another drive' for LM Studio / Ollama models (Roee's C: filled up).
- ⬜ Roee (14:33): the hub must show ALL his tasks and what every agent works on, from any device he signs in with (today: "Kept on this device, the hub keeps no tasks"). Research how others sync (sealed per-account store vs devices publishing sealed snapshots), keep end-to-end sealing; then design doc, then build. Include kesher-inbox tasks and live agents.
  ✅ Research (RESEARCH_LOG 2026-11-20, account key K, sealed records). Roee: inbox tasks show in full on every device; done tasks kept 90 days; recovery code: default at first setup (he asked what happens if everything resets: explained). 🔨 Steps 1-2 (shared seal module + hub records API) with an Opus agent., then the design doc, then batch builds.
- ⬜ Usability, in the research's order: (1) routing + KV cache + a visible token footer; (2) typed blocks in the chat
  (step accordion, live media card, inline zero-token actions, approval card, side canvas); (3) Unity core toolset at
  100% (reconnect after domain reload, main-thread queue, one Undo per turn, compile-fix loop); (4) ComfyUI → Unity
  end-to-end demo. First a gap list against what exists, then the design doc, then builds.

## Builds
- ✅ 0.6.397 and 0.6.398 are available in the app.
- ✅ 0.6.399 is available too.
- ✅ 0.6.400 is available (Roee, 11:16: "add the 2 things, then a build and stop"). Stopped after it.
- ✅ 0.6.402 is available (2026-11-20 ~13:55): the PC stays connected to the hub, inbox tasks and live agents in the hub.
- ✅ 0.6.401 is available (19:5x): chat sub-agents, Kesher Cloud (PC pairing), task inbox, Phone/Computer/Cloud, scene guests, AI in video and sound. Two tasks on kesher-inbox (c-20261119-01 local, -02 Antigravity).
- 🔨 Live agent tracking in the hub (Opus agent; on Roee's last usage credits, commits per step).

## Waiting on Roee 👤
- 👤 When convenient: 🖌 paint a model (ComfyUI 0.46+; asks before downloading SD 1.5 + ControlNet depth, ~2.8 GB).
- 👤 When convenient: a 3D model with colours (update ComfyUI to 0.34+; it asks before downloading TRELLIS.2, ~7.7 GB).
- 👤 When convenient: try the 3D editor's "A model from words" (ComfyUI; asks before downloading Hunyuan3D 2, ~4.9 GB).
- 👤 When convenient: try "continue this shot" (needs the Wan 2.2 5B flow in ComfyUI; it asks before downloading).
- 👤 When convenient: try sound effects (needs ComfyUI 0.22+; it asks before downloading 3.5 GB).
- 👤 Install 0.6.400 from the app and check (what to check is in the chat's "available" messages).
- 👤 The guest test from the phone (shared projects).
- 👤 A stronger model for writing chat reports.
- 👤 Unreal AutoShooter has no levels: noted only, not fixed (Roee's call).

## Next, from FUTURE_FEATURES (code only)
- ✅ Say on screen what loaded a model ("Loaded because: …" on the Models page and in the computer's details).
- ✅ A scene together (Unity Studio style): each person's colour chip, camera (a cone with the name) and selection,
  and follow their view; for this computer, the phone and paired devices. ⬜ Later: guests through share links.
- 👤 Open items that need Roee: Magic Tab (testing at the keyboard), the npm SDK (an npm account), Google sign-in for
  email invites, the Unreal levels bug (Roee: later).

## Later (agreed)
- ✅ A 3D model from words without the chat (＋ Add → A model from words: a picture, then Hunyuan3D 2 on the computer;
  the first time it asks before downloading the 3D model). Not run in ComfyUI on the PC yet.
