# KesherAI in Claude (the hub as a custom connector)

The Kesher Cloud hub (`https://hub.roeetal.com`) is a remote MCP server that Claude can use as a custom connector.
With it, Claude in claude.ai (web, desktop app, phone app) can see and run your KesherAI tasks. It is free on your
Claude plan: custom connectors are part of the plan, and the hub runs on Cloudflare's free tier.

## Connect it (once)

1. **On the PC first:** KesherAI › Settings › Kesher Cloud › tick **"Claude connector may read and run"**. It is off by
   default. Without it Claude sees only what the hub itself knows (devices, agents, counts), and the `kesher_*` tools
   answer "turn it on first".
2. In claude.ai: **Settings › Connectors › Add custom connector**. Name: `Kesher`, URL: `https://hub.roeetal.com/mcp`.
3. Press **Connect** and sign in with Google (the hub's own owner account only). The hub page then asks you to allow
   "Claude"; press Allow. To disconnect later: hub page › Settings › Connections › Revoke.
4. In a chat, turn the connector on from the tools menu, then ask, for example: "what's in my task inbox?",
   "run r-20261127-03", "how much Antigravity quota is left?".

## The tools

| Tool | What it does |
| --- | --- |
| `kesher_tasks` | The PC's task inbox: id, title, state, executor, queue place, steps. Filter: open, running, ended, all. Shows the **task board** view. |
| `kesher_task` | One task: state, model, branch, steps so far, the latest steps, its result or why it failed. Shows the **task** view (progress bar and steps). |
| `kesher_add_task` | Adds a task the way "+ Task" does (title and goal; executor `auto` by default, `antigravity` waits for Run). |
| `kesher_task_action` | Run, queue, unqueue, stop, or assign (give it to another executor). Only the buttons the hub page already has. |
| `kesher_quotas` | What is left of each provider (Antigravity, Claude, OpenCode Go, GhostCLI, Gemini, the local model). Shows the **quotas** view. |
| `kesher_approvals` | The approval cards waiting in the PC's chats (tool, why, preview). Shows the **approvals** view with Allow, Deny and Allow for 10 minutes. |
| `kesher_approve` | Allows or denies one card. Needs the connector opt-in **and** "let the connected app answer approval cards" (Settings › Use KesherAI from other apps). Dangerous commands and screen control are never answered from here; Deny always works. "For N minutes" keeps the tool allowed in that chat, as the hub page's "Allow for a while". |
| `kesher_agents` | The PC's agents and the task each works on, with its last step. |
| `list_devices`, `get_agent_status`, `waiting_for_approval`, `list_tasks`, `send_task` | The earlier tools: what the hub itself sees (metadata only), and sending a task to a PC. |

Views (MCP Apps): where Claude shows apps, the board, quotas and task views appear in the chat. Their buttons (Run,
Queue, Stop, Assign) call `kesher_task_action` through Claude. Elsewhere the same tools answer in plain text.

## What stays safe

- Only your Google account can connect (OAuth with PKCE; tokens are kept hashed; hub page › Settings lists and revokes connections).
- The PC decides: while the setting is off it answers nothing. It takes only the requests above (no approvals, no
  settings, no files), at most 30 a minute, and writes each one to its log (`logs/main.log`: what was asked and the
  outcome, never a title or text).
- The hub sends each question sealed to the PC and opens the PC's sealed answer **in memory for that one call only**.
  It is never queued, stored or logged. This is an exception to end-to-end sealing; see docs/SECURITY_REVIEW.md (2026-11-27).
- Answers are scrubbed twice (on the PC and on the hub): home folders, the Windows user name, keys, e-mails and hub tokens are hidden.
- Pausing the hub (hub page › Settings) stops every tool at once.

## Claude Desktop (local)

A direct connection from Claude Desktop on the same PC, with no hub and no sign-in: a Claude Desktop extension (`.mcpb`).

1. KesherAI › Settings › Use KesherAI from other apps: turn the MCP server on, open the **Claude Desktop** tab, press **Download for Claude Desktop**.
2. Double-click `KesherAI.mcpb` (or drag it into Claude Desktop › Settings › Extensions) and confirm. Nothing to fill in: the address (`http://127.0.0.1:<port>/mcp`) is the default and this PC needs no key.
3. Keep KesherAI running. For the task tools also tick Settings › Kesher Cloud › "Claude connector may read and run".

What it is: a zip made on request by `GET /api/mcp-server/claude-desktop.mcpb` (this PC only; `packages/core/src/claude-extension.ts`) with
`manifest.json` (MCPB manifest 0.2, server type `node`, `user_config`: `server_url` and an optional `sensitive` `access_key`, passed to the
bridge as `KESHER_MCP_URL` / `KESHER_TOKEN`; no key is ever packed) and `server/index.js`, the stdio-to-HTTP bridge
`apps/desktop/resources/mcp-bridge.cjs` (the same file the "Claude Desktop" config snippet uses). A key is needed only when
Claude Desktop runs on another computer than KesherAI.

Tools: all of the local MCP server's (chat, models, knowledge, images, speech) plus the hub connector's six task tools
(`kesher_tasks`, `kesher_task`, `kesher_add_task`, `kesher_task_action`, `kesher_quotas`, `kesher_agents`) from
`packages/core/src/mcp-connector-tools.ts`. They go through the same desk as the hub's (`hub-connector.ts`): same allow-list,
30 a minute, scrub and the same opt-in (off: they say how to turn it on). Approvals on the local server stay `kesher_approve`
behind its own switch. Not signed and no auto-update (re-download after an update that changes tools). Unchecked against Claude Desktop itself: run `mcpb validate` on the file once.
