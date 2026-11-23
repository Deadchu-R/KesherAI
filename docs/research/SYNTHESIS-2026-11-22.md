# Research synthesis 2026-11-22: tasks for co-developer, one chat, game engines (and everything else)

Last updated: 2026-11-23 (t308 maintenance — CD-1, CD-4, CD-8, GE-14, GE-23, GE-25 marked DONE).

Source: every report in `docs/research/` (46 files on main plus `ui-texts-review.md`, which exists only on the branch
`agy/c-20261121-04-check-interface-texts-in-hebre-partial`; the other `agy/*` branches carry the same report files that
are on main), and `docs/RESEARCH_LOG.md` from 2026-11-20. Each task was checked against `packages/`, `apps/`, `plugins/`,
`integrations/` and `docs/WORK_LIST.md`.

Legend. Status: NEW (nothing in code), PARTIAL (part exists, paths given), DONE (skipped, listed at the end).
Size: S (under a day, one file area), M (a few files, tests, a screen), L (architecture, several modules).
Who: LOCAL = KesherAI self-work on the local model (S and precise); AGY = Antigravity plus Opus (M code); LEAD = Claude lead (L or architecture).
"Check" always includes the phone/remote view where the feature has a screen, and a design-doc board first for any new screen.
Order inside each section is by value for Roee (phone during the week, PC on weekends).

Counts: section 1 (co-developer) 17 tasks, section 2 (one chat) 17 tasks, section 3 (game engines) 28 tasks, section 4 (everything else) 40 entries (36 real tasks, 4 bookkeeping entries: X-24, X-27, X-39, X-40). Total 102 entries, 98 real tasks.

---

## 1. CO-DEVELOPER (CD)

Findings in one paragraph: tool order of grounding is engine hit-test, then Windows UI Automation, then VLM (c-15, c-21,
browser-computer-control). UIA (`packages/core/src/uia-script.ts`, `computer_tree`), the vision models and bench
(`vision-service.ts`, `vision-ground.ts`, `vision-find-tools.ts`), the phone live view and Stop (`ControlLive.tsx`) already exist. What is missing is the
visible layer (overlay window), the engine pixel endpoints, the proactive watcher, next-edit suggestions, and the second-card pinning.

**CD-1 Overlay state (pure model)** — DONE (t260, `overlay-state.ts`, commit 82f958bb).

**CD-2 Overlay window (click-through, always on top)** — NEW (no `setIgnoreMouseEvents` anywhere). Why: c-15 §4.1, c-21 §3.2. Build: transparent frameless BrowserWindow in `apps/desktop/src/overlay.ts`, `setIgnoreMouseEvents(true,{forward:true})`, switched off only over a bubble, no focus steal, orange 3 px frame, step pill, Take over button and Esc; one spike first: measure idle RAM/VRAM of the Electron window versus a native sidecar (c-15 open question). Size M. Who AGY. Deps CD-1. Check: on the PC through KesherAI (computer control run on Notepad: frame appears, clicks pass through, Esc stops); phone shows the same state.

**CD-3 Visible model cursor and human pacing** — NEW (computer.ts has only a 350 ms wait, line 859, no easing). Why: c-21 §3.1-3.2, c-15 §1.1. Build: 4-6 waypoint eased cursor path (about 80 ms) before click/drag in `computer.ts`, drawn by the overlay; step cap of 15 actions per turn then ask. Size S. Who LOCAL. Deps CD-2 for the drawing; the pacing alone stands. Check: `computer.test.ts` with a fake backend asserts waypoints and the cap.

**CD-4 Per-monitor DPI v2 and virtual-screen mapping** — DONE (t262, per-monitor v2 + toScreenPoint pipeline, commit ba1eca6a).

**CD-5 Point-to-confirm from Unity and Unreal ("is this the object?")** — NEW (only a doc entry for `WorldToScreenPoint` in `apps/web/src/ide/unity-api.ts`). Why: c-15 §3, WORK_LIST "Point-to-confirm". Build: bridge commands `screen_point` in the Unity package and `world_to_pixel` in the Unreal plugin (`integrations/`), returning OS pixels for an actor/node (viewport origin plus DPI); core route in `unity-bridge.ts`/`unreal-bridge.ts`; bubble "yes (Enter) / no (Esc)" drawn by the overlay. Size M. Who AGY. Deps CD-1, CD-2. Check: Unity/Unreal on the PC, ask "select the door", bubble sits on the door; the phone shows a yes/no card while he is away.

**CD-6 One grounding resolver (engine, then UIA, then VLM)** — PARTIAL (`computer_find` does UIA then screenshot; engine tier missing). Why: c-15 §3.4, c-21 §4, browser-computer-control. Build: `ground-target.ts` returning `{rect, tier, confidence}`; tier 1 engine bridge (CD-5), tier 2 UIA tree, tier 3 UI-TARS/Qwen3-VL; the bubble shows the tier. Size M. Who AGY. Deps CD-5. Check: fake tiers in unit tests; real run in Unity viewport vs Notepad.

**CD-7 Phone mirror of every overlay piece** — NEW. Why: WORK_LIST "Mobile check", c-15 §7, c-35 §4.3. Build: a step line plus yes/no buttons and Stop in `ControlLive.tsx` for bubbles that wait; push notification after 10 s unseen (existing notifier). Size S. Who LOCAL. Deps CD-1. Check: 390 px Playwright board; real phone push.

**CD-8 Cheap screen watching (frame hash first)** — DONE (`frameHash()` added to `Backend` interface with Windows 32×32 thumbnail SHA-1 impl, t270, commit 29f10abb). Why: c-15 §4.2-4.3, WORK_LIST "Cheap watching". Size S. Who LOCAL. Deps none. Check: idle numbers logged on the PC.

