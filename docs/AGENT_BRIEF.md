# Brief for Claude's helper agents

One file with everything a helper agent needs to work on KesherAI, so it does not have to read the main
conversation. The main Claude session (the "lead") keeps Roee's rules, talks to Roee, publishes the design doc and
makes releases. Helper agents research or build one task each and report back to the lead.

Read first: [AGENTS.md](../AGENTS.md) (layout, how to work, commits, safety, quality). For deeper background only
when the task needs it: [CODE_GUIDE.md](CODE_GUIDE.md), [ARCHITECTURE.md](ARCHITECTURE.md).

## The two kinds of helper

**Research helper.** Looks into how others (competitors, open-source tools, papers) do one feature, end to end.
- Writes the result into [RESEARCH_LOG.md](RESEARCH_LOG.md) as a new dated entry: what each one does, what to take,
  what to leave, the plan for KesherAI, and a "Stopped at:" line.
- Answers the lead with at most 15 lines: the decision, the plan in steps, open questions. Not the whole research.

**Build helper.** Builds one task that the lead describes (with the research entry's name when there is one).
- Works on `main` in `/home/claude/kesher`. Does not push, does not release, does not publish artifacts.
- Commits its own work (one commit per task) with the commit format in AGENTS.md and the lead's trailer lines.
- Answers the lead with at most 15 lines: what changed (files), how it was checked, anything left or doubtful.

## Rules that are easy to miss
- Privacy: nothing in code, tests, docs or commits may show Roee's email, Windows username or personal paths.
- Never type passwords, keys or tokens. No purchases. No downloads into the repo without the lead asking Roee.
- Quality first: readable, documented (TSDoc on public functions), efficient and secure code. Match the code around.
- Every user-facing text: Hebrew and English (`L(he, en)`), and it must work on a 390 px phone and in remote
  (the phone app talking to the PC through the server; never assume the page runs on the PC).
- Editors are independent plugins (`plugins/*-editor/ui/`). Shared helpers such as `add-media.js` are copied into
  each editor, not imported across plugins. A change to one copy goes into every copy.
- New or changed screens: say so in the report (which screen, what changed), so the lead updates the design doc.

## Checking the work (cheap first, full before a release)
- After each change: `pnpm -s typecheck` and `pnpm -s lint` for the whole repo (they catch cross-file breaks).
- Tests: only the files for what changed, from the repo root:
  `node --conditions=source --import tsx --test --test-force-exit packages/core/src/x.test.ts`. The lead runs the full `pnpm -s test` before a build.
- Keep output short: pipe long commands through `tail -n 30`; report failures, not whole logs.
- Browser checks: Playwright (Python `async_playwright` or Node `require('playwright')`, Chromium is installed; do not
  run `playwright install`). Check the page by its text and DOM; open a screenshot only when the look itself matters.
- After test runs, the disk can fill with temp folders: `find /tmp -maxdepth 1 -name 'kesher-*' -mmin +5 -exec rm -rf {} +`.

## What stays with the lead
- Talking to Roee, the work list ([WORK_LIST.md](WORK_LIST.md)), the design doc, releases (version bump in the five
  package.json files, full checks, push `main` and `release`), and the security scan every 5 builds.
