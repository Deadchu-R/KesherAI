# Plan — kesher-self/202611111116 (goal: התחל במשימות Normal)

Board Normal tasks (not {fable}): t21 (claimed by me), t3 (open), t5 (closed — duplicate of t9, already noted on the board). t7/t18/t19 are {fable} = Claude's.

## Items
- [x] Read handoff.md + the board; find the Normal tasks. → t21, t3, t5.
- [x] Inspect t21 (PC load view + Terminate): already shipped in main by b82b562 — `ComputerHub.tsx` `PcLoad` polls `/api/pc-status` (CPU, RAM, per-card load/VRAM/temp/power, what runs) and the Terminate button POSTs `/api/system/terminate` (confirmed word, frees self-work/chats/models/ComfyUI/Antigravity, restarts). Server routes + `pc-status.test.ts` exist.
- [ ] Verify t21 end to end: phone layout at 390 px (PcLoad/Terminate visible and usable), then mark t21 done on the board with commit + test evidence.
- [ ] Investigate failing test seen in the run: `packages/core/src/server.test.ts:125` expected `/Echo: ping/`, got `No provider "echo" — add it under Connections`. Real bug vs environment artifact? If real: fix + keep the test (it is the test that would have caught it).
- [ ] Inspect t3 (Settings.tsx → one file per section): current `pages/Settings.tsx` is 359 lines and already imports per-section components (AppearanceSection, TelegramSection, ComfySection, …). Decide if it is done → mark done with evidence, or claim + finish the rest.
- [ ] Finish with a full `pnpm -s test` + `pnpm -s typecheck` green (KesherAI runs it after each item anyway).

## Decisions
- If a task is already implemented in main, the work is verification + closing it on the board with evidence (commit, tests) — not re-doing it.
- Do not touch {fable} tasks. Do not release/push/merge.

## Blockers
- (none yet)
