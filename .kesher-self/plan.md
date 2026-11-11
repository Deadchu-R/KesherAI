# Self-work plan — 2026-11-11 (branch kesher-self/202611110805)

Goal: work the {cooldown} tasks from the board, in priority order.

## Items

- [x] Environment check: disk space (t9 was blocked on "disk almost full") — C: 142 GB free, E: 206 GB free. OK.
- [x] t9 (p3): ScriptNodes — "add inside" buttons. BLOCKED: dependency t8 (commit 7611883, insertStep) is not in main (dangling branch). Board marked blocked with explanation.
- [x] t10 (p3, CLAIMED → DONE): Settings.tsx — PermissionsSection to its own file.
  - Moved PermissionsSection + its `Rule` interface to `apps/web/src/settings/PermissionsSection.tsx` (import path per task spec). Added import; removed now-unused `useLibrary` import and the orphaned TSDoc. Settings.tsx −30/+3.
  - Verified: `pnpm lint` + `pnpm typecheck` green; full `pnpm test` 384/389 (1 pre-existing env symlink EPERM, 4 skips) — unrelated to this UI move.
- [x] t17 (p3, CLAIMED → DONE): claude-code-import — also turn Task (subagent) tool calls into one line.
  - Added a `Task` case to `toolLine` (packages/core/src/claude-code-import.ts): shows the subagent's `description` (falls back to `subagent_type`, then `prompt`; "delegated a subtask" when empty). +3 test assertions in claude-code-import.test.ts.
  - Full `pnpm lint && pnpm typecheck && pnpm test` green (385/0/4). Core-only change, no UI.
- [ ] t11 (p4): Settings.tsx — StartupToggle and HttpsCard to their own files.
- [ ] t12 (p4): Settings.tsx — Phone section to its own file.
- [ ] t13 (p4): git-panel — detached HEAD and "no commits yet" tests.
- [ ] t14 (p5): Git panel — comment on a diff line (only if time remains; needs UI + server, may be too big).

## Decisions
- Order = board priority p3 → p5; t9 first.
- Each item ends with: check_code + pnpm typecheck + pnpm test (and eslint on changed folders).
- Phone check: any UI change must work at 390 px.

## Blockers
- (none so far)

## Fixes made this run
- **Pre-existing test failure** (`packages/agent/src/session.test.ts` — "paths outside the project are refused"): the *junction* symlink was already guarded for Windows EPERM, but the *regular* (dangling) symlink one line later was not, so its `EPERM` escaped and failed the suite. Added the same guard (skip the dangling-link assertions when regular links aren't allowed — needs Windows Dev Mode/admin, which I won't enable). `resolveInWorkspace` logic untouched. Full `pnpm lint && pnpm typecheck && pnpm test` now green: 385 pass / 0 fail / 4 skip.
