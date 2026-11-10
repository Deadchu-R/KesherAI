# Working on KesherAI

Rules for any coding agent in this repository (KesherAI's own code chats and self-work read this file).

## Layout
- `packages/core`: the local server (routes in `src/routes/`, one file per area).
- `packages/agent`: the coding agent (tools in `src/tools.ts`, the loop in `src/session.ts`).
- `packages/providers`: model providers. `packages/shared`: shared types and helpers.
- `apps/web`: the interface (React). `apps/desktop`: the Electron app.
- `docs/`: VISION.md (plans), RESEARCH_LOG.md (research), SECURITY_REVIEW.md.

## How to work
- Small steps: one item, then check, then the next.
- Big files: search first, then read_file with offset/limit. Change them with edit_file; never rewrite a whole existing file.
- Tests are `node:test` + `node:assert/strict` in `*.test.ts` next to the code (not vitest).
- Check after each item: `pnpm -s typecheck && pnpm -s test`.
- The interface works on the computer and on the phone (390 px wide). Hebrew and English: short components use `L(he, en)` with `getLocale()`; shared words go in `apps/web/src/i18n.ts`.
- Every public function gets a TSDoc comment (what it does, its parameters).
- Do not run prettier. Do not add dependencies without asking.

## Commits
- First line: what changed (for a release: `0.6.NN: …`). Then a short body.
- Then these two lines, in Hebrew, for the update notes:
  - `Desktop-he: …` (what changed on the computer)
  - `Phone-he: …` (what changed on the phone)
- Self-work never pushes, merges or releases. Releases are Roee's (or Claude's): the version bump in package.json, apps/desktop, apps/web, packages/agent and packages/core, then push to `main` and `release`.

## Safety
- Never type passwords, keys or tokens. Never change system or security settings.
- Ask before deleting files outside the project, and before downloads.
