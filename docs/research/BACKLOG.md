# Research backlog

Hand-written tasks for KesherAI's work loop (Settings › Task inbox › Keep the work loop running). The PC reads this
file from `main` together with the research reports in this folder (at most every 30 minutes) and turns each task
below into an inbox task when a line has room: fewer than 3 waiting for Antigravity (and today's cap and quota allow
it), for the local model, or for OpenCode Go while one of its free models is open. Tasks here come before the
reports' own tasks.

## Format

One block per task under `## Tasks`, the same format the research reports use (packages/core/src/research-tasks.ts):

```
### BL-1: Title of the task
Size S · Who LOCAL
What to build, which files, how to check it.
```

- Id: 1–4 capital letters, a dash and a number (`BL-1`, `BL-2`, …). Never reuse an id: a task is made once per id.
- `Size S|M|L` (default M). `Who LOCAL|AGY|LEAD` (default by size: S local model, M Antigravity, L lead).
  Lead tasks are never picked by the loop; they wait for Claude and Roee.
- Write `DONE` (or `PARTIAL`) at the start of the text when it already exists; DONE tasks are skipped.
- No personal details (emails, user names, personal paths).

When this list is empty and the reports have nothing left for Antigravity, the loop offers the standing
"what to research next" task (at most once a day, Run starts it) so new research refills the backlog.

## Tasks
