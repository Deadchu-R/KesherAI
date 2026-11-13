# Architecture review of `packages/core`

Written 2026-11-13 (board task t18). It covers what each big file does, where it can be cut, a step-by-step plan, and the risks. The numbers come from the code on that day (after the t7 split of `conversations.ts`).

## The shape today

- **117 source files and 113 test files** in `packages/core/src`, plus **49 route files** in `routes/` (7,100 lines), one per area.
- Services are built once in `server.ts` and passed to the routes as one object (`KesherServices`, 60 fields).
- Imports mostly go one way: `server.ts` → routes → services. Type-only imports aside, there was one runtime cycle and one file that reached the wrong way; both are listed below.

This shape is sound. The problems are about weight in a few files, not about direction.

## The big files

| File | Lines | What it does | Why it is big |
| --- | --- | --- | --- |
| `server.ts` | 1,222 | Builds every service, registers every route, starts and stops the app | One function, `createKesherServer`, is about 980 lines. It imports 112 files and builds about 50 services in order |
| `computer.ts` | 1,186 | Computer control: screenshots, mouse, keyboard, windows, per operating system | Three backends (Windows, macOS, Linux) and the control class in one file |
| `conversations.ts` | 1,154 | The conversation manager: sessions, tools per chat kind, sending, queues, goals, saving | Was 1,750 before t7. What remains is the manager itself |
| `journal.ts` | 955 | "My day": captures, reading text, day write-ups, meetings | Pure helpers, the capture loop and the `Journal` class together |
| `sdcpp.ts` | 839 | The image engine: install, run, progress, plus video (Wan) setup | The engine class and the video helpers are separate jobs |
| `mcp.ts` | 822 | MCP client: two transports, sign-in, tool naming, the server list | Transports and the manager together |
| `routes/unreal.ts` | 633 | Every Unreal route | 15 imports; several features in one file |
| `routes/library.ts` | 600 | Conversations, projects, messages, events (SSE) | The chat API and the project API together |

## Findings

### 1. `createKesherServer` is the real monolith

It does five jobs in one function:

1. Reads the config and data folder, including "start over".
2. Builds about 50 services, each needing some of the ones before it.
3. Wires them to each other with callbacks (notifications, guard, engine, self-work).
4. Registers hooks and 49 route groups.
5. Starts background work (autoload, routines, tunnels) and defines `close`.

A new developer who wants to add a service has to read all of it to find where theirs goes. Every feature added so far has made this function longer.

### 2. The conversation manager still knows every kind of tool

`toolsFor` decides, by hand, which tools a chat gets: code tools, media, Unreal, Unity, phone, plugins, MCP, board, memory, skills. Each new tool family adds lines there and a field to `ConversationDeps` (24 fields now). A plugin cannot add a tool family the way the core does.

### 3. One runtime cycle (fixed with this review)

`conversations.ts` → `graph-edit.ts` → `conversations.ts` (and the same through `blueprint-test.ts` and `widget-edit.ts`). They only needed `modelTurnFor`. Since t7 it lives in `model-turn.ts`, and the three files import it from there. No cycle is left.

### 4. One import in the wrong direction

`acp-chat.ts` imports `agyPath` from `routes/terminal.ts`. A service should not import a route. `agyPath` belongs in a small file of its own (for example `agy-path.ts`) that both import.

### 5. `auth.ts` is imported by 29 files

Mostly for `isLocalRequest`. That is fine, but it means any change to `auth.ts` rebuilds and retests almost every route. The request helpers (`isLocalRequest`, `pairedDeviceOf`) could live in a tiny `request-origin.ts`, leaving `auth.ts` to the hook itself.

### 6. Per-OS code inside feature files

`computer.ts` and `journal.ts` each carry their own `run()` helper and their own PowerShell, AppleScript and xdotool snippets. The OS-specific parts want one folder (`os/windows.ts`, `os/mac.ts`, `os/linux.ts`) behind one interface each.

## The plan

Each step is one commit, changes no behaviour, and keeps `pnpm typecheck && pnpm lint && pnpm test` green. Steps are ordered so the early ones are safe and make the later ones easier. Marked **S** are small enough for self-work, **B** are Claude's.

### A. Quick, safe moves

| Step | What | Size |
| --- | --- | --- |
| A1 | `agyPath` to its own file; `acp-chat.ts` and `routes/terminal.ts` import it | S |
| A2 | `isLocalRequest`, `pairedDeviceOf`, `pairedDeviceIdOf` to `request-origin.ts`, re-exported from `auth.ts` | S |
| A3 | `sdcpp.ts`: the video helpers (`comfyWanStatus`, `setupComfyWan`, `videoStatus`, `ensureVideoModel`) to `video-setup.ts` | S |
| A4 | `mcp.ts`: `StdioTransport` and `HttpTransport` to `mcp-transports.ts` | S |
| A5 | `journal.ts`: the pure functions (`dayKey`, `skipReason`, `dayStats`, `parseInsights`, `parseMeeting`, `meetingTranscript`) to `journal-parse.ts` | S |
| A6 | Lint rule: a file outside `routes/` may not import from `routes/` (except `server.ts`) | S |

