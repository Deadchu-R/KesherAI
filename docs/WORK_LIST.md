# Work list (Roee and Claude)

Full backlog: see the 'Backlog:' sections at the end.

The running list of what is being worked on, what is next and what waits on Roee. Claude keeps it up to date after
every task (and tells Roee in the chat what changed). Status: ✅ done · 🔨 in progress · ⬜ next · 👤 waits on Roee.
Longer-term plans are in [FUTURE_FEATURES.md](FUTURE_FEATURES.md); research in [RESEARCH_LOG.md](RESEARCH_LOG.md).

## Priority order (Roee, 2026-11-20 19:36)
1. Agents (a lead + helper agents in KesherAI, like Claude's: models per helper, live status, results).
2. Everything works from a normal chat, like Claude: the chat shows everything and picks the right tools by itself (computer control, browser, showing and writing documents, code and more).
3. Game-engine work features that work well WITHOUT the engines open: good views, offline work, sync later, work remotely from the phone.
4. Everything else.

## Night 21–22.11 (Roee 19:21–19:58, until 07:00)
Rules (Roee 20:35: as many tasks as possible until 07:00): at most 2 Claude helpers (Sonnet by default, Opus only for hard code) running all night, plus ONE local agent on the PC (KesherAI self-work on the local model) kept busy with small items, research only on Antigravity/Gemini; a build about every 2 hours (security scan after every 5); the design doc published once at 07:00. Reversible decisions: the recommended option, marked in the morning report; irreversible ones wait for Roee. Approved downloads: Qwen3.5 2B router + Qwen3.6 mmproj (started 20:08).
Roee's answers for the night (21:20): ForMigration 4.27 → leave to the local model (t203); may open Unity and Unreal on the PC to check plugins/scenes (one project each, no saving in his projects, close after); plugin installs may write into the real projects' Plugins folder only (no level/code/asset changes); after the current items, in this order: D5 parallel download parts, A4 select text in a doc → "edit this", collaborators without engines (plan board + basic sync design, before the research), night builds of his game with a morning scorecard (build + smoke test + phone notification) — feature only, no real game build tonight; collaborators: plan board only, the sync channel is decided after the research.
Order (from the deep research c-20261121-38, RESEARCH_LOG 2026-11-21; S first):
- ✅ 0.6.437: research keeps going (safe read-only pipes, second prompt when no report); the deep research finished (32 steps).
- 🔨 Unreal without the editor: levels from .umap files (committed), then check opening a level on AutoShooter after the build; plugin 0.1.27 into the 5.4 projects once Roee's Unreal 5.4 download finishes (install-all).
- ✅ Unity: the project menu at the top of the Unity page lists every Unity project found on the PC (not only added ones); Boss Rush (waiting for Roee's screenshot of where it is missing).
- ✅ A2 (S): live turn line — elapsed, tok/s, "step 2/5: tool", waiting-for-approval badge (desktop + phone).
- ✅ A7 (S) (built e4665d9; measure on the PC still open): local speed — prompt-cache reuse between turns and n-gram prompt lookup in llama.cpp, measured on the PC before/after.
- ✅ A6 (S) (already existed: COMPACT_AT 0.8): context ring suggests compaction at 80%.
- ⬜ A6b (S/M): bidi pass — `<bdi>` around mixed runs, code/math LTR, logical CSS in chat, docs panel, tool cards.
- ✅ A1 (M): type while it answers — queue under the composer, Alt+Enter steers at the next tool step.
- ✅ A3 (M): declarative tool cards (name, short parameters, live state, structured result).
- ✅ B2 (M) (ba39551; plugin/package code not compiled yet): Play-mode VRAM standby — when Unity/Unreal enters Play, unload the local model, reload after.
- ⬜ Hub: verify the Run → "Starting…" fix after the hub deploy.
- ⬜ Morning report 07:00: done / decisions taken / waiting on Roee + design doc publish.
- ✅ Unreal install-all on 5.4 (plugin 0.1.30: reflection for the warning setting; retry/fresh folder; per-engine failure): the plugin did not compile for 5.4 (errors to read from the retry log), and every next project failed with EPERM unlinking HostProject/Intermediate/.../HostProjectModuleRules.dll in _built/5.4-0.1.27 (a build process still holding it): retry the removal with a short wait, or build into a fresh folder each time and keep the last good one.
- ✅ Downloads like Epic (D1–D8 except none left: a588765, 2d0460d, 8201ef8, e55a289, 5cdf3f8) (research c-20261121-41): D1 (S) phases + two meters (network / verify) + smoothed time left; D2 (S) headroom check and free space per drive before start; D3 (S) error cards with one fix button; D4 (M) full Downloads page with a reorderable queue (phone too); D5 (M) parallel range parts for big HF files; D6 (M) pause while a big model answers or the engine is in Play; D7 (S) phone push when a download ends/fails; D8 (M) Verify/repair.
- ⬜ Research (Roee 20:58, future): every Unity Muse / Unity AI tool (Chat, Sprite, Texture, Animate, Behavior, Generators, Sentis) and how to bring each into KesherAI — inbox task c-20261121-42 (free Gemini, runs after the quota reset); then plan tasks from it.
- 🔨 Unity scenes without Unity, full 2D (Roee 22:19): SpriteRenderer from sprite sheets (rects, pivot, tint, flip), sorting layer/order for draw order, Tilemaps, opens in 2D automatically, 2D moves via pending moves; plus UI canvases and prefab instances (ProjectBossRush GameScene showed nothing).
- 🔨 Editors open files from the computer, not only from chat (Roee 22.11 07:20): every editor (picture, sound, video, 3D/model) has Open / drag-and-drop / recent files from the PC (and from the phone in remote); 3D first: glTF/GLB, FBX, OBJ(+MTL), STL, PLY, USDZ, textures.
- 🔨 Editors pull assets from Unity and Unreal projects (Roee 22.11 07:20): "Open from project" in every editor; Unity assets read straight from Assets/ (models, textures, audio, prefabs as models); Unreal .uasset exported by the plugin headless (static/skeletal mesh → glTF, texture → PNG, sound → WAV) so they can be viewed and edited with the engine closed; save back into the project (Unity: write the file; Unreal: re-import through the plugin), with approval and a checkpoint.
- ⬜ Live co-editing of one scene, seeing each other (presence, cameras, selections, live moves, soft locks) — COLLAB_PLAN.md "Live co-editing"; research first (Unreal Multi-User, Figma, Roblox Team Create).
- ⬜ Research (Roee 22.11 07:21): other free cloud model APIs to connect like the free Gemini key (no card / cannot charge) — inbox c-20261122-08; then connect the best ones with automatic fallback within free limits.
- ⬜ Computer/browser control in the chat like Claude (Roee 22.11 07:23): screenshots inline between steps (small, tap to enlarge), and a ▸ triangle per turn that opens/closes "what the model is doing / did" — every step with its preview (screenshot crop, page title, file, result), live while running, collapsed when done. Control itself exists (computer.ts, ControlLive #/watch).
- ⬜ Antigravity queue asks before each next task (Roee 22.11 07:30): several Run taps put tasks in a queue, but after each one finishes the next does NOT start by itself — the phone/hub gets "Done: X. Next in line: Y — Start? / Skip / Clear the queue" and waits for his tap (also keeps "Antigravity only on his own press" per task). Today runNext() starts it automatically; change that.
- ⬜ Hub: accidental Run taps (Roee 22.11 07:25 — several tapped one after another by mistake): Run needs a deliberate action (hold 1 s or swipe, or a 5 s "Starting in 5… Undo" before it is sent), cards never jump under the finger after a tap (keep height, move the next card only after the undo window), a "Run all" button with a count for when he does want several, and old/superseded tasks closed automatically when Claude replaces them (skip with a note).
- ⬜ Collaborators without engines (Roee 20:31): a collaborator's KesherAI needs no Unity/Unreal/Godot at all. Only the main PC has the engine versions and plugins. Key project files (scenes/levels, scripts, data assets, pending moves) move between computers without engines; a collaborator works in the stand-ins and editors, syncs to the main PC, and the main PC applies the changes through the plugins (with Undo when the editor is open, headless when closed) and sends back the result (pictures, compile/play results). First: research how others do engine-less collaboration end to end (Unity Version Control/Plastic, Perforce + Unreal multi-user, Diversion, Anchorpoint, Godot's text scenes), then a plan board. PLAN WRITTEN 2026-11-21: docs/COLLAB_PLAN.md and design boards (collab.json); the channel (git or hub) waits for research c-20261121-39.
- Later from the report: highlight-to-edit popover in docs (A4), night builds + phone scorecard, drive janitor, Hebrew voice → engine code.

## Agents and chat-first (Roee 19:3x; gap list RESEARCH_LOG 2026-11-20)
- ✅ "Auto" chat model (Roee 2026-11-21): "✨ אוטומטי / Auto" first in the chat's model menu (chip "Auto · last pick"; picking a model turns it off), and "New chats start on Auto" in Settings › General. Per message: words + tool groups first, then a tiny JSON call to the small model beside (else the loaded main model, never a swap to route); policy: incognito never cloud, cloud only for kinds the user allows (default research), a picture → a model that sees, swap of the big local model only for a strong need (long Hebrew text / lyrics → DictaLM, multi-tool → Qwen), kept 3 turns per task; no swap while another chat uses the engine. Reason line above each reply ("Qwen3.6-27B — כלים", "· טוען את המודל (כ-16 שניות)", measured after the first load). Strengths per model (editable chips, family defaults) and the cloud kinds in Settings; router model Qwen3.5 2B recommended with one-click download+load beside (Settings and Models page). model-router.ts, auto-model.ts, conversations.ts, side-engine.ts (asker), routes/library.ts + engine.ts, ModelMenu.tsx, AutoModelSection.tsx. Boards AutoReasonLine, AutoModelMenu, AutoModelSettings (tools/design/scenarios/auto-model.json, not published). Research in RESEARCH_LOG 2026-11-21.
- ✅ Weak local model, five fixes (Roee's PC, DictaLM Thinking): no web_search for pure create requests ("תיצור לי תמונה/שיר": tool held back, and a query over 12 words or starting with a command verb is refused); invented links (download://, placeholder #/docs/) are taken out of answers and the prompt forbids inventing links, files or formats; the document tool has action "export" (pdf in the desktop app, docx, md) and returns a real file link; a local turn is capped at 8192 tokens and a cut-off turn is nudged once to answer briefly; documents follow the chat's language and ask_user is not for that. answer-links.ts, doc-export.ts, docs.ts, tool-router.ts, model-turn.ts, session.ts; note in RESEARCH_LOG.md.
- ✅ Song asked, pictures made (Roee's PC, DictaLM): a song/music/mp3 request (Hebrew and English: שיר, מנגינה, מוזיקה, אמפי3, mp3, track, beat) now routes to the audio group only (no web or images picks), with a line telling the model to call make_music; without make_music it says so and offers ComfyUI instead of drawing; generate_image refuses when the user's last message asks for music ("Not generated: the user asked for music; use make_music"). tool-router.ts, chat-tool-groups.ts, chat-tools-media.ts (ToolContext.lastUser).
- ✅ The shared task board on the hub (phone): the PC reports its board sealed to the user's own phones, on change only (open/taken/blocked items plus the last 20 done, metadata without details; offline phones get it when they come on). Tasks tab, Computer › Shared board: filters Open / Waiting on me / Done, owner chips (Claude / KesherAI / You), size, priority, the result line of done items, and Reopen, ↑ priority, give to the local model and a note, sent as sealed commands the PC applies through the board's own rules. Older PCs and hubs keep working (an older hub's refusal stops the reports on that link). Design boards HubBoard and HubBoardActions (tools/design/scenarios/hub-board.json, not published). hub-board.ts, hub-client.ts, task-board.ts (onChange), hub-protocol.ts, apps/hub/page/board.ts. The hub needs a deploy for the new `board` message kind.
- ✅ "The browser is too small": the browser pane starts at about 45% of a wide window (own remembered width, drag its edge, up to 80%), and an Expand button (⤢/⤡) gives it ~78% of the window with the chat narrow beside it; full screen on a phone. Boards BrowserWide, BrowserExpanded (tools/design/scenarios/browser.json).
- ✅ Hub: a task waiting for Run whose ask expired shows "Waiting for Run" with "Ask again" (new command inbox-ask, the PC asks "Run this?" once more) instead of "Not answering"; waiting for Run over 7 days also offers Cancel (Agents, Tasks and dashboard views).
- 👤✅ Decisions: a background helper continues where it stopped after a PC restart; helpers may use the browser and computer with Roee's approval per action (the approval card names the helper); documents open in a side panel in the chat.
- ✅ Open mind: a live progress card while it analyses (steps ticked, minutes read, ideas/tasks/questions found so far and the latest title, elapsed and time left; state from the server, survives leaving), works harder on noisy speech (implicit ideas, creative second pass, long transcripts in parts, never empty: summary plus inferred directions), and "Analyse again · depth N" (creative, small parts with Gemini flash when connected, then challenging its own result; earlier ideas kept). Design boards IdeasProgress* in tools/design/scenarios/ideas.json.
- ✅ Web search fallbacks (DuckDuckGo, DDG Lite, Mojeek, Bing; last good one first for 30 min), diagnostic GET /api/web/search-check (local only), and Gemini research writes no report when nothing was found (no invented sources). To test on the PC after the build: open /api/web/search-check.
- ✅ Web search that survives bot pages: every backend's hits are checked against the query (a page where most hits share too few query words, like Bing's random zhihu/baidu pages, counts as a bot page and the next backend is tried), new Yahoo, Startpage and Ecosia backends (order: duckduckgo, lite, yahoo, startpage, mojeek, ecosia, bing; their parsers are written from the known page shapes and not yet checked against live pages, so check /api/web/search-check on the PC), optional free Tavily and Brave Search keys in Settings > Web (used first, stored encrypted, never shown or logged; `/api/web-keys`), and the diagnostic shows `relevant: n` per backend.
- ✅ Default search engine in Settings > Web: "Automatic" or one backend (config `webEngine`), tried first with the others as fallback, the web_search result says which engine answered, each engine shows ✓/✗ from the last check with "Check now" (local only; the phone reads it; `/api/web-engine`). Design board WebSearchEngineKeys (tools/design/scenarios/web-search.json).
- ✅ Agents step 1: helper notifications, tokens and cost per helper, Usage line.
- ✅ Hub: Gemini (free) tasks with their own chip, group, status (waiting, running, deferred until the quota reset, done) and result; a "~N steps" estimate on every task (`estimateTaskSteps` in packages/shared/src/task-steps.ts, no model call) and "step X of ~N" while it runs, in the hub page and the PC inbox card; design board HubGeminiSteps.
- ✅ Agents step 2: persist helper runs, resume after restart, wake the lead when a background helper ends.
- ✅ Agents step 3: steer and continue a helper.
- ✅ Agents step 4: approval card naming the helper; helpers may use browser/computer/code with approvals; a test builder in the worktree.
- ✅ Agents step 5: plan card for multi-helper jobs; deep-research report as a document with sources.
- ✅ Chat step 6: one MediaView (audio/video/image) in tool cards, Download/Save chips, remembered chip with undo, browser thumbnail in steps.
- ✅ Chat step 7: documents as a side panel in the chat; artifact versions.
- ✅ Chat step 8: routing by meaning (Hebrew too), tool and connector toggles in the + menu.
- ✅ Research tasks in the task inbox (2026-11-21, no extra payment ever): `kind: research` (one report file, no check); big research to Antigravity with Run, small research automatic on the free Gemini key; no-payment guard (credit/upgrade/billing offers defer the task, the policy denies such steps).
- ✅ Design doc made by KesherAI (Roee 20:12): (1) shot scenarios as files in the repo (tools/design/scenarios/*.json: screen, size, mocked routes) + one script that renders every board with Playwright, no model needed; (2) a Design page in KesherAI (also phone/hub) that shows the boards from the repo, with the newest-change marker and comments; (3) sync: git is the single source; Claude's artifact is published from the same files by a script; KesherAI's self-work can run the script when the PC is on.
- ✅ Chat step 8b (Roee 19:38): when the chat wants a tool that is not installed, it says so and shows an "Install" button in the chat; the button opens a floating window with what it is, its size and where to save it (default the heavy-data drive), then installs and continues.
- ✅ Chat step 9: file reading in the + menu (audio, video, code), per-hunk accept/reject on helper diffs.

- ✅ Load on demand (Roee 2026-11-21): chat model, embeddings and ComfyUI start only when needed and unload after their own idle time (10/5/5 min, translator 5, "keep loaded" per engine) in Settings → computer; nothing heavy at start; never in the middle of work (gpu-guard idleDue, semantic.ts, start-engines.ts). sd.cpp already per job.
- ✅ Translator (Roee 2026-11-21, "מחולל תרגום"): translate.ts in core (loaded chat model → free Gemini flash → TranslateGemma 4B on demand); image/video/music prompts go out in English, "Prompt used" under the result; Translate page (#/translate) with one-click TranslateGemma download.
- ✅ Recording survives leaving the app (Roee 2026-11-21, "switching to a video stops the recording"): Open mind and Study record natively in the phone app's foreground service (notification with Pause/Stop; another app taking the mic pauses and resumes by itself, the gap is marked); elsewhere 5-second chunks into IndexedDB; "Resume" / "Finish" after a stop or reload (long-recorder.ts, rec-store.ts, LectureRecorder.java). Needs a new phone app build (APK on push to main).
- ✅ Automatic language detection for every speech-to-text path (Roee 2026-11-21): "My languages" in Settings › Speech, whisper language probabilities over 3 windows per 5-minute part restricted to them, script/garbage check with a retry, "Detected: …" line with "Transcribe again as …" on the mic button and in Open mind (lang-detect.ts, whisper.ts detectLanguages, speech-tools.ts; board SpeechMyLanguages) missing: Open mind has no "transcribe again" (the audio is deleted after reading); cloud STT keeps the app-language fallback

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
- ✅ Security scan 171 (0.6.420–0.6.424): research fetch kept off this computer and the home network, Unity scene reader memory cap, one translation-model download, unload re-check, command grants tied to the asked command; lows in SECURITY_REVIEW.md.

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
- ✅ **Kesher Cloud hub** (Roee, 12:56): ✅ backend v1 (0d228a76); ✅ screens: the hub page, Settings > Kesher Cloud, Phone/Computer/Cloud (6254d9bc). ✅ Live at hub.roeetal.com (2026-11-19 18:40): Worker kesher-hub from main (root apps/hub, auto-deploys on push), secrets ALLOWED_EMAIL + GOOGLE_CLIENT_ID, Google sign-in works. ✅ Pair the PC (0.6.401); ✅ Claude path set (scheduled task "Kesher hub (cloud)": API trigger only, KesherAI repo, no connectors; secrets CLAUDE_TRIGGER_ID + CLAUDE_FIRE_TOKEN). ✅ In the app, Google sign-in is hidden in the embedded view; pairing by code is the main action and "Open in the phone's browser" (de70c8f inWebView, inAppNote; checked 2026-11-21).: a small KesherAI web app that is always on, open only to Roee's Google
  account. It knows which devices (PCs with KesherAI, the phone) and agents (Claude, Gemini/Antigravity, …) are
  on, connects them, and routes a task to a cloud tool when no device is on, so the PC need not stay on.
  Research first (Sonnet helper): hosting that is free or cheap, sign-in, how it reaches Claude only through his
  Max plan (e.g. Claude scheduled tasks / the task inbox in git) and Gemini (Jules?), security.
- 🔨 Roee (13:14): the hub at hub.roeetal.com (domain already on his Cloudflare). Later: anyone can host their
  own hub on their own site, set up from KesherAI (a plugin/setup wizard) — research before building. Roee (2026-11-20):
  a hub builder tool, quick and easy (FUTURE_FEATURES, "Hub builder"). hub live (0.6.401); missing: the hub builder for self-hosting
- ✅ Roee (13:14): the phone app's top-bar toggle Phone / Computer becomes Phone / Computer / Cloud (Cloud = the
  hub inside the app; works when the PC is off). Board PhoneWhereToggle; built with the hub screens. (0.6.401)
- ✅ Roee (13:16): the hub as a Claude custom connector (remote MCP on the same Worker, OAuth for his account): (99a51d5 remote MCP at /mcp, OAuth for the owner only; 0e492d0 a5dc3de hardening)
  Claude stays the lead, the hub is its hands (devices, send a task to Antigravity / local model, results,
  approvals), all inside his Max plan. Research first (incl. how others do it), after hub v1. not built
- ✅ Research Google's terms for unattended Antigravity in depth (Roee: "remember to check it in depth"). (research done, see below)
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
- ✅ Roee: update the PC to 0.6.402, check it shows Online, turn on tasks + agent activity for it; approve the two inbox
  tasks (c-20261119-01 local, -02 Antigravity). Next chat: pair it with tools/hub-report (he approves the code).
- 👤 Chat 2 (2026-11-20): hub-report cannot reach hub.roeetal.com from this cloud session (proxy 403, host not on the
  session's network allowlist). Roee: add hub.roeetal.com to the Claude Code environment's allowed hosts, then pair.
  Inbox check 14:15: both tasks still without results/ and no agy/* branch (waiting on the PC at 0.6.402 + Run).
- 👤 Chat 3 (14:15): still 403 (hosts added to the environment 17:1x; works from the next chat) from the cloud (hub and Google's Gemini hosts); inbox unchanged since 2026-11-19 19:50.
- ✅ Gemini second-opinion guide (Roee's PDF): via the inbox until the hosts are allowed (GEMINI_RESEARCH.md).
- ✅ Usability gap list against the code (RESEARCH_LOG 2026-11-20; written by a parallel chat 2, which Roee closed: chat 3 continues).
- ✅ Batch 1 server: cache_prompt + id_slot for llama.cpp, cached tokens in the usage event, stable tool order (Opus agent).
- ✅ Batch 1 server (cache_prompt, id_slot, cached tokens, stable tool order) and screens (token line under answers, cache in Context); fixed: Store apps counted as games paused the inbox.
- ✅ Design doc boards for the token line; 0.6.403 available.
- ✅ PC Health duplicates: never offer files inside projects (Unreal Content, git repos, node_modules); it offered Unreal StarterContent .uasset copies (Roee's cleanup 15:35: only 2 safe copies removed).
- ✅ PC Health: show the drive of each program/game; a 'move to another drive' for LM Studio / Ollama models (Roee's C: filled up).
- ✅ Roee (14:33): the hub must show ALL his tasks and what every agent works on, from any device he signs in with (today: "Kept on this device, the hub keeps no tasks"). Research how others sync (sealed per-account store vs devices publishing sealed snapshots), keep end-to-end sealing; then design doc, then build. Include kesher-inbox tasks and live agents.
  ✅ Research (RESEARCH_LOG 2026-11-20, account key K, sealed records). Roee: inbox tasks show in full on every device; done tasks kept 90 days; recovery code: default at first setup (he asked what happens if everything resets: explained). ✅ Step 1 (shared seal module, 4396266). Roee (15:34): store the tasks in HIS Google Drive, fetched through the Google account on his devices and the hub; ✅ research (c1f9947: appDataFolder, create-only record files, K file in Drive). ✅ Steps 1-2 (record names + Drive store, d01aece). ✅ Steps 3-5 (PC side + Settings, hub page + phone, agent snapshots + sync ping). In 0.6.405 (3-4); 5 on main. 👤 Google Cloud: Drive API ✅, drive.appdata ✅, privacy page live (roeetal.com/KesherAI/privacy/), branding links filled; Roee saves Branding and publishes (Audience). 👤 Later (Roee 15:45, resting): Google Cloud setup (Drive API, drive.appdata scope, publish to In production), reconnect Google on PC and phone., then the design doc, then batch builds.
- ✅ 0.6.406 on the PC (Roee 18:xx); tasks sync connected (Drive OK, 0 tasks at 19:22, being checked). PC cleanup: LM Studio models moved to the E: drive, C: copy deleted; 20 compressed videos' originals binned and bin emptied (C: ~160 GB free).
- 👤 Run inbox tasks c-20261119-01, -02 and c-20261120-01 (Antigravity research: browser + computer control).
- ✅ Batch 2A: Unity core tools (compact hierarchy + inspect_object, modify_scene, import_sprite, create_pbr_material). (8ceab6c 94aa3af 25c1298 5392e12)
- 🔨 Usability, in the research's order: (1) routing + KV cache + a visible token footer; (2) typed blocks in the chat night run: typed blocks done (ccacb66 539cb4b 4fd5f94 035a5f2), token savers (e505b5d 3b55039 4c63277 15aaa9d); missing: re-check steps (3) and (4)
  (step accordion, live media card, inline zero-token actions, approval card, side canvas); (3) Unity core toolset at
  100% (reconnect after domain reload, main-thread queue, one Undo per turn, compile-fix loop); (4) ComfyUI → Unity
  end-to-end demo. First a gap list against what exists, then the design doc, then builds. (fc714f2 498e496 fb4b88d f13881b; 0.6.403) missing: inline actions, side canvas, ComfyUI-Unity demo

## Builds
- ✅ 0.6.397 and 0.6.398 are available in the app.
- ✅ 0.6.399 is available too.
- ✅ 0.6.400 is available (Roee, 11:16: "add the 2 things, then a build and stop"). Stopped after it.
- ✅ 0.6.404, 0.6.405, 0.6.406 available (PC Health project-safe cleanup + drive per program; Drive sync groundwork). Build 3 of 5 since scan 166.
- ✅ 0.6.403 is available (token/cache line, prompt cache).
- ✅ 0.6.402 is available (2026-11-20 ~13:55): the PC stays connected to the hub, inbox tasks and live agents in the hub.
- ✅ 0.6.401 is available (19:5x): chat sub-agents, Kesher Cloud (PC pairing), task inbox, Phone/Computer/Cloud, scene guests, AI in video and sound. Two tasks on kesher-inbox (c-20261119-01 local, -02 Antigravity).
- ✅ Live agent tracking in the hub (Opus agent; on Roee's last usage credits, commits per step).

## Roee (2026-11-20 17:12): add to KesherAI
- ✅ Browser control + debugging like Claude in Chrome, for the user's own Chrome (extension) AND KesherAI's built-in browser: open tabs, read the page as text/accessibility tree, click/type, console messages, network requests, run JS, screenshots/GIF; site permissions and the same safety rules (no passwords, ask before submitting). Research first (Claude in Chrome, Playwright MCP, Chrome DevTools MCP, browser-use). (480affc 201c542 295839f 2e6c0fa; extension store release held)
- 🔨 Computer control like Claude's computer use (screenshots, click/type, per-app access, tiers for browsers/terminals) and control of the computer's features (settings, files, apps) — through KesherAI, with approvals. Research first. missing: safety tiers and UIA tools not committed yet night run: phases 0-7 and vision done (480affc 201c542 295839f 2e6c0fa b0b2a5a 8184be2 9b98b80 c44b7fc); missing: computer control beyond Windows, extension 0.3.0 store release waits for Roee

## Waiting on Roee 👤
- 👤 When convenient: 🖌 paint a model (ComfyUI 0.46+; asks before downloading SD 1.5 + ControlNet depth, ~2.8 GB).
- 👤 When convenient: a 3D model with colours (update ComfyUI to 0.34+; it asks before downloading TRELLIS.2, ~7.7 GB).
- 👤 When convenient: try the 3D editor's "A model from words" (ComfyUI; asks before downloading Hunyuan3D 2, ~4.9 GB).
- 👤 When convenient: try "continue this shot" (needs the Wan 2.2 5B flow in ComfyUI; it asks before downloading).
- 👤 When convenient: try sound effects (needs ComfyUI 0.22+; it asks before downloading 3.5 GB).
- ✅ Install 0.6.400 from the app and check (what to check is in the chat's "available" messages).
- 👤 The guest test from the phone (shared projects).
- 👤 A stronger model for writing chat reports.
- 👤 Unreal AutoShooter has no levels: noted only, not fixed (Roee's call).

## Next, from FUTURE_FEATURES (code only)
- ✅ Say on screen what loaded a model ("Loaded because: …" on the Models page and in the computer's details).
- ✅ A scene together (Unity Studio style): each person's colour chip, camera (a cone with the name) and selection,
  and follow their view; for this computer, the phone and paired devices. ⬜ Later: guests through share links. (partly: 82a971a guests write in a shared chat; sign-in guests by share link not built)
- 👤 Open items that need Roee: Magic Tab (testing at the keyboard), the npm SDK (an npm account), Google sign-in for
  email invites, the Unreal levels bug (Roee: later).

## Later (agreed)
- ✅ A 3D model from words without the chat (＋ Add → A model from words: a picture, then Hunyuan3D 2 on the computer;
  the first time it asks before downloading the 3D model). Not run in ComfyUI on the PC yet.

## Full backlog (everything Roee asked for, 2026-11-20)
Every area below is its own `## Backlog:` section (one line per feature; ✅ = already in the code, with where).

## Backlog: Chat and UI
- ✅ Typed chat blocks: fold consecutive tool calls into one line ("7 steps"), like Claude's step list (in code: Activity.tsx ActivityGroup)
- ✅ Live progress and preview of a media job inside the chat bubble (4fd5f94 ComfyUI socket steps, preview frames, Cancel; checked 2026-11-21)
- ✅ Inline zero-token action buttons under a result (Import to Unity, Apply, 4 variations) (c7ae62b file chips) (ccacb66 4fd5f94)
- ✅ Side canvas for heavy results: images, PBR maps, code diffs (02094ed documents) (539cb4b)
- ✅ Unity and ComfyUI status chips in the composer of every chat, live when the Editor closes (f13881b Unity chip; 2ee1740 41a33bd ComfyUI chip in every chat, Unity chip in plain chats once in use)
- ✅ Approval card shows the diff or object list for Unity scene changes (e72dc60 helper hunks) (035a5f2)
- ✅ Router that picks tool groups and model size per turn; pin agent kinds to their own engine slots (fc714f2 tool groups; 15aaa9d model size per turn, slotKind main/helper/other via llamaCppFields; checked 2026-11-21)
- ✅ One shared chat component everywhere; the new-chat box on the main screen gets the same + menu (ComposerBar + useChatAttach in every box; 846a898 tools in this chat and approvals mode on the start screens)
- ✅ Rich + menu: files, camera, projects, devices, skills, memory and more (apps/web/src/AddMenu.tsx)
- ✅ Built-in slash commands /compact /fork /model /new /status /goal /side (FUTURE_FEATURES, built 2026-11-18)
- ✅ Reading aloud off by default, stop once started (Settings > Accessibility)
- ⬜ Full design refresh, desktop and phone: colour-coded, light, one unified menu on a shared base not built (docs/REDESIGN_PLAN.md)
- ✅ First-run welcome with tappable roles (developer, artist, student, ...) that pick the tools; tools in categories (in code: Welcome.tsx, roles.ts)
- 🔨 Apple-style menus (act on finger lift); long-press drag to reorder sidebar buttons; user shortcuts (SidebarEdit.tsx) missing: finger-lift menus, long-press drag
- ✅ Look changes: styles from words, web pictures, presets, full dark for HDR, synced look, reset (FUTURE_FEATURES)
- 🔨 Look: backgrounds, fonts, icons from the web, SteamOS-like ordering; AI restyle that never touches functions (appearance.ts, change_look) missing: icons from the web, SteamOS-like ordering
- ✅ Gamepad support with controller hints and on-screen keyboard (apps/web/src/gamepad.ts)
- ✅ Console mode with big buttons for the ROG Xbox Ally X, and a gaming AI helper in it (PadHints.tsx gamepad) (e480a7d)
- ✅ "Open mind": record a brain dump, sort it into prompts, research each idea (in code: ideas.ts)
- ✅ Hugging Face search filtered by what runs well on this computer, each result marked (huggingface.ts search) (dd2dae7 ddbf223)
- 🔨 Train models from the UI: pick the kind, show what is supported, plug the result into a category (TRAINING.md) missing: kinds beyond picture LoRA and chat model
- ✅ Import settings, agents, chats and personas from other apps; chats from ChatGPT, Claude and Gemini (in code: chat-import.ts, persona-import.ts, claude-code-import.ts)
- ✅ Setup guides for each part, kept as files in the repo (docs/UNITY.md, UNREAL.md ...) (3446d4a 4e6ab69)
- ✅ Queue messages while a chat is busy: editable chips, Send now, Stop clears the queue first (Jan 0.8) (in code: chat-queue.ts, chat/QueueChips.tsx)
- ✅ Steer mode: a message sent mid-run joins the running turn at the next tool step (setting: queue or steer; Cursor) (in code: session.ts injectSteers)
- ✅ Highlight-to-edit in documents and artifacts: select text, describe the change, only that span is rewritten, diff shown (Claude) (in code: shared/span-edit.ts, routes/span-edit.ts, SpanEdit.tsx)
- ✅ Version arrows ‹ n/m › on edited or regenerated messages, switching branches in place (Claude, ChatGPT) (in code: branch-versions.ts; regenerated answers already had them)
- ✅ Thinking picker for local reasoning models in the model menu: off, low, high (Open WebUI 0.12, LM Studio) (in code: thinking.ts, ModelMenu.tsx)
- ✅ Context ring in the composer from the last call's prompt size; offer /compact near the limit (in code: chat/ContextRing.tsx, budget.ts pinnedBefore)
- ✅ Turn status line and duration under a busy answer: running a tool, waiting for approval (Cursor) (in code: turn-status.ts, chat/TurnStatusLine.tsx)
- ✅ Shared chat mode Allow replies: guests write in the same thread, names, live streaming, typing (Open WebUI 0.12) (82a971a d701c61)
- ✅ Realtime voice hand-off: a small voice model talks, the chat's model works, approvals stay on screen (Open WebUI) (753829f f21401a)
- ✅ Memory topics view (edit or delete a topic) and an opt-in monthly recap card (Claude) (in code: shared/memory-topics.ts, memory-store.ts, pages/MemoryPage.tsx: search, merge, move, recap with Remove)
- ✅ Command palette lists chats and projects; /archive instead of delete; day separators in long chats (LM Studio) (in code: chat-archive.ts, pages/ArchivedPage.tsx, CommandPalette.tsx)

## Backlog: Game engines
- ✅ Unity: Test button that enters Play mode and reports result and console (in code: unity-test.ts)
- ✅ Unity: checkpoint and rollback before every agent edit (4c3f6da)
- ✅ Unity: reconnect after a domain reload; show "waiting for Unity" and retry the command (f13881b)
- ✅ Unity: one Undo group per chat turn (also for unity_command and script_eval) (498e496)
- ✅ Unity: compile-fix loop with at most 2 automatic fixes, errors returned as file, line, message (fb4b88d)
- ✅ Unity: create a new project through Unity's CLI without an existing one (packages/core/src/unity-cli.ts)
- ✅ Unity: embedded graphs and state graphs read and edited (integrations/unity/com.kesherai.bridge KesherGraph.cs)
- ✅ Unity Visual Scripting node editor that supports everything the engine does and syncs on open (d0153c0)
- ✅ Unity C# shown as visual nodes and translated back to code (in code: csharp-graph.ts, ScriptNodes.tsx)
- ✅ ComfyUI to Unity demo: one request becomes an imported PBR material on a selected object (45 s) (5392e12 PBR material) (df1de61)
- ✅ Tools for a seamless albedo plus normal, roughness and AO flow, and a UI-sprite flow (generate, remove background) (comfy-flows.ts, bg-remove.ts) (df1de61)
- ✅ Intent routing: "make a tileable wall texture" picks the PBR flow by itself (df1de61 flowIntent in tool-router.ts; checked 2026-11-21)
- 🔨 Unreal: Blueprint node editor that supports everything the engine does; the page works with Unreal closed (BlueprintCanvas.tsx, 5c302ab) missing: full node coverage, editing with Unreal closed
- ✅ Unreal: Test button that runs a Blueprint in Unreal, with gameplay input tests (MCP 5.9 toolsets) (blueprint-test.ts) (254b768)
- 🔨 Unreal: inspect_level and apply_material tools; profiling against the chosen target phones (c9be703 inspect_level and apply_material built; missing: profiling against the chosen target phones)
- 🔨 Unreal: code views for C++ and Verse; Blueprint to Verse; prepare for UE6 (cf6bace Source view, blueprint-code.ts) missing: UE6 preparation
- ⬜ Specialised engine agents: materials, Niagara and VFX, level design not built
- ✅ Unity package 0.2.12 installs on 2021.3, 2022.3 and Unity 6 (Pipeline and Visual Scripting parts by versionDefines; docs/UNITY.md)
- ✅ Unreal plugin 0.1.27: "Install in all projects" with each project's engine version and result; current ones skipped; 5.8+ MCP offer per project
- ✅ "Convert with AI" for an unsupported engine version or a compile failure: warning (he/en), a task-inbox task for Antigravity or the local model, a copy only, its own branch (engine-support.ts)
- ✅ Unity scene reader: streamed and fast (parallel cached GUID index, size/time guards, binary scenes explained), scenes outside Assets/Scenes, versions read from ProjectVersion.txt
- ✅ Unity: report a compile failure of the package back from Unity to offer "Convert with AI" (Unreal does this already)
- ✅ Install an AI-converted plugin copy (1b6a3a4) after review (the conversion task only makes the branch)
- ⬜ A Unity-like workspace inside KesherAI: code, animation, materials, Visual Scripting not built
- ✅ Draw on a screenshot from the phone and send it as a change request to the engine (Annotator.tsx) (fadc4d4)
- ⬜ Play a web build on the phone (UE 5.9 Web, Unity WASM64) not built
- ✅ Godot support: bridge addon, scenes, nodes, scripts, run and log (FUTURE_FEATURES)
- ✅ Minecraft and Roblox modding (mod_new, mod_build) and UEFN / Verse files (FUTURE_FEATURES)
- ✅ Fab search, installed Unreal plugins list and rebuild for another engine version (FUTURE_FEATURES)
- ✅ Phone build targets chosen by phone model, known engine bugs checked before builds (FUTURE_FEATURES)

## Backlog: Models and agents
- 🔨 Cache: fixed engine slot per agent kind, slot save and restore around ComfyUI VRAM use (15aaa9d router slot pinned, chat slot kept around heavy ComfyUI jobs; missing: a fixed slot for every agent kind)
- ✅ Findings-pack limit (200-400 tokens) for helper agent reports; per-turn cap of 4-6 loaded tools (3b55039 4c63277)
- ✅ Tool outputs pruned after 2 turns with a summary line and a pointer to the full output on disk (e505b5d)
- ✅ Calibrate the local engine to the computer (speed against accuracy); chats-at-once setting (in code: calibrate, ChatsAtOnce.tsx)
- 🔨 Download the right engine and models for the hardware (NVIDIA, Intel, AMD) automatically, no button (downloads/hardware.ts) missing: fully automatic, no button
- ⬜ Smart split of one task across connected computers by hardware; per-chat device choice; laptop gets no heavy work not built
- 🔨 Local model carries tasks during Claude's weekly cooldown, one after another without crashing (SelfWorkPanel.tsx) missing: automatic hand-over at Claude cooldown
- ⬜ Ideal local model: Hebrew and English, strong at code, many tools; code sessions answer in Hebrew not built
- ⬜ Test DeepSeek V4-Flash and tune Qwen 3.6-27B for the PC; goal is Claude-like quality locally not built
- 🔨 Microsoft Copilot connection for businesses, with an option to use only Copilot (copilot.ts, docs/COPILOT.md) missing: Copilot-only mode
- ⬜ Models talking to each other: multilingual model plus strong code model as a team not built
- ✅ Claude uses KesherAI more and more itself; a KesherAI connector so Claude can send it commands (McpServerSection.tsx) (99a51d5)
- 🔨 Long-term approvals in chats (for good or for a set time) in every flow, not only commands (agent/permissions.ts) missing: set-time grants in every flow
- ✅ Gemini through the user's Google subscription, Telegram approvals, named agents, heartbeat routines (FUTURE_FEATURES)
- ✅ Translation model in the team, reply-language settings (FUTURE_FEATURES, chat at Claude/Gemini level)

## Backlog: Devices, hub and phone
- ✅ Backup update source without GitHub (updates from the user's own computers); keep GitHub too (in code: updates-peer.test.ts)
- ✅ The phone (remote and hub page) gets a one-time "The PC was updated to X" card with the notes of every version since it last saw one, and a line when the phone app itself is behind (UpdatedCard.tsx, updated-notes.ts, hub page pc-updated.ts; the hub card has no notes: its content policy blocks GitHub)
- ⬜ Phone app redesign in the same design line; phone health screen; settings button while connected not built
- ✅ Phone approvals from the notification (2026-11-21): the hub's push shows the newest ask with two buttons — "▶ הפעל / לא עכשיו" for an Antigravity Run ask, "✓ אשר / דחה" for any other approval; a button sends the answer sealed from the phone to the PC (one answer, refused after expiry); a tap opens the ask's card. The PC seals the ask to the phone; the hub sees only the count. 👤 Roee: after the release, open the hub web app on the phone once (it loads the new service worker and the PCs' keys); notifications stay on, no re-subscribe. iPhone: no buttons, only the tap.
- 🔨 Notifications like any app, no ntfy and no cost, opening the right page (37a0a1b 6f91127 hub Web Push) missing: ntfy still used on the PC
- ⬜ A computer about to sleep tells the others; faster device discovery with status not built
- ✅ One Computers menu for the whole app (app menu and the top bar's computer panel, phone too): state, last seen, version, use for all chats, switch, disconnect (ComputersMenu.tsx, active-computer.ts)
- ✅ Pause running commands and tasks on restart, update or shutdown and resume where stopped, for all kinds (2e9a75f agents) (4c47834)
- ✅ Telegram bot with approval buttons (packages/core/src/telegram.ts)
- ✅ Remote desktop with a PIN, computer load view with Terminate, computer tabs (FUTURE_FEATURES)
- ✅ Fixed outside address by Cloudflare domain or Tailscale Funnel (FUTURE_FEATURES)

## Backlog: Editors and media
- ⬜ Picture editor to Photoshop and Affinity level: layers, masks, AI tools (research first) not built
- ⬜ 3D editor to Blender, Max and Maya level: all modifiers, rigging, animation (research first) not built
- ⬜ Sound editor with instruments, hum or whistle to instrument, mixing and effects at DAW level not built
- ⬜ Video editor to a pro level: keyframes, colour, titles, audio ducking not built
- ✅ Editors call each other ("Edit in…": texture to the picture editor, audio to the sound editor, picture to 3D when a tool exists) and offer to install a missing one, with a Return chip (apps/web/src/editor-handoff.ts, InstallWindow.tsx; board group "Editors")
- 🔨 Figma integration with careful security; share and collaborate like Figma (stages 2-3) (figma-umg.ts) missing: share and collaborate, stages 2-3
- ✅ Picture, video, sound and 3D editors opened from chat results as tabs, with Send to the chat (plugins/*-editor)
- ✅ Camera avatar page and lip-sync (apps/web/src/pages/AvatarCamera.tsx, packages/core/src/lipsync.ts)
- ✅ Asset bank of everything made, with Edit in... under each chat result (#/bank)

## Backlog: Study and personal tools
- ⬜ Study works fully on a phone alone and on weak laptops, including summaries and quizzes without a PC not built
- 🔨 A "Student" option in the welcome and a complete package to send to a student (roles.ts Student) missing: the package to send to a student
- ✅ Lecture recording, also from the phone (apps/web/src/StudyRecorder.tsx), summaries, quizzes, mock exams
- ✅ Moodle, My week, slides, writing coach, sources, mind maps, oral exam practice (FUTURE_FEATURES)
- ⬜ Study: visuals and practical help per lesson (keep refining with a real student's feedback) not built
- ✅ Relationship analysis with imports and an analyst persona; WhatsApp and Instagram import (FUTURE_FEATURES)
- ✅ Films for you: Stremio, Letterboxd and MyAnimeList taste (#/stremio)
- 🔨 Persona from AskBrandon-style analysis kept as a reusable persona (persona-research.ts) missing: reusable AskBrandon-style persona
- ✅ AI-based PC Health, screen lens (Ctrl+Alt+L), personal knowledge tools (FUTURE_FEATURES)

## Backlog: Platform, security and tests
- ⬜ Publish @kesher/plugin-sdk to npm with a template repository (needs an npm account) waits on an npm account
- ⬜ Plugin store with install from the app; clear plugin and fork docs for developers not built
- ⬜ Fully modular parts; no single provider needed; less dependence on Ollama and LM Studio over time not built
- ⬜ Automated test system per version: it works and has no security holes not built
- 🔨 Full security review and performance pass after every 5 builds (running rule) (460279e scan 168) missing: next scan after 5 builds (scans 169 79c3dbc, 170 b606675 and 171 done after 460279e; next scan after 5 more builds)
- 🔨 Hardware limits in the UI: RAM and CPU caps, CPU temperature (gpu-guard.ts) missing: RAM and CPU caps, CPU temperature
- 🔨 Reset to defaults and a reinstall option checked on every platform (ResetSection.tsx) missing: reinstall check on every platform
- ✅ Project index: faster search over assets, scripts and Blueprints for big projects (bcbe818 5c302ab e7c3278)
- ⬜ Browser extension in the Edge and Firefox stores, self-updating not built
- ⬜ Landing page roeetal.com/KesherAI in the app's design, with API docs under it not built
- ✅ Plugin dev mode, pnpm plugin:check, CONTRIBUTING walk-through (FUTURE_FEATURES)
- ✅ Project index: code_map, find_symbol, find_assets cached by file time (FUTURE_FEATURES)

## Backlog: Far future
- ⬜ Remote control of the computer with several monitors, as a plugin (like Google Remote Desktop) not built
- ⬜ Anyone can host their own hub from KesherAI's hub builder, after the builder exists not built
- ⬜ Live avatar instead of the camera in video calls, with a warning to the user not built
- ⬜ Approvals from a Wear OS watch not built
- ⬜ Paid models fully supported for other users (not needed for himself) not built

### Roee's answers for the night of 2026-11-20 (22:46)
- Downloads for browser/computer control (local vision model, Playwright browser etc.): allowed to drive E, no size limit, official sources only, through KesherAI; list them in the morning report.
- Night tests of browser control: only KesherAI's built-in browser on the PC, test sites, no sign-ins, no purchases or forms; never his Chrome.
- A decision that comes up at night: take the recommended option if it can be undone and mark it in the 10:00 report; anything that can't be undone waits for him.
- No design-doc publishes overnight; boards ready under tools/design/out/, one publish with him at 10:00.
- ⏳ Roee: extension 0.3.0 (Chrome control over the debugger, optional `debugger` permission) is built (295839f) but its store release is held: manifest stays 0.2.6 until he says yes, because pushing main uploads a changed version to the Chrome Web Store. To release: set apps/browser-extension/manifest.json to 0.3.0 and push.
- ⏳ Morning (PC link dropped ~01:30): install the newest release on the PC through the built-in browser; start the vision model downloads (Qwen3-VL 8B Q4_K_M + mmproj F16 from Qwen/Qwen3-VL-8B-Instruct-GGUF; UI-TARS-1.5-7B Q4_K_M + mmproj from Mungert/UI-TARS-1.5-7B-GGUF, names unconfirmed) to E: through KesherAI; real tests with Roee: computer control (Notepad), Unreal plugin 0.1.24 tools, vision benchmark.
