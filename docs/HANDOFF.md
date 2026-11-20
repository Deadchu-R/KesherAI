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
1. Read this file, LEAD_GUIDE.md, WORK_LIST.md. Read AGENT_BRIEF.md only before launching an agent.
2. Clone if needed: the repo is Deadchu-R/KesherAI, worked on in /home/claude/kesher.
3. Design doc tools: `export DESIGN_DIR=<the new scratchpad>`, copy tools/design/design_marks.json there, and read the
   design doc (artifact 225udEzmNSSZPHUewaCh7U, read with out_dir $DESIGN_DIR/design2) before the first board.
   Scripts: tools/design/shotboard.py and design_marks.py.
4. Usage: the tracker only sees this chat; compare with docs/usage/history/*.json for the savings over time.

## What does not carry over
- Background agents of the old chat (finish them first).
- The old chat's scratchpad files (anything needed is copied to git above).
- Reminders set "into this chat" (send_later); scheduled tasks on the account stay.

## State (update on each move)
- Last chat: 2026-11-14 → 2026-11-20 (chat 1). Last release: 0.6.401. Hub: hub.roeetal.com (Cloudflare Worker
  kesher-hub, auto-deploys from main). Claude cloud task: "Kesher hub (cloud)" (API trigger only).
