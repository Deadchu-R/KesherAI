# Plan — kesher-self/202611111116 (goal: התחל במשימות Normal)

Board Normal tasks (not {fable}): t21 (claimed by me), t3 (open), t5 (closed — duplicate of t9, already noted on the board). t7/t18/t19 are {fable} = Claude's.

## Items
- [x] Read handoff.md + the board; find the Normal tasks. → t21, t3, t5.
- [x] Inspect t21 (PC load view + Terminate): already shipped in main by b82b562 — `ComputerHub.tsx` `PcLoad` polls `/api/pc-status` (CPU, RAM, per-card load/VRAM/temp/power, what runs) and the Terminate button POSTs `/api/system/terminate` (confirmed word, frees self-work/chats/models/ComfyUI/Antigravity, restarts). Server routes + `pc-status.test.ts` exist.
- [x] Verify t21 end to end: phone layout at 390 px (PcLoad/Terminate visible and usable), then mark t21 done on the board with commit + test evidence. → Verified: popup 320px fits 390px (11px margins each side), anchored to the icon, no width overflow. Found one real issue: on a short screen (landscape / small height) the unbounded popup pushes PcLoad+Terminate below the viewport with no scroll — fixed in styles.css with a phone-only `max-height: calc(100dvh - var(--bar-h) - 16px)` + overflow-y on .hub-pop (same idiom as the model-pop fix at line 1841). Terminate gets 44px on coarse pointers. Marked t21 done on the board (evidence: b82b562, pc-status.test.ts 1/1, this fix).
- [ ] Investigate failing test seen in the run: `packages/core/src/server.test.ts:125` expected `/Echo: ping/`, got `No provider "echo" — add it under Connections`. Real bug vs environment artifact? If real: fix + keep the test (it is the test that would have caught it).
- [x] Inspect t3 (Settings.tsx → one file per section): current `pages/Settings.tsx` is 359 lines and already imports per-section components (AppearanceSection, TelegramSection, ComfySection, …). Decide if it is done → mark done with evidence, or claim + finish the rest. → DONE (this session): extracted ActiveModels/Sync/GoogleDrive/OneDrive to their own files (byte-exact), Settings.tsx 359→106 lines; typecheck+lint+test(398)+build all green; marked done on the board (commit f62a723).
- [ ] Finish with a full `pnpm -s test` + `pnpm -s typecheck` green (KesherAI runs it after each item anyway).

## Decisions
- If a task is already implemented in main, the work is verification + closing it on the board with evidence (commit, tests) — not re-doing it.
- Do not touch {fable} tasks. Do not release/push/merge.

## Blockers
- (none yet)