**CD-9 Proactive suggestion bubble** — NEW. Why: c-15 §2.3, §7.2, WORK_LIST. Build: idle over 1.5 s and the hash changed, ask the local model once, one dismissable bubble (Tab accept, Esc), per-app off switch, rate limit, silent while typing; false-positive guard for art tools (c-15 open question). Size M. Who AGY. Deps CD-2, CD-8. Check: PC with Unity open; phone setting toggles it.

**CD-10 Next-edit backend `/api/code/next-edit`** — PARTIAL (`/api/code/complete`, `apps/web/src/ide/inline-suggest.ts`, `side-engine.ts` exist; fixed 450 ms FIM only). Why: c-35 §1-§2, §5.1. Build: new route in `packages/core/src/routes/code.ts` with abort on client close, edit-history ring buffer, LSP diagnostics in the prompt, Qwen2.5-Coder 0.5B (CPU) or 1.5B (second card) through `SideEngine` with `--parallel 1 --cache-reuse`, stop tokens, parser to a hunk. Size M. Who AGY. Deps CD-12 for the card pin. Check: latency log 50-150 ms; typing never lags.

**CD-11 Ghost diff rendering and Tab/Esc in Monaco** — NEW. Why: c-35 §3-§4. Build: decorations for deletions plus `changeViewZones` for added lines in `MonacoEditor.tsx`, adaptive debounce (250 ms after delimiters, 400 ms otherwise), atomic apply on the undo stack, jump to a distant edit. Size M. Who AGY. Deps CD-10. Check: Playwright on the code page; undo restores in one step.

**CD-12 Second graphics card pin (side engine and vision)** — PARTIAL (`gpus.ts` numbers cards and sets CUDA_VISIBLE_DEVICES for `sdcpp`; `side-engine.ts`, `vision-service.ts` are not pinned). Why: c-15 §6, c-35 §5.2, WORK_LIST "Second graphics card". Build: Settings "overlay/vision/draft card", pass CUDA_VISIBLE_DEVICES and `--split-mode none` to SideEngine and vision server; single card unchanged. Size S. Who LOCAL. Deps none. Check: `gpus.test.ts`; on a one-card PC nothing changes (his PC has one 3090, so the test is a unit test plus a dry-run flag print).

**CD-13 Next-edit on the phone (bottom sheet)** — NEW. Why: c-35 §4.3. Build: a 390 px action sheet (Accept, Skip, Why) over the code page, `L(he,en)` strings. Size S. Who LOCAL. Deps CD-10. Check: 390 px board; remote session.

**CD-14 Next-edit for external editors through the overlay** — NEW. Why: c-35 §4.2, c-15 §2.3. Build: for VS Code / Unity script editors, read the active buffer by UIA (`computer_tree` value pattern) and show the ghost in the overlay; Tab inserts through key events. Size L. Who LEAD. Deps CD-2, CD-10, CD-6. Check: PC with VS Code; app allow list respected.

**CD-15 Local GUI vision server profile tuning** — PARTIAL (`vision-service.ts` has the catalog, `-c 8192`, idle unload). Why: c-21 §1. Build: add `--flash-attn on --ubatch-size 512 --parallel 1`, a real-3090 bench of Qwen3-VL 8B vs UI-TARS 1.5 recorded in `RESEARCH_LOG.md`, disable speculative decoding while the projector is loaded. Size S. Who LOCAL. Deps none. Check: `POST /api/vision/bench` on the PC.

**CD-16 Safety gates from c-21 and Google "critic" idea** — PARTIAL (stop hotkey, sensitive-title block, app allow list exist). Why: c-15 §1.3, c-21 §3, browser-computer-control §3.6. Build: only the missing gate: reviewer model that sees metadata only (request, action verb, target label) for computer/browser actions, local model only. Size M. Who AGY. Deps none. Check: node:test for the pure gate.

**CD-17 "Running light": NVML poll, 1 heavy job, thermal guard** — PARTIAL (`gpu-guard.ts`, `heavy-gate.ts`, `memory-watchdog.ts`, Play-mode standby B2 exist). Why: c-20, WORK_LIST "load guard". Build: NVML (or nvidia-smi once per 2 s) VRAM/temperature poll in `gpu-guard.ts`, suspend heavy jobs above a temperature, write the crash-recovery log line with the last shutdown reason; engines signal Play enter/exit over the existing bridge socket. Size M. Who AGY. Deps none. Check: unit tests with a fake poller; PC Health page shows the last reason; phone sees "paused: hot".

---

## 2. ONE CHAT THAT USES ALL TOOLS EFFICIENTLY (CH)

Findings: tool groups per turn, Auto model, toolSearch hook, cache_control on the last tool, stable tool order, id_slot, `--cache-ram`, prune of old outputs, helpers with 15-line reports and the context ring all exist. The gaps are the structured roll-up, deduplicated reads, the generic lazy-discovery of MCP/engine toolsets, device-aware routing, and the self-setup.

**CH-1 Lazy tool discovery for MCP and engine toolsets** — PARTIAL (`tool-router.ts`, `chat-tool-groups.ts`, `toolSearch` option in `packages/agent/src/session.ts`, `engine-specialists.ts`). Why: c-25 §1.2 (Unreal `list_toolsets / describe_toolsets / describe_tools / call_tool`), c-30 §3.3, c-38 Part A. Build: a generic agent-side "toolset navigator": MCP servers with many tools are shown as four meta-tools; schemas enter context only after `describe`; same for Godot classes (`godot_class_info`). Size M. Who AGY. Deps none. Check: token count of the first turn with Unreal MCP attached drops under a set budget (test asserts); phone chat works.

**CH-2 Findings roll-up protocol for helpers** — NEW (no roll-up schema; helpers return free 15-line text). Why: c-29 §3, §7 Phase 2. Build: JSON schema `FindingsRollup` (200-400 tokens), GBNF/JSON-schema constrained output on local helpers, hard token ceiling, strip helper tool logs from the parent history (send them to the SSE stream only). Size M. Who AGY. Deps none. Check: node:test with a long fake helper log, parent context grows by under 400 tokens.

