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
- Tokens first: agents per LEAD_GUIDE (Opus builds, Sonnet research/docs, Haiku lookups), small tasks to the task inbox
  (local model / Antigravity), short reads and reports, little browser work. Remind him to /compact after each build;
  a new chat every 1–2 weeks with this file.
- Daily feature review (Roee, 2026-11-20): scheduled task "KesherAI daily feature review vs competitors" (every night 03:17 Israel time, on his Claude account) reviews one area a day in rotation against competitors and writes docs/FEATURE_REVIEW.md (we do better / they do better / missing / ideas) plus ⬜ lines in the WORK_LIST backlog. Each new chat: read the latest FEATURE_REVIEW.md section, keep the task alive, and use its findings when planning.
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
- Last chat: 2026-11-14 → 2026-11-20 (chat 1). Last release: 0.6.402 (2 builds since scan 166; scan due after 3 more).
  Usage numbers of chat 1: docs/usage/history/2026-11-20_chat1.json (partial: only since its last compaction).
  Next up: Roee checks 0.6.402 on the PC (Online in the hub, inbox tasks); then the usability gap list (WORK_LIST).
  Previous build: Hub: hub.roeetal.com (Cloudflare Worker
  kesher-hub, auto-deploys from main). Claude cloud task: "Kesher hub (cloud)" (API trigger only).

## Updating KesherAI on Roee's PC (2026-11-20)
Use the Claude desktop app's built-in browser (remote-devices Claude_Browser tools) at http://127.0.0.1:7420/#/updates: "בדוק עדכונים" → "הורד והתקן", then poll /api/version. No computer-use approval needed (computer-use access expires after 30 min and blocks at night). Overnight runs: no design-doc publishes (prepare boards under tools/design/out/, publish once in the morning with Roee).
