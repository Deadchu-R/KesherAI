# Testing KesherAI

What runs on every version, and how to run it yourself. A release is published only when all of it is green
(`.github/workflows/ci.yml`, called by `release.yml`).

| Layer | What | Where |
|---|---|---|
| Lint, types, unit tests | `pnpm lint`, `pnpm typecheck`, `pnpm test` (`node:test`, next to the code) | CI job `check` |
| Smoke test | The built server starts empty, answers, serves the interface, refuses a foreign website | `scripts/smoke.mjs` (Linux and Windows) |
| Interface check | Every main screen at 1280, 390 and 360 px: no page error, nothing too wide, accessibility, speed | `scripts/ui-check.mjs` |
| End-to-end suite | The key flows in a real browser, on computer and phone, plus security checks | `scripts/e2e.mjs` (CI job `e2e`) |
| Windows | Windows-only code (cmd quoting, paths with spaces) | CI job `windows` |
| Security scans | `pnpm audit`, gitleaks, Semgrep, CodeQL | CI job `security`, `semgrep.yml`, `codeql.yml` |

## The end-to-end suite (`pnpm e2e`)

`pnpm e2e` builds the packages and the web app, then runs `node scripts/e2e.mjs [outDir]` (default `e2e-shots/`).
It takes about one minute. Without a rebuild: `node scripts/e2e.mjs` (the built files must be current).

**Setup (nothing outside a temp folder is touched).** The built server starts with a temporary data folder (the name
has a space on purpose), a temporary home folder with two fixture projects (`Unity Projects/E2EUnity` with a YAML
scene, `Documents/Unreal Projects/E2EUnreal` with a `.umap` file), remote access on with a known token, and a fake
model (`scripts/e2e/fake-model.mjs`: a small OpenAI-style server). The fake model streams a slow answer, calls the
`document` tool when a message says `TOOL`, and answers a rewrite request (`REWRITE`) with a fixed text.

**Flows**, at 1280 px and at 390 px (the phone pass goes through the computer's network address with the pairing token,
so it is a real remote request; without a network address it uses the loopback). Each step is checked and gets a
screenshot:
open the app, new chat and send, the streamed answer with the live turn line, a tool card, a second message queued
while the first is answered (and answered in order), the document panel (select text, "Edit this", the mock rewrite,
accept, the saved text), Downloads, the Unity and Unreal stand-in pages with their fixture projects, Settings > Hugging
Face token (saved on the computer; on the phone it shows only "saved" and no box). A short Hebrew pass at 390 px checks
right-to-left and no horizontal scroll on the main pages.

**Security checks.**
- A foreign website (`Origin: https://evil.example`, `Origin: null`, a preflight, a rebound `Host`) is refused on `/api`.
- From another device: no token or a wrong token is refused; the pairing token is shown only on the computer; the phone
  cannot set the Hugging Face token or list a folder that is not a found project.
- Paths that climb out (`..%2f`, an absolute path, Unity asset, chat file download) never return a system file; the
  guest routes refuse everything without a guest session.
- A saved Hugging Face token and a provider API key never appear in any answer the pages received, in the page or its
  storage, in the server's output, in the access log, or in plain text in the data folder. The config file is left
  out of that last check: a headless server has no secret box (`config.ts`, `useSecretBox`), so it keeps the keys
  there as written; only the desktop app seals them.
- No page error, console error or server 5xx (503 excepted, as in the interface check) during any flow; the server is
  still running at the end.

Any failed check exits with 1 and prints the problems and the end of the server's output. In CI the job uploads the
screenshots as the artifact `e2e-shots` with `retention-days: 1`.

**Adding a flow.** Add a `step("name", async () => { ... })` inside `flows` in `scripts/e2e.mjs`; it runs at both
sizes. Prefer roles, labels and the CSS classes that exist in the code; keep a step under 30 seconds.
