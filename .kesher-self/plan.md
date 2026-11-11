# Self-work plan — 2026-11-11 (branch kesher-self/202611110805)

Goal: work the {cooldown} tasks from the board, in priority order.

## Items

- [x] Environment check: disk space (t9 was blocked on "disk almost full") — C: 142 GB free, E: 206 GB free. OK.
- [x] t9 (p3): ScriptNodes — "add inside" buttons. Blocked earlier this run (t8 not in main); **completed** later this run.
    - Dependency t8 (7611883, `insertStep` + exported `newId`) is not in my branch (only on `kesher-self/202611101109`), but my `csharp-graph.ts` + its test were **byte-identical to t8's parent** (empty `git diff 7611883~1 HEAD -- <files>`), so I brought the dependency in by `git checkout 7611883 -- <the two files>` (file-level copy, no merge/branch-switch, no push) and fixed one stray indent t8 left in `parseCSharp`. t8's new tests now run in the suite.
    - `apps/web/src/ScriptNodes.tsx`: refactored the step defaults into `fresh(kind, target)` (uses the exported `newId`); new `addInside(where: "then"|"else"|"body")` inserts an Action step at the end of the selected Branch's True body (or its False body, created with `??=` when absent) or Loop body via `insertStep`, then selects it. A second `.script-add` row ("הוסף בתנאי / בפנים הלולאה") appears in the side panel only when the selected node is an `if` or `loop`. Works at 390 px (reuses `.row.wrap`/`.script-add`); no new CSS or deps.
    - Full `pnpm lint && pnpm typecheck && pnpm test` green: 396 tests / 392 pass / 0 fail / 4 skip.
    - ⚠ Shell note: on this machine `run_command` is **cmd**, where `;` does NOT separate commands (it's an argument separator) and `%ERRORLEVEL%` expands at parse time — several git checks earlier this run returned garbage. Use `&` between commands and read textual output, not exit codes, for verification.
- [x] t10 (p3, CLAIMED → DONE): Settings.tsx — PermissionsSection to its own file.
  - Moved PermissionsSection + its `Rule` interface to `apps/web/src/settings/PermissionsSection.tsx` (import path per task spec). Added import; removed now-unused `useLibrary` import and the orphaned TSDoc. Settings.tsx −30/+3.
  - Verified: `pnpm lint` + `pnpm typecheck` green; full `pnpm test` 384/389 (1 pre-existing env symlink EPERM, 4 skips) — unrelated to this UI move.
- [x] t17 (p3, CLAIMED → DONE): claude-code-import — also turn Task (subagent) tool calls into one line.
  - Added a `Task` case to `toolLine` (packages/core/src/claude-code-import.ts): shows the subagent's `description` (falls back to `subagent_type`, then `prompt`; "delegated a subtask" when empty). +3 test assertions in claude-code-import.test.ts.
  - Full `pnpm lint && pnpm typecheck && pnpm test` green (385/0/4). Core-only change, no UI.
- [x] t11 (p4, CLAIMED → DONE): Settings.tsx — StartupToggle and HttpsCard to their own files.
  - `apps/web/src/settings/StartupToggle.tsx` (with its TSDoc) and `apps/web/src/settings/HttpsCard.tsx` (with its `Https` interface). Imports added in Settings.tsx; both definitions removed (Settings.tsx 555→499 lines). `desktop`/`api`/`getLocale` still used by the rest of Settings.tsx, imports kept.
  - Full `pnpm lint && pnpm typecheck && pnpm test` green (385/0/4).
- [x] t12 (p4, CLAIMED → DONE): Settings.tsx — Phone section to its own file.
  - `apps/web/src/settings/PhoneSection.tsx` (was `Phone()`, renamed to `PhoneSection` to match the other extracted sections): moves the `Remote` interface, `APK_URL`, the QR/anywhere logic; imports `StartupToggle` + `HttpsCard` (rendered inside it). Settings.tsx: `<Phone />` → `<PhoneSection />`, removed `QRCode`/`AnywhereMode`/`TunnelInfo` imports and the `Remote` interface. File down to 358 lines.
  - Full `pnpm lint && pnpm typecheck && pnpm test` green (385/0/4).
- [x] t13 (p4, CLAIMED → DONE): git-panel — detached HEAD and "no commits yet" tests.
  - `packages/core/src/git-panel.test.ts`: two new tests. `parseStatus` unit test — `## HEAD (no branch)` → branch undefined; `## No commits yet on main` → branch "main". And a real-repo test: a fresh repo (no commits) gives `repo: true`, no `head`, the untracked file listed; after the first commit the branch is the default one; after `git checkout --detach <sha>` the state has no branch but `head.sha` is that sha's short form.
  - Full `pnpm lint && pnpm typecheck && pnpm test` green (387/0/4).
- [x] t14 (p5, CLAIMED → DONE): Git panel — comment on a diff line (UI only, no new server route — reuses onFixInChat).
    - `apps/web/src/ide/GitPanel.tsx`: diff lines in the file-staging section are clickable → a `picked` state (path + new-file line number via a `lineOf()` helper over hunk headers; deleted lines report line 0). A comment box appears under the picked line; submitting sends the file, line context, quoted line and the user's comment to the code chat via the existing `onFixInChat` wiring (separate comment-text state, does not clobber the success-pill `note`).
    - `apps/web/src/ChatCards.tsx`: `Diff` got an optional `onLine?: (i: number, line: string) => void` and a `.diff.clickable` class when present. `styles.css`: `.diff.clickable span { cursor: pointer; }` + `.diff-comment` grid. No new deps; works at 390 px.
    - Full `pnpm lint && pnpm typecheck && pnpm test` green (387 pass / 0 fail / 4 skip).

## Decisions
- Order = board priority p3 → p5; t9 first.
- Each item ends with: check_code + pnpm typecheck + pnpm test (and eslint on changed folders).
- Phone check: any UI change must work at 390 px.

## Blockers
- (none so far)

## Fixes made this run
- **Pre-existing test failure** (`packages/agent/src/session.test.ts` — "paths outside the project are refused"): the *junction* symlink was already guarded for Windows EPERM, but the *regular* (dangling) symlink one line later was not, so its `EPERM` escaped and failed the suite. Added the same guard (skip the dangling-link assertions when regular links aren't allowed — needs Windows Dev Mode/admin, which I won't enable). `resolveInWorkspace` logic untouched. Full `pnpm lint && pnpm typecheck && pnpm test` now green: 385 pass / 0 fail / 4 skip.
