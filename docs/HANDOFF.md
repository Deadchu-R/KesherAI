# Moving to a new Claude chat (Roee, 2026-11-20: about once every 1–2 weeks)

A long chat makes Claude re-read everything on every message. Everything needed lives in git and in Claude's memory,
so a new chat starts from a few small files.

## Start a new chat with this one line
> המשך עבודה על KesherAI: קרא docs/HANDOFF.md, docs/LEAD_GUIDE.md ו-docs/WORK_LIST.md, ותמשיך מהמשימה הבאה ברשימה.

## Before leaving the old chat (the old chat's Claude does this)
1. Wait for running agents to finish, or note in WORK_LIST what each was doing and where it stopped.
2. Push everything (main clean; no uncommitted agent work).
3. Usage: run `python3 -I docs/usage/track.py`, then copy docs/usage/usage.json to
   docs/usage/history/<date>_chat<N>.json and commit (a new chat cannot see old chats' transcripts).
4. Copy the design marks: the scratchpad's design_marks.json → tools/design/design_marks.json, commit.
5. Update WORK_LIST ("Now" section) and this file's "State" below.

## First steps in the new chat (the new chat's Claude)
**HARD LIMIT (Roee, 2026-11-21, after one night of ~66 Claude helpers ate 41% of his weekly usage): at most 2 Claude
helper agents running at any time.** Every other helper job goes through KesherAI's task inbox instead: the local model
(self-work) on his PC or Antigravity. Group small tasks into one helper rather than one helper per task, prefer Sonnet,
keep Opus for complex or security code, give each helper a small focused task, and do small fixes yourself.
**Actively hand work to the PC agents too (Roee, 2026-11-21):** when planning, split the work and keep the task inbox
stocked for KesherAI's local model (small, precise tasks) and Antigravity (research, larger isolated tasks), check what
they finish, and review it before it ships. Don't let the PC agents sit idle while Claude helpers do everything.
0. Helper agents: launch them as general-purpose agents with the `model` named in .claude/agents/kesher-research.md
   (sonnet), kesher-build.md (opus) and kesher-lookup.md (haiku), telling each to read that file and docs/AGENT_BRIEF.md
   first (LEAD_GUIDE "How the work runs").
1. Read this file, LEAD_GUIDE.md, WORK_LIST.md. Read AGENT_BRIEF.md only before launching an agent.
2. Clone if needed: the repo is Deadchu-R/KesherAI, worked on in /home/claude/kesher.
3. Design doc tools: `export DESIGN_DIR=<the new scratchpad>`, copy tools/design/design_marks.json there, and read the
   design doc (artifact 225udEzmNSSZPHUewaCh7U, read with out_dir $DESIGN_DIR/design2) before the first board.
   Scripts: tools/design/shotboard.py and design_marks.py.
4. Hub: pair this chat once so its agents show in the hub's Agents tab (Claude chat):
   `node --import tsx tools/hub-report/hub-report.ts pair <hubUrl>` (LEAD_GUIDE "Show agents in the hub").
5. Usage: the tracker only sees this chat; compare with docs/usage/history/*.json for the savings over time.

## What does not carry over
- Background agents of the old chat (finish them first).
- The old chat's scratchpad files (anything needed is copied to git above).
- Reminders set "into this chat" (send_later); scheduled tasks on the account stay.

## How Roee wants the work done (full list also in Claude's memory, which every chat sees)
- Hebrew only, one answer. After each task a ✅/⬜/👤 report that ends with what is next, then start it (no waiting).
  A short update on every task switch. The work list is docs/WORK_LIST.md; tell him what changed, in text.
- At most 2 Claude helpers at a time (see the hard limit above); the rest go to the local model or Antigravity via KesherAI.
- Tokens first: agents per LEAD_GUIDE (Opus builds, Sonnet research/docs, Haiku lookups), small tasks to the task inbox
  (local model / Antigravity), short reads and reports, little browser work. Remind him to /compact after each build;
  a new chat every 1–2 weeks with this file.
- Daily feature review (Roee, 2026-11-20; moved to Gemini 2026-11-21): research no longer runs on Claude. The Claude scheduled task "KesherAI daily feature review vs competitors" is DISABLED. Each review area goes to the task inbox as a `kind: research`, `executor: gemini` task (free key, automatic, KesherAI 0.6.421+); big research goes to Antigravity (one Run tap). Claude only reads the result files, writes the dated section in docs/FEATURE_REVIEW.md and the ⬜ lines in WORK_LIST. Rotation: next area after the last section in FEATURE_REVIEW.md.
- Research competitors end to end before any new feature; every research goes into docs/RESEARCH_LOG.md with
  "Stopped at:". AI editors: in-depth research (Photoshop, Affinity…).
- Quality: readable, documented (TSDoc), efficient, secure code; Hebrew + English for every text; works at 390 px and in
  remote (phone ↔ PC); editors are independent plugins.
- Tests: only for what changed while working; the full suite before each build. Security/performance scan every 5
  builds (last: scan 166, before 0.6.400; 0.6.401 is build 1 of the next 5).
- Releases: version in 5 package.json files, full checks, commit `0.6.NN: …` with Desktop-he/Phone-he lines, push main,
  then `git push -qf origin HEAD:release`; one background wait; three updates (building / available / status).
- Testing on his PC: only through KesherAI itself; close what you open (Unreal etc.), leave KesherAI open.
- Usage credits: he may spend credits already loaded, never reload or buy more; stop when they run out.

## The design doc (artifact https://claude.ai/artifact/225udEzmNSSZPHUewaCh7U)
- **Every night (Roee 2026-11-21): two design-doc updates — one at 21:00 and one at 07:00** (with the morning report). Schedule both as reminders into the running chat each evening (send_later), and send him the link after each.
- Every new or changed screen goes in before the build, in the interface's own style, desktop (1280) and phone (390);
  real Playwright screenshots of the built screen are preferred over mockups. No approval needed; open the doc for him
  after each publish.
- The newest boards get the "השינוי הכי חדש" note (earlier ones gray "עודכן"), also when an existing board changes.
  No glow behind the newest board, no auto-zoom, no marker covering a design; every board visible on the canvas.
- Steps: read the live doc first (keep his edits), tools/design/shotboard.py → design_marks.py → Artifact publish
  (file_path design2/project/canvas.json, root design2, files map) → open.
- KesherAI renders boards itself (2026-11-20, `packages/core/src/design-render.ts`): one JSON per group in
  `tools/design/scenarios/` (page, desktop/phone, he/en, mocked API with fixed times `{"$ago":"40m"}`, steps, title).
  Render: `pnpm design:render [BoardId…]` (needs `pnpm build` + Playwright), or "צלם שוב" on the Design page
  (#/design, also on the phone). It shoots the built app against a fresh empty server (no real data), and writes
  `tools/design/out/kesher/`: `project/canvas.json` + changed `project/*.dc.html`, `shots/*.png`, `publish.json`.
  Only new/changed boards (tolerant picture compare) get the newest note, above the board or beside it, never on one.
  Roee's notes from the Design page go on the canvas beside the board (`dn-<Board>`, from notes.json).
- Sync (Claude publishes; KesherAI never has Claude credentials): 1) pull: read the live artifact and write its
  canvas.json to `tools/design/out/kesher/project/canvas.json` and its version to `tools/design/out/kesher/BASE_VERSION`;
  2) KesherAI renders (or `pnpm design:render`); 3) publish_files with the entries of `publish.json` and
  base_version = BASE_VERSION; 4) write the new version to BASE_VERSION (that tells KesherAI it was published: the
  newest marks and publish.json start over at the next render). New boards: add a scenario, not a one-off script.

## Permissions Roee already gave (and limits)
- Push to main; release by `git push -qf origin HEAD:release` (never force-push main). Commit without asking.
- Use his Chrome / the built-in browser for his own accounts when he asks (Cloudflare, Google Cloud, claude.ai): no
  passwords, no purchases, he enters keys/tokens himself; close the tabs opened.
- Create/edit scheduled tasks on his Claude account for KesherAI (the hub's cloud task exists).
- KesherAI may push only agy/* and kesher-inbox. Antigravity only on his own Run tap (PC or phone), one task at a time,
  10 a day by default, Gemini's default model.
- Downloads only with his yes; permanent deletes only with his yes. Nothing in git may show his email, Windows user
  name or personal paths.

## Priority order (Roee, 2026-11-20)
1) Agents; 2) everything from a normal chat like Claude (auto tool choice: computer, browser, documents, code); 3) game-engine features that work without the engine open, offline and remotely; 4) the rest. Details: top of WORK_LIST.md.

## The full wish list
- docs/WORK_LIST.md (now / next / waiting on Roee) and docs/FUTURE_FEATURES.md (longer term).
- Next focus (2026-11-20): finish the agents work in the hub (0.6.402), then focused usability from the Gemini research
  (RESEARCH_LOG 2026-11-20): token routing + KV cache + footer; typed chat blocks; Unity core toolset at 100%;
  ComfyUI → Unity demo. Start with a gap list against the code.

## State (update on each move)
- Chat 3, morning 2026-11-22 07:00: last release 0.6.443 (installed on the PC). Night 21–22.11 summary in WORK_LIST "Night 21–22.11"; design doc night artifact updated at 07:00 (bcb0036a, 104 new + 55 updated boards). Unreal plugin 0.1.32 installed in all 5.x projects (5.4 needed __has_feature define + no shared PCH). Open: ArcadeSurvivorCPP needs Unreal 5.5; ForMigration 4.27 conversion (local agent blocked by 2 Windows test failures); Gemini research queue c-39/40/42 and c-20261122-01..06 waits for the free quota; local chat speed (A7) not measured yet.
- Today (0.6.421–0.6.435): research tasks in the inbox (free Gemini automatic with model fallback + 503 retry; Antigravity one Run tap per task, unsure steps refused); no-payment guard; phone approval notifications with buttons (sealed); mic/camera permission on the phone; background recording on the phone with Resume (APK 0.6.428); Open mind live progress, implicit ideas, "Analyse again" by depth, "Start over", whisper-loop trimming, app-language + "My languages" auto-detect; web search fallbacks (DDG Lite works on the PC; Bing returns junk → relevance check) + default engine choice + optional Tavily/Brave keys; translator + Translate page; load on demand for every engine; engine plugins (Unity 2021.3+, Unreal install-all, Convert with AI); hub: Gemini tasks, step estimates, shared board, Ask again; songs → make_music with lyrics; no invented links; PDF export; "Auto" model routing.
- PC models: main chat Qwen3.6-27B Q4_K_M (E:, loaded, active); DictaLM-3.0-24B kept for Hebrew writing; research helpers = gemini-flash-latest (free key, no billing); Qwen-Image; Qwen3 Embedding. Auto router small model (Qwen3.5 2B) recommended, not downloaded (needs Roee's yes).
- Rules set today: at most 2 Claude helpers at a time; research never on Claude (Gemini/Antigravity); the Claude daily-review scheduled task is disabled; artifacts kept 1 day in CI (old ones deleted).
- Waiting on Roee: update the phone app; open the hub app once (new service worker); $0 Actions budget on GitHub; real tests (computer control, Unreal install-all, Unity 2022.3 package, a song with lyrics, PDF export, Auto model); Chrome extension 0.3.0 approval; hub ↔ Claude connection (hub.roeetal.com blocked from chat 3's cloud; works from a new chat); Run taps for Antigravity tasks t176/t177; optional free Tavily key; privacy choice for cloud in Open mind/incognito (kept local for now).
- Next for the new chat: security scan 172; Gemini research results c-20261121-20..22 (run after the quota reset ~10:00) → FEATURE_REVIEW + WORK_LIST; recurring research tasks in KesherAI (daily/weekly); research choice in the phone's "+ Task" + report on the task page; one design-doc publish of today's boards (tools/design/scenarios: ask-notify, hub, hub-board, engine-plugins, translate, ideas, web-search, speech-languages, browser, auto-model).

## Updating KesherAI on Roee's PC (2026-11-20)
Use the Claude desktop app's built-in browser (remote-devices Claude_Browser tools) at http://127.0.0.1:7420/#/updates: "בדוק עדכונים" → "הורד והתקן", then poll /api/version. No computer-use approval needed (computer-use access expires after 30 min and blocks at night). Overnight runs: no design-doc publishes (prepare boards under tools/design/out/, publish once in the morning with Roee).

## Standing rule (Roee, 22.11 10:04): move work to KesherAI
Where KesherAI supports it, send work to it instead of Claude helpers, to save Claude usage: research → Antigravity/Gemini inbox tasks; code tasks → Antigravity inbox tasks with a model (Claude Opus 4.6 via Antigravity for conversions/builds, Flash for small); PC actions → POST /api/control/tasks (computer tasks) instead of Claude screenshots. Claude keeps: leading, task writing, review of agy/* branches, merges, releases, Roee's updates. Claude helpers only for what KesherAI cannot do yet.

## Standing rule (Roee, 22.11 11:25): "what to research next" results
Every time an Antigravity "what to research next" task finishes (c-20261122-16 and the standing c-<date>-next-N copies), Claude reads its report, writes Roee the insights in Hebrew in the chat (industry moves, what we are missing, the proposed tasks), and adds the proposed tasks to the inbox (oldest-first order).
- Research reports land on agy/* branches (Antigravity) or kesher-inbox results/ (free Gemini). Claude copies each finished report into docs/research/<id>.md on main (redacted) and refreshes docs/research/INDEX.md, so later research agents see it and don't repeat topics.
- Token savings (Roee, 22.11): every new way we find to save tokens → add it to docs/token-savings/README.md, update the interview deck (Slides artifact slug 0ad86683-0df1-4379-ad7a-d3526e600b53, practices slide; charts when numbers change) and regenerate docs/token-savings/kesherai-token-savings-en.svg / -he.svg (for his website).