### B. `server.ts` by area

The goal: `createKesherServer` reads like a table of contents.

| Step | What |
| --- | --- |
| B1 | `server/options.ts`: `KesherServerOptions`, `KesherServer`, `WEB_CSP` (types and constants, no logic) |
| B2 | `server/data-dir.ts`: reading the config, "start over", the paths |
| B3 | `server/build-engines.ts`: llama.cpp, the image engine, ComfyUI, the guard, calibration settings. Returns the engines and their `close` |
| B4 | `server/build-chat.ts`: providers, personas, skills, MCP, plugins, the conversation manager |
| B5 | `server/build-remote.ts`: auth, device keys, the access log, tunnels, phone push, notifications |
| B6 | `server/build-extras.ts`: journal, computer control, Unreal, Unity, self-work, routines |
| B7 | `server/register-routes.ts`: the 49 `…Routes(app, services)` calls and the hooks |
| B8 | `server/lifecycle.ts`: what starts after listening, and `close` |

Each builder takes what it needs and returns the services it made plus a `close` function. `createKesherServer` then calls eight functions and merges the results into `KesherServices`.

**How to do it safely:** move one builder at a time, top to bottom in the order the code already runs, so no service is built before what it needs. After each one, run the smoke test (`scripts/smoke.mjs`) as well as the unit tests: it starts the real server.

### C. Tools that register themselves

| Step | What |
| --- | --- |
| C1 | A `ToolGroup` type: `{ id, appliesTo(chat), tools(chat), notes(chat) }` |
| C2 | Each family becomes a group in its own file: media and work (already split in t7), Unreal, Unity, phone, board, memory, skills, MCP, plugins |
| C3 | `toolsFor` loops over the registered groups. `ConversationDeps` loses the fields that only one group needed |
| C4 | The plugin SDK gets `registerToolGroup`, so a plugin adds a family the same way |

This is the change that makes the core modular in the sense a modder cares about. It should come after B4, when the chat services are built in one place.

### D. The rest of the manager

After C, `conversations.ts` is sessions, sending and saving. Two more cuts are then natural:

| Step | What |
| --- | --- |
| D1 | `conversation-queue.ts`: `send`, `drain`, `resumeQueue`, `unqueue`, the goal loop (`setGoal`, `checkGoal`) |
| D2 | `conversation-store.ts`: `scheduleSave`, `saveNow`, `interrupted`, `resumeInterrupted`, `importChats`, `branch` |

### E. Per-OS code

| Step | What |
| --- | --- |
| E1 | `os/run.ts`: one `run(cmd, args, timeout)` for `computer.ts` and `journal.ts` |
| E2 | `computer.ts`: the three backends to `computer/windows.ts`, `computer/mac.ts`, `computer/linux.ts` behind the existing `Backend` interface |

## Risks

| Risk | How to keep it small |
| --- | --- |
| **Order of construction in `server.ts`.** Services are built in an order that matters; moving a block can build something before what it needs | Move blocks in the order they already run. TypeScript catches a use before definition inside one function, but not across builders: the smoke test does |
| **Callbacks that close over local variables.** Many services get `() => config.x` or `() => otherService` closures | Each builder receives a `ctx` object with the config and the services built so far; closures read from `ctx`, never from a local copy |
| **Self-work editing the same files.** Two writers on one big file is how conflicts happen | Claim the task on the board first; the note says which file is locked (as with t7) |
| **A move that changes behaviour by accident** | Move text unchanged, by script where possible (t7 was done that way), one part per commit, tests after each |
| **Tests that reach into private details** | Keep the public methods where they are (as `mediaTools()` stayed on the manager) |
| **Shadowed names** when a method becomes a function (a local `join` hiding an import) | Lint after each move; it reports unused imports |

## What not to do

- **No rewrite, and no new framework** (dependency-injection containers, event buses). The services object passed to routes is simple and works.
- **No splitting into more packages** yet. `packages/core` is one deployable thing; folders inside it are enough until a second consumer exists.
- **No moving and changing in the same commit.** A reviewer cannot check both at once.

## Done with this review

- The runtime cycle through `conversations.ts` is gone (`graph-edit.ts`, `blueprint-test.ts` and `widget-edit.ts` import `model-turn.ts`).
- t7: `conversations.ts` from 1,750 to 1,154 lines, in five new files.

Steps A1 to A5 are on the board as t51–t55 and A6 as t46 (small, for self-work); B is t49 and C follows it (Claude).
