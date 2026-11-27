# Work list (Roee and Claude)

Full backlog: see the 'Backlog:' sections at the end.

The running list of what is being worked on, what is next and what waits on Roee. Claude keeps it up to date after
every task (and tells Roee in the chat what changed). Status: ✅ done · 🔨 in progress · ⬜ next · 👤 waits on Roee.
Longer-term plans are in [FUTURE_FEATURES.md](FUTURE_FEATURES.md); research in [RESEARCH_LOG.md](RESEARCH_LOG.md).

## Monday 23.11 ✅/⬜
- ✅ Unreal 4.27: plugin mounted + connected in ForMigration; "open" flag fixed (slashes/case), converted copies never "updated" to the UE5 plugin
- ✅ OpenCode Go: per-model 429 cooldown and fallback; per-model requests/month + "blocked until" in the card; Jules removed
- ✅ OpenCode Go: free models first (Beam Free, Iceman Contributor Free), outside the daily cap (0.6.463)
- ✅ Every model category works (MODEL_CATEGORIES.md): translator local, vision gemma-4-12b, thinking models fixed, ComfyUI smoke runs + Test button
- ✅ Security/performance scan 0.6.451–0.6.462 (SECURITY_REVIEW.md)
- ⬜ Check a task runs on beam-free; quality of free-model results
- ⬜ OpenCode queue: s-20261122-01..05 scene stats/previews/contents panel, r-53 and the r-5x/6x tasks
- ✅ a-04 (autonomy 4/5): install when free (on by default); phone notes "KesherAI updated to X" and "the update failed"; ARCHITECTURE.md "What restarts on an update"
- ⬜ a-04 left: model runtimes (llama.cpp, ComfyUI) kept alive across an update and re-attached (risk: an orphan holding VRAM; decide first); agent host waits for r-20261122-04
- ✅ a-05 (autonomy 5/5): work loop every 5 min (Settings › Task inbox › Keep the work loop running = `loop`): lines fed to 3 from reports and the new docs/research/BACKLOG.md (first), OpenCode Go free models take the overflow, empty backlog → standing "what to research next" offered (Run? ask) once a day with the loop focus, paused until the quota/cap resets, 21:00 summary on the phone, "Loop: running / paused until HH:MM" chip in the task inbox
- ⬜ r-35/r-39 inject_input
- ⬜ Token-savings deck + site chart (free OpenCode models are a new saving)
- ✅ Readable task steps (25.11): each step as a plain line ("Reading …", "Running the tests") on the task page (last 12, newest first) and in the hub's Now strip; user folder shown as ~.
- ⬜ Claude as a KesherAI executor (Roee 24.11 "KesherAI should be able to start Claude"): run Claude Code on the PC headless (`claude -p … --output-format stream-json`) logged in with Roee's own Max subscription (never an API key, never pay-per-use, extra usage stays off); first research how Claude Squad / Conductor / Crystal / Vibe Kanban drive Claude Code. Executor "claude" in the task inbox and code chats: every step visible, agent watch applies, worktree + branch like the others, review before merge. Guards: Run tap per task by default, daily task cap, stops on a usage-limit message until reset, shows "uses the same Max limits as your Claude app". Install/login check in Settings › Connections (Roee logs in himself). Quota (Roee 24.11): Claude Code gives Pro/Max users `rate_limits.five_hour` / `seven_day` {used_percentage, resets_at} in its status-line JSON after the first answer of a session (docs: code.claude.com/docs/en/statusline) — KesherAI sets a status-line command for its own runs that writes this to a file, shows "Claude 5h N% · week M%" (whole account, incl. the Claude app), stops starting Claude tasks above a threshold (default 5h 80%, week 85%) until resets_at, and keeps the last reading with its time. No unofficial usage endpoints, no reading the login token.
- ⬜ Claude agents panel (Roee 24.11): KesherAI shows Claude's helpers via GitHub (the only channel both reach): done work from commits on main with the Claude-Session trailer (no extra tokens); running helpers from `claude/agents.json` on kesher-inbox that the lead updates at launch/finish; "maybe stuck" flag when a running helper has no update for long; the end reviewer can review their commits too. No live steps or stop (they run in the Claude app only).
- 👤 Hebrew voice F5-TTS (3.6 GB, Settings › Speech); UE4Editor firewall prompt; 3 relay keys; GitHub sign-in for a-03 (Settings › Connections › GitHub, no token)
- 🔨 Free coders infrastructure (Roee 23.11): Beam Free → Z.ai GLM-4.7-Flash → OpenRouter :free → Cloudflare Workers AI → (careful routing: low-risk, non-security S tasks only, secrets scan) Gemini free, Mistral free, NVIDIA trial, OpenCode contributor → paid. Keys: Roee at home.
- ✅ Privacy guard for every user (Roee 23.11; 2026-11-23): one training table in shared (training-risk.ts: NVIDIA trial and OpenCode contributor-free train; Gemini/Mistral free plans and OpenRouter :free may) read by presets, the inbox and the UI; ⚠ "may train on your data" tag in the model menu, Connections and task cards; a one-time line in such a chat; the leak guard (shared leak-guard.ts: keys/tokens by prefix and entropy, secret settings and .env lines, private keys, emails, phones, IDs, Luhn cards, user-name paths, the never-send list) runs in every model turn (chat, agents and the files they read, helpers, free cloud, inbox); Settings › Privacy: ask (dialog on PC and phone: hide and send / local or non-training model / cancel) / auto-hide / block; unattended runs hide, and a secret in a file they read moves the task to a model that does not train; write tools refuse to write placeholders back. Design boards: privacy-guard.json. Left: the OpenAI-compatible API KesherAI serves to outside apps is not guarded (the caller picks the model).
- ✅ Roee 24.11: a paired phone keeps its rights (delete models, relay keys, hub address); live co-editing approach approved (COLLAB_PLAN.md GE-10)
- ✅ Smart log reader (Roee 24.11; research RESEARCH_LOG 2026-11-24): Logs page (System › Logs, phone too): sources (KesherAI's main log and faults, usage log when present, task inbox and self-work runs, llama.cpp/beside/sd/ComfyUI engine logs, found Unreal projects' and Unity's logs, files the user adds inside home, 20 MB cap); search (text/regex, level, source, time, context lines); Drain-like patterns with count, first/last seen, trend, labels (bug/known/ignore) and "new since last look"; Explain a pattern / Summarize the last hour's errors on the local model (cloud only when picked, through the leak guard). Design boards: log-reader.json.
- ⬜ Logs l-01: include/exclude a pattern in the lines view with one tap (Grafana), and saved filters as chips (Seq signals)
- ⬜ Logs l-02: an ignored pattern that rises (3× its usual rate) comes back flagged; a phone note for a new error pattern in KesherAI's own log (opt-in)
- ⬜ Logs l-03: file:line links in a line (compiler/C# errors) open in the code editor on the PC
- ⬜ Logs l-04: merge several sources into one time-ordered view (lnav)
- ⬜ Logs l-05: use the agent-watch helper's CPU runner for Explain when it lands (now: the model beside, else the main one)

## Tuesday 24.11 ✅/⬜
- ✅ Task inbox: no wall-clock kill (agent-watch.ts): progress-based stop (stall 10 min, same step 4 times, request budget 80, safety ceiling 120 min), one rescue hint from a second model, small CPU-only watchdog on loan (watchdog-model.ts), end reviewer, partial branch kept and continued by the next attempt (opencode, Antigravity; Gemini research has the ceiling only)
- ✅ Usage log (usage-log.ts, JSONL per day, 14 days; GET /api/usage-log?level=&executor=&task=&since=&grep=, POST /api/usage-log/savings) with the meter (baseline median per executor+size, over 2x, heavy step, concurrency) and the savings finder (daily + on demand, level `suggestion`)
- ⬜ Usage log page (Settings or Agents, like the Unreal log view): filters level/executor/task and "Suggestions", warnings and errors highlighted, daily totals row per executor, he/en via L(); suggestions also in the daily digest
- ⬜ Usage meter: tokens when the provider reports them, burn rate against the provider's remaining quota (OpenCode monthly %, OpenRouter daily count), Claude 5h/week % once that executor exists; savings detectors left: research asked twice, big model for a tiny step
- ✅ GitHub sign-in without a token (Roee 24.11; research RESEARCH_LOG 2026-11-24 "Signing in to GitHub"): Settings › Connections › GitHub card: Git Credential Manager on the PC (token stays in Windows, asked again when needed) or a device code (PC and paired phone; token sealed in config); account, permissions in words, repositories reached, Sign out. PRs, checks, MCP GitHub tools, code-chat and inbox pushes use it (token only through the git process's environment). Design boards: github-signin.json.
- ⬜ g-01: a-03 (PR for finished code tasks) now has its GitHub account: check it end to end on the PC once Roee signs in (Settings › Connections › GitHub)
- ⬜ g-02: GitHub card: "Switch account" (GCM `credential reject` + sign in again) and a link to revoke KesherAI on github.com (Settings › Applications)
- ⬜ g-03: repository picker from the signed-in account (clone a repo into Projects from the card's list)
- ⬜ Run guard for self-work (the local model's board runs): attach `RunGuard` from agent-watch.ts to its agent loop (stop + rescue hint like the inbox)
- ⬜ Run guard in user chats (code/agent chats, any provider): attach `RunGuard` with `advise` only (never stop or inject): a short "the agent may be stuck: hint / stop?" line in the chat, he/en
- ⬜ Check on a real overnight run that the free-cloud rescue/reviewer and the CPU watchdog (router model GGUF, `-ngl 0`) answer in time

## Priority order (Roee, 2026-11-20 19:36)
1. Agents (a lead + helper agents in KesherAI, like Claude's: models per helper, live status, results).
2. Everything works from a normal chat, like Claude: the chat shows everything and picks the right tools by itself (computer control, browser, showing and writing documents, code and more).
3. Game-engine work features that work well WITHOUT the engines open: good views, offline work, sync later, work remotely from the phone.
4. Everything else.

## Morning 22.11 (Roee 08:39–08:41)
- [ ] Shutdown at 08:02: power surge in the house (Roee's brother). Not load: 66 of 96 GB free, KesherAI 1.75 GB. Still building a load guard (one heavy job at a time, memory watchdog, last shutdown reason in PC health) — helper running.
- [x] Unreal 4.27 conversion (r-20261122-01) failed: a read command was refused and the agent stopped after 9 s. Fixed in 40b8d8f (read commands allowed for every task, one more prompt when a code task changes nothing).
- [ ] Update installer can fail silently (0.6.444 at 06:30 started, the app stayed on 0.6.443 and "is being installed" blocked new tries for 10 min). Detect the installer's exit, show the error, free the lock.
- [ ] Research tasks run by Roee without Claude rearranging them: in the hub, "who does it" on every waiting/failed/quota task, and a queue per executor (local, Antigravity) that starts the next task when a slot frees, with the "ask before next" switch Roee set. Done by hand for now: c-20261122-05, -06, c-20261121-42, -39 moved to Antigravity.
- [ ] Co-developer overlay (research c-20261122-15 on Antigravity): visible control like Claude (orange frame, model cursor, step captions) also in tools and engines; point at an object with a bubble "is this what you meant? yes/no" (engine hit-testing via the plugins); Copilot-like co-developer for the whole computer that watches, understands context and offers suggestions in a bubble to accept or dismiss. Must be light on the PC; can run on a second graphics card when there is one (each card its own jobs).
- [ ] Overlay, from c-15 (S): `overlay-state.ts` — one pure state (frame on/off, model-cursor target, step caption, takeover) fed by control-task.ts steps; tests only, no window yet.
- [ ] Overlay window (M): click-through always-on-top BrowserWindow in apps/desktop (`setIgnoreMouseEvents(true,{forward:true})`, switched off only over a bubble, no focus steal), orange frame + step pill + smooth cursor + a Take over / Esc button. Nothing is drawn on the phone; the phone shows the same step line.
- [ ] Point-to-confirm from the engines (M): Unity bridge `WorldToScreenPoint` and Unreal `WorldToPixel` endpoints return OS pixels for an object/node; bubble "is this the one? Enter / Esc"; UIA rect next, vision-ground.ts last (tier order engine > UIA > VLM).
- [ ] Proactive suggestion bubble (M): idle >1.5 s and the screen changed (cheap hash of a small frame) → ask the local model once, show one dismissable bubble (Tab accept / Esc); per-app off switch, rate limit, nothing when typing.
- [ ] Cheap watching (S): replace the PowerShell CopyFromScreen capture for watching with a frame-hash check first; measure idle CPU/GPU on the PC through KesherAI (DXGI dirty rects only if the hash is not enough).
- [ ] Second graphics card for vision (S): setting "vision/overlay card" → pin vision-service to it with CUDA_VISIBLE_DEVICES (gpus.ts already numbers cards); single card = unchanged. Check Florence-2/Moondream sizes in vision-models.ts first.
- [ ] Mobile phone/remote check for every overlay piece (S): a step line + yes/no buttons in the phone app for bubbles that wait while the user is away.
- [ ] Editors, first slice from c-11 (L, pick one per editor): picture = WebGL2 layer compositor + masks; 3D = modifier stack with manifold-3d; sound = AudioWorklet multitrack + Basic Pitch hum to MIDI (S spike first); video = WebCodecs decode + keyframe curves. Heavy generation stays on the local daemons.
- [ ] Editors on the phone (M): fixed-centre playhead, bottom action sheets, touch axis buttons in the 3D editor (c-11 §5.2) — as a design board first.
- [ ] Live co-editing rule from c-12 (S): write into COLLAB_PLAN.md the decision server-authoritative last-writer-wins per property + soft lock while dragging (no Yjs/Automerge for transforms); then step 3 (locks) can start.
- [ ] Generated assets into a closed Unity project (S): write the file plus a `.meta` with a deterministic path-based GUID (c-12 §C), so results land without the editor.
- [ ] Web build on the phone (M): serve with COOP/COEP + Brotli headers from the local server, a launcher with touch joystick and a memory gauge (iOS 512 MB limit) — see the not-built line below.
- [x] Safety gates (r-20261122-17, CD-16): the metadata-only local reviewer for browser/computer was already built (`core/control-reviewer.ts`). Added in the same approval path (rules, no model call): always ask for turning off security, sending/publishing in Roee's name, losing git work, and deletes outside the project folder; gate notes and reasons in Hebrew. RESEARCH_LOG 2026-11-23.
- [ ] Gates left (from r-17): OpenCode Go / Antigravity executors use their own permissions (only allowed_paths guard them) — route their shell steps through `dangerReason`; OS sandbox for `run_command` like Codex workspace-write (M).


- [ ] Live Claude-helper notifications in KesherAI (Roee 12:57): POST /api/agents/external {id,title,status,step,steps} that the lead Claude calls at a helper's start and end; KesherAI watches new commits on origin/main (its existing fetch) and attaches each commit with the trailer `Helper: <id>` to that run as a step; the phone gets the same live per-id progress notification as Antigravity (deacdf7) and a "Claude" curtain in the hub. No Claude tokens for mid-run updates.

## Three relays (Roee 2026-11-22) 🔁
- Goal: three providers carry the hub's traffic and take over from each other: the Kesher hub (Cloudflare), Ably
  (free 6M messages/month, no card) and Supabase Realtime (free 2M/month, no card); Tailscale direct stays a 4th path.
- [x] a-20261122-06 transport: packages/shared/src/relay-transport.ts (Ably realtime WS + REST publish, Supabase
  Phoenix WS + REST broadcast; plain fetch/WebSocket, no new dependency), pair channel = HKDF of the pair's ECDH secret;
  Settings › Kesher Cloud › Backup relays (keys encrypted on the PC, `PUT /api/hub/relays`); the phones get them in a
  sealed `relays` message (PC → phone only).
- [x] a-20261122-07 failover (packages/shared/src/relay-failover.ts): hub → Ably → Supabase on the PC (hub-client.ts)
  and the hub page (device.ts); fails over after 20 s without a socket, 503 hub-storage-limit, 1101 or 60 s without a
  pong; back to the hub after 2 minutes of answers; listens on all relays at once, copies dropped by envelope id; use
  counted locally (80% of the free plan → last fallback); the phone shows "ההאב לא זמין · דרך Ably"; Settings shows
  the path, each relay's health and its % of the free plan. CSP allows rest.ably.io / realtime.ably.io / *.supabase.co.
- [x] a-20261122-08 offline-first hub page (packages/shared/src/hub-offline.ts): the service worker (sw.js, and
  sw-basic.js the simple way) keeps the page shell network-first (the page, style, icons and every module app.js
  imports; never an API answer) and serves the kept copy when the hub gives no answer in 5 s or a 5xx (Cloudflare's
  522 etc.); the page keeps the paired PCs' public data (kv `pcKeys`: name, public key, opt-ins) and, while the hub
  cannot be reached, shows them as the last known list ("Unknown · via a backup relay"), routes and seals to them and
  sends through Ably/Supabase; no answer or a Cloudflare 5xx at the start fails over at once (not after 20 s); a
  paused hub never fails over; "forget this browser" now also drops the relays' keys. The Android Cloud tab says
  "opening the copy kept on this phone" when the hub does not answer. Settings › Kesher Cloud status line was -07.
- Left: live agent activity (`agents` frames) and Drive `sync` pings stay hub-only; a relay does not queue for an
  offline device (the hub does), so from the last known list a task reaches only a PC that is on (no receipt until
  its first progress); a phone that never opened the page while the hub was up has no kept copy. A PC "here" beacon
  on the relays (to show on/off without the hub) would close the gap.
- [x] Roee: Ably app and Supabase project "kesher-relay" (EU) opened.
- [ ] Roee: paste the Ably API key and the Supabase URL + anon key in Settings › Kesher Cloud › Backup relays (after
  the next build). Supabase: Realtime › Settings must allow public channels (the default).

## Waiting on Roee: at home, weekend 👤 (22.11)
- [ ] Hub secret for storage-free tokens: built (HUB_TOKEN_SECRET, hub.ts; old tokens still work and rotate). Roee pastes a random 48-character secret in Cloudflare › Workers › kesher-hub › Settings › Variables and Secrets (type Secret).

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
- ✅ A6b (S/M): bidi pass — `<bdi>` around mixed runs, code/math LTR, logical CSS in chat, docs panel, tool cards.
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
- ✅ Computer/browser control in the chat like Claude (Roee 22.11 07:23): the ▸ fold per turn (open while live, one line when done: "Used the browser · 6 steps · 3 screenshots · 1:42"), screenshots inline between steps (lazy thumbnails, tap → lightbox, also from the folded line), and a preview per step (page title · domain, window in front, command's last line / exit code, +N −M) for every tool. In code: chat/step-fold.ts (foldKind, stepPreview), Activity.tsx, ChatCards.tsx; boards ChatStepsLive, ChatStepsDone; RESEARCH_LOG 2026-11-27.
- ✅ Antigravity never starts by itself (Roee 22.11 07:30; done 23.11): after a task ends the next one is NOT started — "Done: X. Next in line: Y — Start? / Skip / Clear the queue" waits for his tap, whatever the "ask before the next task" setting says; the work loop no longer queues Antigravity tasks (they wait and get one "Run this task?" ask at a time, first in line, once each); only an Add-to-queue tap on a free slot starts at once. Free Gemini-key research, OpenCode Go and local tasks stay automatic. Tests: inbox-runner.test.ts, inbox-opencode.test.ts.
- ⬜ Hub: accidental Run taps (Roee 22.11 07:25 — several tapped one after another by mistake): Run needs a deliberate action (hold 1 s or swipe, or a 5 s "Starting in 5… Undo" before it is sent), cards never jump under the finger after a tap (keep height, move the next card only after the undo window), a "Run all" button with a count for when he does want several, and old/superseded tasks closed automatically when Claude replaces them (skip with a note).
- ⬜ Node-based material/shader editor (Roee 22.11 07:41): nodes for materials and shaders in the 3D editor with a live three.js preview, export to a real Unity Shader Graph and a real Unreal material (through the package/plugin, headless when the engine is closed), AI builds/edits graphs from the chat. Research first: inbox c-20261122-14 (Antigravity).
- 🔨 Hub tasks view (Roee 22.11 07:53): clear "who is working on what" (per agent: Claude helpers, Antigravity, Gemini, local agent, self-work — current task, step, since when) and "what's next in priority" (ordered queue with priority numbers); finished and failed tasks move automatically into their own sections/tabs (Done, Failed) out of the active list; filter by model/agent.
- ⬜ Free cloud models (research c-20261122-13): add providers as OpenAI-compatible connections where they are safe and card-free — Groq, OpenRouter `:free`, Cloudflare Workers AI, Mistral free plan, Zhipu GLM-4-Flash; Roee enters each key himself; automatic fallback within free limits (rate-limit aware, circuit breaker), never a paid model; speech (Deepgram/AssemblyAI/ElevenLabs) later.
- ⬜ Work split by hardware (c-20261122-13 Part B): route whole jobs by device capability (PC heavy, laptop light), no model sharding.
- ⬜ Node material editor MVP (c-20261122-14): MaterialDoc on our BlueprintCanvas, TSL live preview in the 3D editor, export Unity .shadergraph; Unreal material via the plugin next.
- ⬜ Editors to pro level (c-20261122-11): pick the top tasks per editor (layers/masks + SAM selection, modifier stack, DAW tracks + Basic Pitch hum→MIDI, NLE keyframes + captions).
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

## Cheap flat coding plans (Roee's 8 links, checked 2026-11-22)
Fits (flat, no per-use billing, drivable from KesherAI):
- ✕ T1 Jules: dropped — Jules is read-only and Google shuts it down on 2026-12-31 (seen 2026-11-22). Was: Jules as an executor: Google AI Pro (already paid) gives 100 Jules tasks/day, separate from Antigravity's weekly quota; works on the GitHub repo and returns a PR. Add `executor: jules` to the task inbox (code tasks → PR, which Claude approves in batches). Check the terms and API/CLI first.
- ✅ T2 (part) OpenCode Go chosen by Roee (2026-11-22, $10/month; the $5 first-month offer in older docs is not on the page): added as a provider preset (`opencode-go`, https://opencode.ai/zen/go/v1); self-work can run code tasks on its models. ✅ (2026-11-22) The task inbox's `opencode` executor: code tasks run by themselves in a self-work style code chat on OpenCode Go (S → small model, default glm-5.3-flash; M/L → strong model, default kimi-k3), on an `ocgo/*` branch, checked and pushed like Antigravity's, waiting for Claude's batch review. Gap filler: auto routing and the research loop give S/M code tasks to it while Antigravity is out (quota or cap); L/lead tasks stay. Daily cap (default 15), 429 → out until Retry-After or 5 h. Settings › Task inbox › OpenCode Go card; cards show "◈ OpenCode Go · model"; the hub Agents page and the phone notes show its runs. ⬜ left: check on the PC with the real key (429 text, Retry-After through the chat path); the hub Now strip has no OpenCode Go row yet; design-doc board for the card. Was: Flat-plan provider in Settings > Providers: Xiaomi MiMo Lite ($6, monthly credits, no 5-hour/weekly caps, works with OpenCode/Claude Code/Codex/Cline) or OpenCode Go ($10, Kimi/GLM/DeepSeek/Qwen with 5-hour/weekly caps) as the fallback coder when Antigravity is out. Needs Roee's decision before any purchase.
- ⬜ T3 (S) GitHub Copilot Pro ($10) via Copilot CLI as an executor — only if T1/T2 fall short.
Not a fit (pay-per-use only): Runware, ElevenLabs API, Meta Muse Ember ($0.10/$0.50 per 1M), the dit.ai list (DeepInfra, Groq, Together, DeepSeek API). Cursor Plus is IDE-only; Zed Pro bills past its credits.

## Roee 24.11 evening
- ✅ (checked 26.11) Idle unload exists (20 min). No internal job loads the GPU model just for itself: the inbox helpers and the tool router use it only when already loaded (else a free cloud model), memory filing and the goal check use the chat's own model, the watchdog and quota tip already use the small CPU model. Moving more to the 2B CPU model would cost accuracy (Hebrew, JSON) for no VRAM gain — closed. Original item: Local model unloads itself after a short idle time; small internal requests go first to the small CPU model (the watchdog one: loads per request, unloads after 60 s; titles and short private summaries), longer non-private ones (digests, reports) to a free cloud provider, and the big GPU model loads only when quality needs it (Roee: "rather it isn't loaded if it doesn't have to be").
- ✅ Task inbox uses the free-cloud keys too (see below).
- ✅ Inbox commit: files outside the allowed paths that the agent made as scratch output (e.g. base-out.txt, test-out.txt with test logs) are dropped from the commit instead of blocking the whole run (25.11: s-20261122-01 lost its work this way; the leak guard rightly found personal paths in them).
- ⬜ Medium tasks that read for 80+ requests before the first edit: give the agent a "plan, then edit early" line in the prompt and check the task specs (s-20261122-*, r-58..62 Godot) are small enough.
- ✅ GhostCLI relay (Roee 25.11, one-month trial): Connections preset (openai-compatible, ghostcli.cloud/v1), inbox sends medium/large tasks that pass safeForRelay (no high risk, no security paths or words, prompt scan clean) to its Opus/Sonnet first, outside OpenCode's daily cap; marked "may train" so the leak guard and warnings apply; setting "Heavy tasks to GhostCLI" in Settings › Task inbox.
- ⬜ After a month (≈25.12): compare GhostCLI's results in the usage log (done/partial/failed, time) against OpenCode Go and decide.
- ✅ GhostCLI trial report (data): every relay attempt is logged (done/partial/failed/rate-limited, minutes, model); `relay` in /api/task-inbox gives the totals and the last 20.
- ⬜ GhostCLI trial report card in Settings › Task inbox (design board in the cloud/tasks doc first) and on the phone.
- ⬜ Parallel relay runs (2–3 at once) for the stress test, if Roee wants them.
- ✅ GhostCLI availability check (Roee 25.11: "check availability, and when they're available, load them up"): a small "reply with ok" every 15 minutes; tasks go to it only while the last one answered; when it answers again the queue starts at once; the phone is told when it starts or stops answering. A relay run that ends empty with no change moves on to the next model.
- ✅ Task inbox uses the free cloud helpers' keys (fc-zhipu / fc-openrouter / fc-cloudflare) for small tasks, with the same free-only rules — no second key in Connections.
- ⬜ Updates in parts (Roee 25.11): build, download and swap only the changed component (server bundle, web UI, shell, plugins, engines) instead of the full ~121 MB installer each release. Research first: r-20261125-03 (Gemini). Requirement (Roee): the app keeps working while a part updates — running chats, agents and downloads are not cut; only the swapped part restarts (start the new one, check it is healthy, then switch; fall back if it fails). The update drain then waits only for what uses that part.
- ✅ A failed task goes back to the queue by itself (at most 2 more tries; not after a safety stop) (Roee 25.11).
- ⬜ Task-inbox runs flood the chat list (Roee 25.11: "it works well in Claude"). Research first: r-20261125-04 (Gemini). Then keep runs out of the main chat list (inside the task card / a Runs section), with "continue as a chat".
- ✅ Research r-20261126-01 (Gemini, 26.11): a persistent Kaggle worker is against Kaggle's rules (server farming) per community reports — the exact AUP clause is still to be quoted; short scheduled batch jobs are fine. P100 retired 15.9.2026; T4x2 ~30 h/week; 12 h sessions; 20–60 min idle timeout; scheduled runs and `kaggle kernels push` exist.
- ⬜ Verify the exact Kaggle AUP clause on long-running/outbound workers before building anything (the report cites forum posts, not the AUP text).
- ⬜ If allowed: an ephemeral batch worker (small Go/Rust binary in a scheduled Kaggle notebook) that takes one batch of non-sensitive self-work tasks from the hub, runs llama.cpp CUDA, pushes branches, reports, and exits; measure model startup and tokens/s on one T4 first.
- ⬜ Batch jobs that fit Kaggle as is: LoRA fine-tune of a small coding model on KesherAI's own code; big model-test sweeps.

## Research results 26.11 (Gemini) → tasks
- r-20261126-02 (Tauri / Rust engines): stay on Electron (node-pty and the Fastify server make Tauri costly); keep llama.cpp as the only engine (mistral.rs/Candle don't beat it on a 3090); speed up hot spots with napi-rs Rust modules.
  - ⬜ Measure log search and file indexing on a big workspace (baseline).
  - ⬜ napi-rs prototype package for log filtering; adopt only if the baseline shows it is slow.
  - ⬜ Tune llama.cpp settings for the RTX 3090 / 9950X3D (context, batch, flash attention, threads).
- r-20261126-04 (updates in parts): static Electron shell + signed, separately versioned bundles for the server and the web UI (≈2–15 MB instead of 121 MB), Turborepo-style build of only what changed, staged swap with rollback. Native modules stay in the shell.
  - ⬜ CI publishes core/ui bundles + a signed (Ed25519) manifest next to the installer.
  - ⬜ The updater reads the manifest, verifies, downloads only changed bundles, swaps them atomically, rolls back if the new part fails to start; running chats/agents keep going (Roee).
- r-20261126-03 (language per component): cut off before its shortlist → re-asked short: r-20261126-07.
- r-20261126-05 (runs vs chats): came back empty → re-asked short: r-20261126-06.

## All platforms, not only Roee's PC (Roee, 26.11 — not urgent)
KesherAI is for every user. Whatever is faster on another platform goes in, chosen per platform at run time.
- ⬜ Engines per platform: llama.cpp CUDA (NVIDIA), Vulkan/ROCm (AMD), Metal or MLX (Apple Silicon), CPU-only builds; pick the fastest automatically from the detected hardware.
- ⬜ Re-ask r-20261126-07 style shortlists per platform (macOS/Apple Silicon, Linux, AMD, CPU-only laptops), not only the 3090.
- ⬜ Updates in parts: bundles and the manifest for every platform's installer, not only Windows.
- ⬜ Native modules (napi-rs etc.) built for win/mac/linux × x64/arm64, with the TypeScript fallback kept.

## Research results 26.11 evening (Gemini) → tasks
- r-20261126-06 (runs vs chats): runs live inside the task, not in the chat list (like Claude's background tasks, Cursor's Agents window, Codex cloud tasks).
  - ⬜ Inbox runs stop creating chats: one Run per task, model attempts nested inside it.
  - ⬜ A "Runs" section on the task page: attempts, model, steps, time, result.
  - ⬜ "Continue as a chat" button: turns a run into a chat only when asked.
  - ⬜ Phone: one status pill per task, tap → the run view.
  - ⬜ Retention: keep a summary per attempt; prune raw run logs after 30 days.
- r-20261126-07 (what to make faster first), ranked:
  - ✅ 1. Idle unload of the local llama.cpp model: already built (Settings › graphics card guard: unloads after 20 min idle on Roee's PC; measured 26.11: model unloaded, 2.7 GB VRAM used = the desktop only).
  - ✅ 2. Lazy-load the web UI's heavy pages: 39 were already lazy; Study, Task inbox, Tasks, Code home and Self-work now too — the first bundle went from 1,852 KB to 1,362 KB (−26%) (0.6.486).
  - ⬜ 3. napi-rs Rust module for log search / file indexing (only if the baseline shows stutter).
  - ⬜ 4. Electron window show on ready-to-show; defer background jobs after first paint.
- r-20261126-08 (engine per platform): llama.cpp CUDA on NVIDIA; MLX on Apple Silicon (≈20–30% faster than llama.cpp Metal); llama.cpp Vulkan for AMD/Intel; CPU builds otherwise. Report was thin on auto-pick.
  - ⬜ Hardware detection → pick the engine build (CUDA / Vulkan / Metal / CPU), MLX as an option on Apple Silicon.
  - ⬜ Ship the CPU build in the installer; download the GPU build that fits on first run.
- r-20261126-09 (Antigravity quota): watchers read it from Antigravity's local language server (process found by name; CSRF token and port from its command line; GetUserStatus returns per-model remaining fraction and reset time). Report lacked the exact endpoint.
  - ✅ KesherAI reads the quota locally (read-only, every 5 minutes), shows it on the tasks page and the hub's Antigravity chip, sets the real reset time, and lifts the stop (with a notice) when it renews (0.6.485).
  - ⬜ Check on the PC that the reading works with Antigravity open; the design-doc board for the quota line.

## Where it stopped (26.11 19:51 — power cut at Roee's, PC offline)
- 0.6.487/0.6.488 built; 0.6.489 (model chip picker on Antigravity rows; "ended at once" only ≤3 steps and no quota left) building. Not yet checked on the PC.
- Antigravity line set to Claude: r-20261123-09, -08 Opus 4.6; -11, r-20261122-40 Sonnet 4.6; -12 Sonnet (may not have saved). Antigravity quota at 19:12: Gemini 99%/100%, Claude+GPT 70% (5h) / 44% (weekly).
- ⬜ When the PC is back: version, the model button, the line runs on Claude, agQuota or agQuotaWhy shown.
- ⬜ GPT-OSS 120B refused by setModel ("Antigravity does not offer that model") although listed: check pickableModels / saved.models.

## Idea: travel skill — flights and stays, local and private (Roee, 27.11)
Like Skyscanner, but on the PC and private ("like incognito"): the sites should not learn who searches, so prices do not climb.
- ⬜ Research first (Gemini, with a "Language and weight" part): how Skyscanner, Google Flights, Kayak, Hopper, Kiwi search and show results; which open sources / APIs / scraping are allowed (Amadeus self-service, Kiwi Tequila, Duffel, fast-flights, SerpAPI, Booking/Hostelworld/Airbnb affiliate APIs); terms; how to stay private (no login, fresh browser profile, no cookies, no tracking; whether price tracking by cookies is real).
- ⬜ Flights search with all of Skyscanner's parameters: from/to (incl. "anywhere", nearby airports), dates or flexible (whole month, cheapest day calendar), one way / return / multi-city, passengers and ages, cabin, stops, times, duration, airlines/alliances, bags, price; sort by price/time/best.
- ⬜ Stays: Booking, Hostelworld (and Airbnb, Agoda, Hotels.com if possible): dates, guests, area on a map, price, rating, dorm/private, cancellation.
- ⬜ A full view to compare and book: results list + price calendar + map + filters + search tools; booking happens on the site itself (KesherAI never pays or types card details).
- Sources (Roee 27.11): official/free APIs, the sites read as a guest in a fresh cookie-free browser, and services with a free tier; anything paid only as an optional key he enters.
- ⬜ Private by design: runs locally on the PC, a fresh isolated browser profile per search, no cookies kept, no account, nothing sent to KesherAI's cloud.
- ⬜ Automation: a watch that searches every X time (route, dates, max price) and notifies when a cheaper option appears (price history per watch).
- ⬜ In chat: takes context from the conversation ("a week in Rome in March, under 300€") and shows the whole view inside the chat itself (cards, calendar, map), plus "open in the travel page".
- ⬜ Design-doc boards first (desktop + phone), then build.

## Hub task chat on a small CPU model (Roee, 27.11 13:15)
A chat in the Kesher Cloud hub (also in the phone app) that talks to a small model on the PC, CPU only (`-ngl 0`, the
watchdog/router model's way: loaded on demand, unloaded after idle). Its only job: organize the task list — add tasks,
split them into steps, reorder, set priority, assign an executor. No code, no shell; deletes ask first.
- ⬜ Research to Gemini: r-20261127-01 (competitors' AI task chats, small CPU models with Hebrew + tool calls, GBNF/JSON-schema reliability, latency, safety, Language and weight) — queued in kesher-inbox 27.11.
- ⬜ Gap list against the code (Claude): reuse watchdog-model.ts (CPU loan of the router GGUF), task-inbox actions (assign/queue/model/priority), hub-protocol (a new relay message pair: hub chat → PC → answer + proposed changes).
- ⬜ Design boards (cloud doc 1MJnsdiaPC1WWwNt75DS1G): the hub chat (phone 390 + desktop), proposed-changes card with Apply / Undo, "thinking on the CPU" line, model not on this PC → one-tap download ask.
- ⬜ Build: PC side (task-chat.ts: fixed action list with a JSON-schema grammar, only the relevant tasks in the prompt, confirm for deletes), hub side (chat tab, streaming through the relay), tests, then a release.

## 27.11 (chat 4)
- ✅ Research "Web search returned nothing" (r-20261127-01..03): the note keeps each engine's reason and logs it; blocked engines (DDG anomaly/202/403/429) cool down 30 min+; Gemini Google Search grounding on the free key as research's last search; a search-only failure retries once after 30 min, and the three failed tasks requeue by themselves after the update.
- ✅ Handoff between agents (Roee 27.11 15:59 "let GhostCLI do half and bring the rest to the other agents"): a partial run (or a failed one with a pushed diff or a useful report) goes to the next executor by the failover order and safety rules (small leftover → OpenCode Go / local, bigger → Antigravity / GhostCLI, Claude's Opus agent only for security or L, never the same one after two stops in a row, at most 4 handoffs), continuing from the -partial branch with a scrubbed ≤ 40-line note at the top of its prompt; usage log/relay report "handed off"; task row "⇄ GhostCLI (partial: 3 files) → OpenCode Go free (finished)"; Settings › Task inbox switch (default on); board InboxHandoffChain.
- ✅ Quota failover (Roee 27.11 14:42 "juggle the work to where quota is left"): a waiting task whose executor is out of quota moves to the next one with quota (code GhostCLI → OpenCode Go → Antigravity → local S; research Gemini → GhostCLI → Antigravity), safety/no-payment/no-bounce rules, "↪ moved from X (quota)" on the row, Settings › Task inbox › When a quota runs out, hub Quotas "work went to"; boards InboxQuotaMoved, SettingsQuotaFallback.
- ✅ KesherAI from the Claude app (Roee 27.11 15:43, option A): the hub connector asks the PC sealed while Settings › Kesher Cloud › "Claude connector may read and run" is on (off by default); tools kesher_tasks / kesher_task / kesher_add_task / kesher_task_action / kesher_quotas / kesher_agents; MCP Apps views (board, quotas, task); 30/min, logged on the PC, nothing stored on the hub; docs/CLAUDE_CONNECTOR.md, security note 2026-11-27. Roee: tick the setting, then add https://hub.roeetal.com/mcp in claude.ai › Settings › Connectors. Boards owed: ConnectorBoard, ConnectorQuotas, ConnectorTask, SettingsConnectorOptIn.
- ✅ Design boards owed to the cloud doc: InboxStatusList, InboxModelChip, InboxWhoGhost, InboxTaskProgress, HubAgQuotaChip (scenarios task-inbox-status.json + hub.json), published 27.11.
- ⬜ GhostCLI load (Roee 27.11: usage tracking per option is very important; send to GhostCLI while it works, as much as its terms allow): queued o-20261127-01 usage page, -02 usage meter, -03 runs inside the task (r-20261126-06), -04 logs l-01, -05 logs l-03/l-04 — all executor opencode, model ghostcli/*. Review their ocgo/* branches.
- ⬜ Auto light profile for heavy apps (Roee 27.11, while starting Slay the Spire 2): detect a game or heavy program (process, fullscreen, per-process GPU use, Steam) and apply a profile by itself — unload / pause local work / cap GPU-CPU-RAM / move chat to a small CPU model — and undo it when it closes; an editable "games and programs" list. Research r-20261127-02 (Gemini) first; today Claude paused local work and freed the card by hand (POST /api/guard/pause + /free).
- ⬜ Hub quotas view (Roee 27.11 "in the hub too I want quota info"): helper building it (provider-quotas snapshot → hub message → Quotas section, board HubQuotas).
- ⬜ GhostCLI as its own executor, separate from OpenCode Go (Roee 27.11): helper building it with the GhostCLI loop fixes (re-reading big files, allowed paths at write time, PUT /model for opencode tasks).
- ✅ Inbox fetch self-repair (broken refs/remotes/origin/release stopped every fetch on the PC) — 4242dbf. ✅ a-20261122-02 reviewed: kept the `source` field, dropped unused helpers — fbd0f6c.
- ⬜ Why it does not connect (Roee 27.11 16:24, after the phone app lost the PC when he left home): when the phone app (and the desktop app connecting to another PC) cannot reach the PC, show the reason in plain words with the fix, step by step: no internet on the phone; the PC is online on the hub but the direct link fails → "Tailscale on the phone is off / not connected" (with a button to open Tailscale); the PC is offline on the hub → asleep / off / KesherAI closed / restarting for an update (the PC tells the hub "restarting for 0.6.N" before an update restart) with last seen time; the link address changed; pairing expired; and a "Try the hub instead" button. A diagnostics sheet with each check ✓/✕ and its time; logged on the phone for Claude to read later. Next Claude helper slot (both busy at 16:24).
- ⬜ Connect Tailscale from the KesherAI phone app (Roee 27.11 16:25): a "Connect Tailscale" button (and automatic when the direct link fails off home Wi-Fi) that sends the Tailscale app's broadcast intent (package com.tailscale.ipn, receiver .IPNReceiver, action com.tailscale.ipn.CONNECT_VPN; DISCONNECT_VPN to stop) through a small native Android plugin; fallback: open Tailscale's own Connect shortcut / the app. Check the result (the ts.net address answers) and show it in the "why it does not connect" sheet. Longer term: an embedded Tailscale node (libtailscale/tsnet, userspace, no VPN) inside the phone app so no Tailscale app is needed — research first. Same helper as the diagnostics item.

## Research results 27.11 (Gemini) → tasks
- r-20261127-02 (auto light profile for heavy apps):
  - ⬜ S: process snapshot every 1 s in the main process (CPU%, RSS, name); ⬜ S: per-process GPU list (VRAM, 3D engine %) — small native watcher only if Node can't read Windows GPU counters cheaply (measure first).
  - ⬜ M: fullscreen / exclusive-fullscreen detection per platform; ⬜ M: HeavyAppDetector (rules: VRAM > 500 MB and 3D engine > 30 %, or fullscreen and not allow-listed; hysteresis).
  - ⬜ M: profile store + UI (per-program rule: unload / cap / small CPU model; allow-list); ⬜ L: wire the actions (unload/reload, gpu layers/threads, CPU model, inbox pause, ComfyUI priority); ⬜ L: tests with real loads (a game, Blender render, 4K video, cargo build) for false positives and undo time.
- r-20261127-04 (pool of small CPU models): llama.cpp's own router mode (`llama-server --models-preset` with several models, `--models-max N`, load on demand) is the base — no own scheduler from scratch.
  - ⬜ M: CPU pool on llama-server router mode: router 2B, translator, embeddings, hub task chat; `-ngl 0`, `--models-max 2`, threads budget (physical cores − 2), below-normal priority, pinned to the non-V-Cache CCD on X3D.
  - ⬜ S: benchmark each small model on the 9950X3D (256 in / 512 out, tokens/s, RAM) and on a laptop; ⬜ S: Hebrew quality check Qwen3.5 2B vs Gemma small; ⬜ M: priority queue (chat > watchdog > translator > embeddings) and pause while a game runs; ⬜ S: per-model load in PC Health.
- r-20261127-05 (work from the Claude app): ✅ custom connector + task board / quotas / task views (0.6.498).
  - ⬜ S: approvals view (MCP App) for `kesher_approve`; ⬜ L: model jobs gallery view (image/audio/video previews, cancel/retry); ⬜ S: a search/toolset entry so Claude picks the right tool as the list grows.
  - ⬜ M: Claude Desktop extension (.mcpb) for the local MCP server (direct to the PC, no hub); ⬜ S: phone smoke test of the connector in the Claude Android app.
- ⬜ r-20261127-01 and -03 failed again on search (every engine blocked or irrelevant; Gemini fallback result not visible in the note): check the Gemini Google Search fallback on the PC, then rerun.