**CH-3 Observation masking and duplicate-read pruning** — PARTIAL (`pruneToolOutputs` in `packages/agent/src/budget.ts`). Why: c-38 B2. Build: `read_file` of path P supersedes earlier reads of P; command outputs older than 2 turns become one summary line recoverable by `tool_output`. Size S. Who LOCAL. Deps none. Check: budget tests; prunedChars logged per session.

**CH-4 Repo-map tool (1,024 token outline)** — NEW. Why: c-38 B4. Build: `get_repo_outline` in `packages/agent/src/tools.ts` using the TypeScript API for exported symbols, hard token ceiling. Size M. Who AGY. Deps none. Check: first-edit tool-call count on a sample task goes down.

**CH-5 Predictive token budget and runaway interceptor** — NEW (`estimateTaskSteps` in `packages/shared/src/task-steps.ts` exists, no token budget). Why: c-38 B6. Build: token budget per task kind; at 2.5x with no accepted edit, one reflection nudge. Size M. Who AGY. Deps none. Check: simulated loop test.

**CH-6 Changed-file test runner** — NEW (no `tools/test-changed.js`). Why: c-38 A3, B5. Build: `tools/test-changed.js` (git diff names, matching `*.test.ts`, `node --test`), script `test:changed`, referenced from agent prompts. Size S. Who LOCAL. Deps none. Check: run on a one-file change; exits 0 when nothing changed.

**CH-7 Cache hit telemetry** — PARTIAL (`cache_control` breakpoints exist in `packages/providers/src/anthropic.ts`; cached tokens already in the usage event for llama.cpp). Why: c-38 B1. Build: read `cache_creation_input_tokens`/`cache_read_input_tokens` from Anthropic SSE, add `cacheHitRate` to `chat-stats.ts`, show in the token line. Size S. Who LOCAL. Deps none. Check: provider unit test with a recorded stream.

**CH-8 Slot arbiter for lead and helpers** — PARTIAL (`slot-park.ts`, `id_slot` in providers, slotKind main/helper/other). Why: c-29 §4, c-26 §Multi-turn. Build: `id_slot 0` for the lead, 1..N leased to helpers, concurrency limited by free VRAM through `HeavyGate`, `--cram` sized from free RAM. Size M. Who AGY. Deps CH-2 helpful. Check: `llamacpp.test.ts`; two helpers plus chat on the 3090 without a reload.

**CH-9 Windows worktree hardening** — PARTIAL (`session-worktrees.ts`, 125 lines, no retry/backoff). Why: c-29 §2, WORK_LIST EPERM failures. Build: `core.longpaths`, backoff retries 200/600/1800 ms around remove/prune, assert the cwd is outside the tree, jitter. Size S. Who LOCAL. Deps none. Check: tests with a fake failing fs; self-work run on the PC.

**CH-10 Swipe and undo for per-hunk review** — PARTIAL (`helper-review.ts`, hunk accept/reject exists). Why: c-29 §5.3. Build: swipe accept/reject, instant rollback through the undo store, on desktop and 390 px. Size S. Who LOCAL. Deps none. Check: Playwright at 390 px.

**CH-11 Model choice per step with hysteresis** — PARTIAL (`model-router.ts`, "Auto" chat model, size per turn). Why: c-38 §6, c-26, c-31. Build: rule filter, then a 2B router emitting CODE / RESEARCH / FAST_CHAT / VISION, 3-turn hysteresis so the loaded model is kept; per-step choice for helper vs lead; local versus free cloud by task size. Size M. Who AGY. Deps CH-14 for cloud. Check: model-router tests with scripted prompt sets (Hebrew and English).

**CH-12 Speculative decoding policy** — PARTIAL (`LlamaEngine.speedArgs`: lookup, vision flag). Why: c-26. Build: add draft-model option (0.5B) with auto-disable rules: mmproj loaded, temperature above 0.8, strict JSON/tool-call turns; measured on the PC. Size S. Who LOCAL. Deps none. Check: `llamacpp.test.ts` flag matrix; tok/s before/after logged.

**CH-13 KV-cache profile per context size** — PARTIAL (`setKvType` f16/q8_0 exists; no q4_0 profile). Why: c-31, c-26, c-38 §3. Build: profile table: 27B-32B at 32K on 24 GB uses q8_0 K and V (q4_0 option), flash attention required; chosen from the VRAM budget in `budgetOf`. Note the c-31 report text is truncated: numbers must be re-measured. Size S. Who LOCAL. Deps none. Check: budget tests; bench on the PC.

**CH-14 Free cloud fallback with one-tap reroute** — PARTIAL (`free-cloud-catalog.ts`, `routes/free-cloud.ts`). Why: c-13 Part A and §3.2 point 4. Build: circuit breaker (8 s no answer or OOM) offering "Main PC busy: reroute through Groq/OpenRouter free?" card; add Hebrew STT option (Deepgram credit) as a provider kind; keys stay user-entered. Size M. Who AGY. Deps none. Check: fake provider failing; the card on the phone.

**CH-15 Device capability profile, laptop guard, per-chat device choice** — NEW (no vram/battery fields in `devices.ts`). Why: c-06 §3-§4, c-13 Part B, WORK_LIST "Work split by hardware". Build: `DeviceEntry` gains GPU VRAM, RAM, on-battery; task metadata `minVramMb`/`isHeavy`; heavy work is forwarded to the main PC and never runs on a laptop on battery; device badge in the chat header (desktop and 390 px). Size L. Who LEAD. Deps none. Check: two registered fake devices in tests; real laptop plus PC; phone header shows the target.

**CH-16 Wake-on-LAN from phone** — NEW (`devices.ts` has UDP but no magic packet). Why: c-06 §5.4. Build: collect MAC in `DeviceEntry`, `node:dgram` magic packet on port 9 (only from a device on the same LAN or through the hub command), "waking the PC" state until the awake beacon. Size S. Who LOCAL. Deps none. Check: packet bytes in a unit test; real wake on his home PC at the weekend only.

