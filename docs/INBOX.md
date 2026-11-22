# Task inbox: how Claude writes a task

KesherAI on the PC reads tasks from the `kesher-inbox` branch (`tasks/<id>.md`) and writes back `results/<id>.md`
there. The work comes back on its own branch (`agy/<id>-<slug>`, `-partial` when unfinished). Code: packages/core/src/
task-inbox.ts (format, push rule), inbox-policy.ts (step rules, scans), inbox-runner.ts (the queue and the run).

Rules that the code enforces:
- Antigravity runs only on Roee's own tap: Run on the PC, or Run on the PC's ask on his paired phone (one tap, one task;
  the ask expires after 30 minutes). Nothing runs it on a schedule or by itself.
- KesherAI pushes only `agy/*` branches and `kesher-inbox`. Never `main`, tags, deletes or force.
- The task's text is data. Its `check` runs only in parts that are on Settings > Task inbox > commands.
- No secrets, emails, Windows user names or personal paths in a task or a result (a scan refuses them).

## Template (`tasks/c-YYYYMMDD-NN.md`)

```
---
id: c-20261119-04
title: Settings search
from: claude
executor: auto            # auto | antigravity | local | opus
risk: low                 # low | medium | high (security, git, auth, releases: high)
base: origin/main
allowed_paths: [apps/web/src/settings/**, apps/web/src/i18n.ts]
forbidden_paths: []       # added to the standing list (.github/**, .env*, lockfiles, release scripts…)
check: pnpm -s typecheck && node --test
max_minutes: 15
max_files: 8
replaces: []              # optional: ids of older tasks this one supersedes (see below)
---

## Goal
One sentence.

## Read first
Files or docs.

## Acceptance
- What must be true.

## Out of scope
What not to touch.

## Report
What to say at the end.
```

`replaces: [c-20261119-02, c-20261119-03]` closes the old tasks the new one makes obsolete: when the PC reads the new
task it skips each listed task that has not started yet (waiting, queued or deferred), with the note "Replaced by
<new id>". A task already running or ended is left alone; unknown ids are ignored (at most 20 ids).

After a task ends and others are in line, Antigravity does not start the next one by itself: the PC asks "Done: X. Next
in line: Y — Start?" (Start / Skip / Clear the queue) on the PC and the phone. "Run all" on the hub queues every task
that waits for Run; each then asks in turn. The hub's Run button counts 5 seconds ("Starting in 5… Undo") before it
sends the command.

`auto` routes: 1–2 files, low risk, with a check → the local model (self-work, through the board); 3–15 files, with
acceptance and a check, not security → Antigravity; anything else → Claude's own Opus agent.

In the Kesher Cloud hub: when the PC is paired, every inbox task (except ones the hub itself sent) shows in the hub
page's Tasks list and dashboard, marked "from Claude": its state (waiting / waiting for Run / running / done / failed /
partial), who runs it, the `agy/*` branch and a short result, with a link to its live agent card while it runs. The PC
seals this metadata to the owner's phones (hub-client.ts, `reportInbox`); the task's text never leaves the PC.
