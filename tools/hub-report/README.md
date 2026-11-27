# hub-report: the Claude chat's agents in the Kesher Cloud hub

The Claude chat that develops KesherAI (the lead session in a cloud container) and the research, build and lookup
agents it launches show live in the hub's **Agents** tab, in their own group **Claude chat / צ׳אט Claude** (💬), and
the chat appears on the **Devices** screen. This small CLI is how the chat reports them.

Run from the repo root (Node 22, `tsx` from the repo's dependencies):

```bash
node --import tsx tools/hub-report/hub-report.ts pair <hubUrl>
node --import tsx tools/hub-report/hub-report.ts start <runId> --kind research|build|lookup --model <name> --title "<short title>"
node --import tsx tools/hub-report/hub-report.ts step <runId> "<short label>"
node --import tsx tools/hub-report/hub-report.ts done <runId> ["<summary, at most 300 characters>"]
node --import tsx tools/hub-report/hub-report.ts failed <runId> "<reason>"
```

- **pair**: pairs this container as a device of kind `claude-chat` with the usual code flow. It prints the code and
  this chat's 6-digit key fingerprint; approve the code on the hub's Devices screen after checking the fingerprint
  matches. It waits up to 100 seconds; run it again to keep waiting (same code until it expires).
- **start / step / done / failed**: update the run and send it. A run id is letters, digits, `_` and `-` (≤64).
  The title starts with the kind's icon (🔎 research, 🔨 build, 📖 lookup).
- Exit codes: 0 sent, 1 an error (the message says why), 2 not paired or removed on the hub (pair again).

## How it works
Each report is one short connection, like the PC's link: a one-use ticket over HTTPS (`POST /api/ticket` with the
device token, rotating it when the hub asks), then the device WebSocket: `hello`, the hub's `welcome` with the paired
devices, one sealed `agent_event` per phone (the hub page and the phone's Cloud tab are phones) in an `agents` frame,
then it closes. The batch carries the run's whole state, so a missed batch is repaired by the next one; events not
delivered are kept and sent with the next report.

The hub treats `claude-chat` as a reporter only: it may send `agents` frames without any PC opt-in, its opt-in is
fixed (no tasks, local model or Antigravity), and it neither sends nor receives relayed messages (tasks, results,
approvals). It has no heartbeat, so a viewer shows its running agent as stale only after an hour without a report.

## Privacy and keys
- Sent: titles, short labels, the model name and a summary the lead writes, sealed end to end (AES-GCM under an ECDH
  key only this chat and each viewer can derive; the hub cannot read them). Never prompts, file contents or output.
  Text is cleaned by the share scrubber first (local paths, keys and tokens are hidden), one line, capped.
- The device key and token live only in `~/.kesher-hub/claude-chat.json` (folder 700, file 600), never in the repo
  (`.kesher-hub/` and `claude-chat.json` are git-ignored in case). `KESHER_HUB_HOME` moves the folder (tests).
- To stop: remove the device on the hub's Devices screen and delete the file.

## Tests
`node --conditions=source --import tsx --test --test-force-exit tools/hub-report/report.test.ts` (state and events,
scrubbing, arguments, sealing as the viewer reads it, file modes) and `apps/hub/src/hub.test.ts` (the hub accepts
the kind and keeps it to activity only). Typecheck: `tsc -p tools/hub-report/tsconfig.json` (part of `pnpm typecheck`).

## agents-status.mjs: the "Running now" list in KesherAI
`node tools/hub-report/agents-status.mjs set|done|fail <id> [title] [model] [--note "text"]` updates `claude/agents.json`
on the `claude-status` branch and pushes it in one command (git plumbing only: the working tree and branch stay as
they are; the branch is not main, so no CI and no release). The PC reads it from `origin/claude-status` after the task
inbox's fetch and shows it on top of Settings > Agents' work and the hub (minutes running; "maybe stuck" after 45
minutes without a `set`). At most 10 entries; finished ones go after a day. Ids: letters, digits, `_`, `-`.