**CH-17 Self-configuring setup by prompt** — PARTIAL (`PARTS`, `INSTALLABLES`, `pickSetup`, `estimateRunFit`, install button in chat; no catalog or solver). Why: c-28. Build: `packages/shared/src/capabilities.ts` catalog with dependency graph, `packages/downloads/src/setup-solver.ts` (hardware-aware), `SetupCard.tsx` two-phase approval, `setup-snapshots.ts` one-tap rollback, 390 px layout. Size L. Who LEAD. Deps none. Check: scripted prompt "I make Unreal games and want a Hebrew voice assistant" yields a plan without side effects; execution tested on the PC through KesherAI.

---

## 3. GAME ENGINE TOOLS (GE)

Findings: Godot has bridge, `tscn.ts`, tools; Unity has scene reading, prefabs, test/play; Unreal has the bridge and stand-in (`routes/unreal-level.ts`), MCP preset "unreal" and the `ModelContextProtocol` plugin enable for 5.8+ (`unreal-install.ts`); night builds exist in `night-build.ts`. Gaps: editor-exit level cache, MCP navigator and server tools, input injection and autonomous playtest, collaboration locks, the web build on the phone.

**GE-1 Playtest bug-report receipt and anomaly detectors** — NEW (the `TestRun` and `judgeRun` base exists in `unity-test.ts`, `blueprint-test.ts`). Why: c-19, c-38 idea 2, 17. Build: `playtest-receipt.ts` with the JSON schema (id, kind STUCK / FALL_THROUGH / CLIP / SHADER_ERROR / FPS_DROP, position, log excerpt, screenshot) stored under `<data>/playtest-receipts/<project>/<date>/`; detectors fed by position stream and log lines; `ToolOutput` card. Size S. Who LOCAL. Deps none. Check: unit tests on a fake position stream; phone card shows the screenshot.

**GE-2 `inject_input` bridge command (Unity)** — NEW. Why: c-19 §Input. Build: Unity package command using `InputTestFixture`-style virtual devices (move vector, jump, interact), exposed in `unity-bridge.ts`. Size M. Who AGY. Deps none. Check: Unity on the PC, walk a test scene for 10 s.

**GE-3 `inject_input` bridge command (Unreal)** — NEW. Why: c-19. Build: Enhanced Input `InjectInputForAction` in the Unreal plugin plus `unreal-bridge.ts` route. Size M. Who AGY. Deps none. Check: PIE on AutoShooter.

**GE-4 Autonomous exploration loop** — NEW. Why: c-19 hybrid. Build: NavMesh waypoint sweep, interaction probing at waypoints, boundary stress, optional LLM-guided "where next" from a screenshot (`judgeRun` path); runs on the task inbox, report to the phone. Size L. Who LEAD. Deps GE-1, GE-2/GE-3. Check: run on a demo scene; receipts appear on the phone in the morning.

**GE-5 Remote play stream and touch controls for playtests** — NEW. Why: c-33, c-38 idea 2. Build: WebRTC video of the PC viewport to the phone (hub signalling shared with CH-18), joystick overlay 120/56 px, gesture-arbitration state machine (slop 28 px, axis dominance 1.75, pointercancel) shared with the 3D editor. Size L. Who LEAD. Deps none for the gesture part (S, can start separately by LOCAL). Check: phone over home Wi-Fi and Tailscale.

**GE-6 Unreal level cache written at editor exit** — PARTIAL (stand-in `levels`/`level` read through the bridge or the commandlet; no `OnPreExit` hook in `integrations/unreal`, `fromDisk` badge per c-18 only partly). Why: c-18 §5, WORK_LIST "Unreal without the editor". Build: `FEditorDelegates::OnPreExit`/`PreSaveWorld` dump to `standin/level-<hash>.json`; core serves Tier 1 cache first, `scanContent` second, async commandlet third; World Partition projects list `__ExternalActors__` counts. Size M. Who AGY. Deps none. Check: close Unreal, open the level on the phone in under 100 ms.

**GE-7 Unreal native MCP: toolset navigator and version gate** — PARTIAL (preset `unreal`, plugin enable on 5.8+). Why: c-25 §1, §6 Phase 1. Build: connect to the engine's `ModelContextProtocol` server at its HTTP address, use CH-1 navigator, show in Settings which engines are 5.8+, clear message for older ones. Size M. Who AGY. Deps CH-1. Check: UE 5.8 on the PC: "list toolsets" from the phone chat.

**GE-8 KesherAI as an MCP server (engine-closed tools)** — PARTIAL (`mcp-server.test.ts` and `routes/mcp-server.ts` exist). Why: c-25 §3.2, c-17 idea 2. Build: register `kesher_read_scene`, `kesher_translate_material`, `kesher_index_assets` over `unity-scene.ts`, `unreal-assets.ts`, `.tscn`, `material-doc.js`; owner-only auth. Size M. Who AGY. Deps none. Check: Claude Code or Cursor connected on the PC reads a Unity scene while Unity is closed.

**GE-9 Revision tokens and resource locks for several writers** — NEW. Why: c-25 §4, c-39 §3.3, c-12 Part B. Build: revision hash in `unreal-bridge.ts`/`godot-bridge.ts`, `mcp-lock-manager.ts` with 30 s TTL, collision card in the approval queue; leases with 5-min heartbeat in `hub-client.ts` for scenes/levels. Size L. Who LEAD. Deps none. Check: two simulated clients edit one scene; second gets a card.

**GE-10 Live co-editing decision and presence** — NEW. Why: c-12 Part B, c-39, WORK_LIST "Live co-editing". Build (step 1, S): write into `COLLAB_PLAN.md` the decision "server-authoritative last-writer-wins per property plus soft lock while dragging; no Yjs/Automerge for transforms"; step 2 (M): presence, cameras, soft-lock chips in the stand-in. Size S then M. Who LOCAL then AGY. Deps GE-9 for locks. Check: two browser tabs; phone as one participant.

**GE-11 Collaborator without engines: sync page and conflicts sheet** — PARTIAL (`pending-moves` in `level-design-tools.ts`, `routes/games.ts`, `game-sync.ts`, `game-checkpoints`). Why: c-39 §5 Phase 1, c-12 Part A. Build: Games home page listing project state (open/closed/pending/last sync/conflicts) and a 390 px conflicts sheet with mine / engine / skip. Size M. Who AGY. Deps none. Check: two machines; phone sheet.

**GE-12 Headless apply of collaborator moves with a checkpoint** — PARTIAL (`unity-sync.ts`, `unity-cli.ts`, `game-checkpoints`). Why: c-39 Phase 3, c-12 §A.C. Build: `ApplyPendingMoves` executeMethod for Unity batchmode and a commandlet for Unreal, always after a `GameCheckpoint`, undo-grouped when the editor is open. Size M. Who AGY. Deps none. Check: Unity closed, moves applied, checkpoint restorable.

**GE-13 Viewport render back to the collaborator** — NEW. Why: c-39 Phase 4, c-12. Build: off-screen camera capture to WebP in both plugins, card on the phone after a batch. Size M. Who AGY. Deps GE-12. Check: apply a move, phone shows the picture.

**GE-14 Generated assets into a closed Unity project with `.meta`** — DONE (t297, Unity .meta generation, commit 718c4590).

**GE-15 Godot AST scene writer** — PARTIAL (`tscn.ts` regex transforms). Why: c-30 §2, Roadmap Phase 1. Build: full `.tscn` format-3 reader/writer (`[ext_resource]`, `[sub_resource]`, `load_steps`, `.uid` sidecars, base-36 UIDs), round-trip tests. Size M. Who AGY. Deps none. Check: round-trip of sample scenes byte-stable.

**GE-16 Godot headless validator** — DONE (t298, Godot headless validator module, commit 4729d309).

**GE-17 Godot ClassDB cache and on-demand tools** — PARTIAL (`godot-addon.ts` mentions `--dump-extension-api` and property flags; no cache or class tools). Why: c-30 §3. Build: pruned `classdb-cache.json` (editor properties only, instantiable subtrees), tools `godot_class_info` and `godot_node_synthesize` with schema validation. Size M. Who AGY. Deps GE-15. Check: ask for a `CharacterBody3D` setup; the tscn validates.

**GE-18 Godot headless daemon (dummy renderer)** — NEW. Why: c-30 §4, §5.2. Build: long-lived `godot --headless --rendering-driver dummy` JSON-RPC bridge, sleeps after 5 idle minutes, stops during heavy generation; phone stand-in edits go through it. Size M. Who AGY. Deps GE-15, CH-… none. Check: RAM under 75 MB measured on the PC.

**GE-19 Night builds: phone scorecard and APK handoff** — PARTIAL (`night-build.ts`, `night-build-runners.ts` complete with scorecard; research NEW-1 of c-16 never produced a report). Why: c-38 idea 6, c-16 task 1. Build: attach the Android build to the scorecard and offer install over local Wi-Fi/hub; verify the Unity/Unreal runners on the real projects. Size S. Who LOCAL. Deps none. Check: one night run on AutoShooter, morning notification on the phone.

**GE-20 Web build on the phone: host and secure context** — NEW. Why: c-05 §5, c-12 Part D, c-33. Build: static route in `packages/core` serving a build folder with COOP/COEP, `Content-Encoding: br`, `.wasm/.data/.unityweb` MIME, HTTPS through Tailscale serve or the hub; `crossOriginIsolated` self-check. Size M. Who AGY. Deps none. Check: a Unity WebGL build opens on the phone.

**GE-21 Web build automation (Unity WebGL/WebGPU, UE 5.9 Web)** — PARTIAL (`unity-cli.ts` build targets). Why: c-05 §6 Phase 3, c-12 §D. Build: preset (WASM32, 256 MB heap, Brotli) and a one-click task; UE 5.9 preview cook marked experimental. Size M. Who AGY. Deps GE-20. Check: task from the phone, link back.

**GE-22 Mobile player shell with joystick and memory gauge** — NEW. Why: c-05 §5.5, c-12 §D, c-33. Build: `GameLauncher.tsx` (fullscreen, joystick, FPS/heap badge for the 512 MB iOS limit, first-touch audio unmute). Size M. Who AGY. Deps GE-20, GE-5 gesture part. Check: 390 px board; real phone.

**GE-23 Muse-parity asset pipelines (remaining)** — PARTIAL (`create_pbr_material`, `import_sprite`, TRELLIS, Stable Audio SFX exist; Godot headless validator added t298). Why: c-42 §6, c-12 §C. Build, in order: RMBG-2.0 plus `pbr-packer.ts` with DirectX/OpenGL normal convention; Humanoid motion (text-to-BVH plus `.meta` importer); Sentis exporter (ONNX plus C# wrapper). Size L (three S/M slices). Who AGY for each slice, LEAD for the Sentis design. Deps GE-14. Check: Unity project receives and shows the asset.

**GE-24 Material node editor to engines** — PARTIAL (`plugins/model-editor/ui/material-doc.js`, `material-graph.js`, `packages/core/src/material-doc.test.ts`). Why: c-14. Build: TSL/`MeshPhysicalNodeMaterial` preview, Unity `.shadergraph` NDJSON export (headless), Unreal material through `UKesherBridgeCommandlet`; handle engine mismatches table. Size L. Who LEAD for the schema, AGY for each export. Deps none. Check: material opens in Unity Shader Graph.

**GE-25 Foley post-process, loops, engine export** — DONE (t301, DC remove, trim, normalize, loop detection, engine export, i18n, commit 0196f67f).

**GE-26 Figma to UMG and UI Toolkit (remaining)** — PARTIAL (`figma.ts`, `figma-umg.ts`). Why: c-24, WORK_LIST "stages 2-3", c-38 idea 15. Build: DTCG token export, `UXML/USS` headless generation, 9-slice, RTL mirroring for Hebrew, asset routing to `Assets/UI` / `Content/UI`. Size L. Who AGY per slice. Deps none. Check: generated USS loads in Unity; mirrored layout screenshot.

**GE-27 Voice to engine actions (Hebrew)** — PARTIAL (`speech-tools.ts`, realtime voice hand-off exists; no VAD or command schema). Why: c-22, c-38 idea 3 and 19. Build: Silero VAD (ONNX, zero GPU while silent), whisper.cpp with the existing language detection, command JSON schema mapped to engine tools, Kokoro/system voice confirmation; works from the phone mic. Size L. Who LEAD. Deps none. Check: Hebrew phrase "תוסיף מקור אור כאן" produces an approval card.

**GE-28 Scene-diff visualizer with click-to-highlight and cross-engine layout translate** — NEW. Why: c-17 ideas 4, c-14 idea 3. Build: tree diff view with a click that selects the object in the open engine; layout translate between Unity YAML and Unreal stand-in. Size M. Who AGY. Deps CD-5 for highlight. Check: phone view of a diff.

Not covered by any report (no task possible from them): Unreal 4.27 conversion and "ForMigration" (tracked only in WORK_LIST lines 18 and 42); Unity 2D scene work (already 🔨 in WORK_LIST).

---

## 4. EVERYTHING ELSE (X)

### 4a. Editors to pro level (c-01, c-02, c-03, c-04, c-11)

**X-1 Picture: LaMa object remove and SAM 2.1 cached tap select** — PARTIAL (SD inpaint, BiRefNet, single-tap SAM exist in `plugins/image-editor`; `LaMa` only in the model catalog). Why: c-01 Phase 1, c-11 §1.7. Build: LaMa ONNX erase (200 ms), SAM embedding cache plus decoder per tap, crop-and-stitch for inpaint/outpaint, coalesced pointer events. Size M. Who AGY. Deps none. Check: phone tap-erase.

**X-2 Picture: 8-bit mask channel, refine edge, marching ants** — NEW. Why: c-01 Phase 2. Build: selection as grayscale mask, guided-filter refine, marching-squares outline. Size M. Who AGY. Deps none. Check: feathered cutout on 390 px.

**X-3 Picture: live adjustment layers (WebGL2 LUT)** — NEW. Why: c-01 §2, c-11 §1.5. Build: curves/levels/HSL as non-destructive layers. Size L. Who LEAD. Deps none. Check: compare against known outputs.

**X-4 Picture: copy-on-write tile history** — NEW. Why: c-01 §2 (>1.2 GB undo). Build: 64 px tile CoW store replacing full snapshots. Size M. Who AGY. Deps none. Check: memory test with 30 states.

**X-5 Picture: game-texture tools (seamless tile, Sobel normal, ORM packer), IC-Light** — NEW. Why: c-01 Phase 3. Build: three pure functions plus ComfyUI IC-Light flow. Size M. Who LOCAL for the pure ones, AGY for IC-Light. Deps GE-14 helpful. Check: unit tests; output into Unity.

**X-6 3D: modifier stack with manifold-3d** — NEW (no `manifold` in code). Why: c-02 Phase 1, c-11 §2.2. Build: Boolean, array, mirror, bevel, solidify, decimate with dirty-flag cache. Size L. Who LEAD. Deps none. Check: watertight boolean test meshes.

**X-7 3D: xatlas UV and 2D UV viewport** — NEW. Why: c-02 Phase 2. Size M. Who AGY. Deps none (hand-off to image editor).

**X-8 3D: sculpt brushes with BVH, touch sliders** — NEW. Why: c-02 Phase 3. Size L. Who LEAD. Deps GE-5 gesture machine.

**X-9 3D: rigging, weight paint, IK, UniRig through ComfyUI** — NEW. Why: c-02 Phase 4. Size L. Who LEAD. Deps ComfyUI runtime (X-26).

**X-10 3D: dope sheet and complete GLB export** — NEW. Why: c-02 Phase 5. Size L. Who LEAD. Deps X-9.

**X-11 Sound: AudioWorklet multitrack with clip slip and crossfades** — NEW (no AudioWorklet). Why: c-03 Phase 1, c-11 §3. Size L. Who LEAD. Deps none.

**X-12 Sound: Basic Pitch hum-to-MIDI spike, then SoundFont playback** — NEW. Why: c-03 Phase 2 (WORK_LIST: S spike first). Build: Web Worker transcription at 22.05 kHz, `spessasynth_lib` playback. Size M (spike S). Who AGY. Deps none.

**X-13 Sound: mixing console (EQ, sidechain) and neural stems/cleanup** — NEW. Why: c-03 Phases 3-4. Build: channel strips, 4-band EQ, compressor graph; HTDemucs 4-stem, DeepFilterNet 3, loop-point export. Size L. Who LEAD. Deps X-11.

**X-14 Video: ducking controls, ffmpeg silencedetect, bidi marks in SRT/ASS** — PARTIAL (ducking exists in `video-cut.ts`; `silencedetect` absent). Why: c-04 Phase 1. Size S. Who LOCAL. Deps none. Check: Hebrew punctuation in exported captions correct.

**X-15 Video: 3D LUT pipeline and real-time GLSL transitions** — PARTIAL (transitions exist but are rendered at export; player shows them). Why: c-04 Phase 1-2. Build: `.cube` parser and WebGL2 tetrahedral LUT; live shader transitions. Size M. Who AGY. Deps none.

**X-16 Video: multitrack data model and keyframe curves** — NEW. Why: c-04 Phase 2. Size L. Who LEAD. Deps none.

**X-17 Video: word-level cutting and filler removal** — NEW. Why: c-04 Phase 2. Build: whisper word timestamps in the timeline. Size M. Who AGY. Deps none.

**X-18 Video: WebCodecs proxy playback, B-roll matcher, RIFE/ESRGAN** — NEW. Why: c-04 Phase 3. Size L. Who LEAD for the engine, AGY for RIFE/ESRGAN wrappers. Deps none.

**X-19 Wan in-betweening between two clips with 4n+1 frame math** — PARTIAL (`animate_picture` continue-this-shot exists). Why: c-32. Build: first/last-frame in-between flow, 1/FPS trim compensation, preview latents over the ComfyUI websocket (`comfy-live.ts`), VRAM swap via HeavyGate. Size M. Who AGY. Deps X-26. Check: two clips joined without a stutter frame.

**X-20 Editors on the phone (fixed playhead, bottom sheets)** — NEW. Why: c-11 §5.2, WORK_LIST. Build: design board first, then a touch layout shared across the four editors. Size M. Who AGY after LEAD board. Deps none.

### 4b. Models, runtimes, devices, hub

**X-21 Kokoro Hebrew voice** — NEW (`kokoro.ts` says Hebrew stays with system voices). Why: c-34. Build: `phonikud` ONNX diacritics then `avris/kokoro-hebrew-saspeech`; stream chunks over websocket. License is non-commercial: show in Settings and keep off by default. Size M. Who AGY. Deps none. Check: Hebrew sentence on the phone.

**X-22 Hub builder (one-click Cloudflare deploy)** — NEW. Why: c-23, WORK_LIST "hub builder". Build: wizard with a scoped token (Workers Scripts, Custom Domains, Secrets), upload the built Worker bundle, set `ALLOWED_EMAIL`/`GOOGLE_CLIENT_ID`, poll `/api/health`; Tailscale Funnel fallback. Size L. Who LEAD. Deps none. Check: deploy to a throw-away account; phone completes it.

**X-23 Backup path from phone to PC: finish** — PARTIAL (`packages/shared/src/direct-path.ts`, `tailscale-watch.ts`). Why: c-37. Build: hub hot-write reduction (presence in memory, batched audit flush), `/ws/signal` for WebRTC signalling, status-bar icon showing the active path (local / hub / Tailscale). Size M. Who AGY. Deps none. Check: simulate hub 503; phone switches path.

**X-24 Cloudflare hub: avoid the 100k row-write limit** — part of X-23 (kept as one task).

**X-25 Installer watchdog (silent update failure)** — NEW (WORK_LIST line 18). Why: c-next-1 NEW-8 (no report produced), c-16. Build: detect the installer exit, show the error, free the "is being installed" lock after a timeout, process mutex. Size S. Who LOCAL. Deps none. Check: simulated failing installer in tests; real update on the PC.

**X-26 Embedded headless ComfyUI runtime manager** — PARTIAL (`comfy-manager.ts`, `comfy-live.ts`, `comfy-flows.ts`). Why: c-27. Build: `uv` relocatable Python 3.12 on the heavy-data drive, `POST /api/free` after every job, snapshot manifest (node SHAs, wheels, `/object_info`) and one-tap rollback before updates, cancellation via `/interrupt`. Size L. Who LEAD. Deps CD-17 for VRAM. Check: update with a deliberately broken node, rollback works.

**X-27 Distributed splitting: decision recorded** — no code: records "route whole jobs, no layer sharding" (c-06, c-13); covered by CH-15.

### 4c. Interface, text, downloads, research process

**X-28 Apply the 72 UI text fixes (Hebrew typos, mismatches, long labels)** — NEW (checked: `i18n.ts` still has "כלי תמונות בכמות"). Why: ui-texts-review.md (branch only) and c-04. Build: apply the suggested strings per file from the review, keep one term per concept, shorten 12 labels for 390 px. Size S per file group. Who LOCAL. Deps none. Check: i18n test plus Playwright screenshots at 390 px.

**X-29 Bidi pass (A6b)** — NEW. Why: c-38 Part A §7, WORK_LIST A6b. Build: `<bdi>` around mixed runs, LTR for code/math, logical CSS in chat, docs panel, tool cards. Size S/M. Who LOCAL. Deps none. Check: a Hebrew line with an English path and brackets renders in order.

**X-30 Navigation and zone colours design board** — NEW. Why: c-18 (unified sidebar, colour-coded zones, light theme). Build: design-doc board comparing zones and a light theme; no code before his comment. Size S. Who LEAD (design doc). Deps none.

**X-31 Highlight-to-edit popover in docs (A4)** — NEW. Why: c-38 Part A §5, WORK_LIST "Later". Size M. Who AGY. Deps none.

**X-32 Drive and VRAM janitor** — NEW. Why: c-38 idea 5, WORK_LIST "Later". Build: cache inventory (Unreal DDC, Unity Library, HF models, ComfyUI renders), offer purge with sizes, never inside projects. Size M. Who AGY. Deps none.

**X-33 Localization audit for engine string tables** — NEW. Why: c-38 idea 7, 10. Build: scan `StringTable`/Unity Localization for RTL clipping and punctuation drift, translate, Kokoro voice lines. Size L. Who LEAD later. Deps X-21.

**X-34 Crash replay / flight recorder** — NEW (low priority). Why: c-38 idea 8. Size L. Who LEAD later.

**X-35 Store page packager and docs generator** — NEW (low priority). Why: c-38 ideas 13, 20. Size M each. Who AGY later.

**X-36 Gamepad prompting and voice during fullscreen play** — NEW (low priority). Why: c-38 ideas 9, 19. Size M. Who AGY later; depends on GE-27.

**X-37 Competitor daily review: add a source-data guard** — NEW. Why: c-14, c-16 (1121), c-17 are empty or generic because "no findings were provided" (the weekly report says so itself). Build: in the research task template, refuse to write a report when no sources were found (like the Gemini fallback guard already does) and mark such reports "no data". Size S. Who LOCAL. Deps none. Check: task run with an empty source list produces a "no data" note.

**X-38 Research queue: tasks proposed but never run** — NEW. Why: c-16, c-next-1. Of the 11 proposed topics, these have no report: NEW-1 night-build research (c-16), installer watchdog (next-1 NEW-8). Build: re-queue both as inbox tasks only if still wanted after GE-19 and X-25 ship. Size S. Who LEAD. Deps none.

**X-39 Epic-style downloads (D1-D8)** — DONE (see below).

**X-40 Maintain this synthesis** — each new report adds a row to the coverage table below and its tasks; LEAD. Size S.

(Section 4 therefore holds 40 numbered items; X-24, X-27, X-39 and X-40 are bookkeeping entries that point to tasks elsewhere or to DONE work.)

---

## DONE or already built (skipped)

Visible-control safety (stop hotkey, sensitive-title block, app allow list, per-action approval card, phone live view `ControlLive.tsx`), browser CDP phases 0-3, 6, 7 (`cdp.ts`, `browser-cdp-tools.ts`, extension 0.3.0), UIA layer (`uia-script.ts`, `computer_tree`), vision model catalog and bench, Play-mode VRAM standby, Anthropic `cache_control`, stable tool order and `id_slot`, `--cache-ram`/lookup speed flags and KV f16/q8_0 switch, Auto model and tool groups, helpers with approval cards and persisted runs, per-hunk review core, Unreal MCP preset and plugin enable for 5.8+, Godot bridge/addon/tools, Unity scene tools, night-build engine, Downloads page D1-D8 (c-41), tailscale/direct-path (core of c-37), Wake of devices presence beacons, TRELLIS/Wan/Stable Audio flows, free cloud catalog and route (core of c-13 A), material doc and graph (core of c-14).

---

## Coverage table: every report file

| Report | Tasks |
|---|---|
| `browser-computer-control.md` | CD-2, CD-3, CD-6, CD-16; the rest built (phases 0-3, 6, 7); UIA DONE |
| `c-20261121-04.md` (UI texts; full text `ui-texts-review.md` on an agy branch) | X-28 |
| `c-20261121-14.md` | X-37; ideas covered by GE-28, GE-8; otherwise no task: generic, no sources found |
| `c-20261121-16.md` | no task: report says no data was provided (see X-37) |
| `c-20261121-17.md` | GE-28, GE-8, GE-17 (Godot done as PARTIAL); X-37 |
| `c-20261121-18.md` | X-30 |
| `c-20261121-38.md` | CH-1, CH-3, CH-11, GE-1, GE-4, GE-5, GE-19, GE-27, X-31, X-32, X-33, X-34, X-35, X-36 |
| `c-20261121-39.md` | GE-9, GE-10, GE-11, GE-12, GE-13 |
| `c-20261121-41.md` | no task: already built (X-39, Downloads D1-D8, `Downloads.tsx`, `packages/downloads`) |
| `c-20261121-42.md` | GE-23, GE-14, GE-25 |
| `c-20261122-01.md` | X-1, X-2, X-3, X-4, X-5 |
| `c-20261122-02.md` | X-6, X-7, X-8, X-9, X-10 |
| `c-20261122-03.md` | X-11, X-12, X-13 |
| `c-20261122-04.md` | X-14, X-15, X-16, X-17, X-18 |
| `c-20261122-05.md` | GE-20, GE-21, GE-22, GE-5 |
| `c-20261122-06.md` | CH-15, CH-16 |
| `c-20261122-11.md` | X-1 to X-18, X-20 (umbrella of c-01..04) |
| `c-20261122-12.md` | GE-10, GE-11, GE-13, GE-14, GE-23, GE-20, GE-22 |
| `c-20261122-13.md` | CH-14, CH-15, X-27 |
| `c-20261122-14.md` | GE-24 |
| `c-20261122-15.md` | CD-1 to CD-9, CD-12, CD-14 |
| `c-20261122-16.md` | X-38; proposed topics became reports c-18 to c-27 (see their rows); GE-19 (night builds) |
| `c-20261122-18.md` | GE-6 |
| `c-20261122-19.md` | GE-1, GE-2, GE-3, GE-4 |
| `c-20261122-20.md` | CD-17 |
| `c-20261122-21.md` | CD-3, CD-4, CD-15, CD-16 |
| `c-20261122-22.md` | GE-27 |
| `c-20261122-23.md` | X-22 |
| `c-20261122-24.md` | GE-26 |
| `c-20261122-25.md` | GE-7, GE-8, GE-9, CH-1 |
| `c-20261122-26.md` | CH-12, CH-8 |
| `c-20261122-27.md` | X-26 |
| `c-20261122-28.md` | CH-17 |
| `c-20261122-29.md` | CH-2, CH-8, CH-9, CH-10 |
| `c-20261122-30.md` | GE-15, GE-16, GE-17, GE-18, CH-1 |
| `c-20261122-31.md` | CH-13 (report text is truncated: re-measure) |
| `c-20261122-32.md` | X-19 |
| `c-20261122-33.md` | GE-5, GE-22 |
| `c-20261122-34.md` | X-21 |
| `c-20261122-35.md` | CD-10, CD-11, CD-13, CD-14, CD-12 |
| `c-20261122-36.md` | GE-25, GE-14 |
| `c-20261122-37.md` | X-23 |
| `c-20261122-38.md` | CH-3, CH-4, CH-5, CH-6, CH-7 |
| `c-20261122-next-1.md` | X-25 (installer watchdog), X-38; its other topics produced c-29 to c-38 (see their rows) |

Reports covered: 46 (45 files on main other than `INDEX.md`, plus `ui-texts-review.md` which lives only on an `agy/*` branch and is represented by the c-20261121-04 row).
