# How an app like KesherAI should work

Research from 2026-11-13: what the best apps of this kind do, where KesherAI stands against each point, and what to do next. "This kind" means a local-first AI desktop app with a phone remote, agents that act on the computer, and plugins.

Each section has three parts: what others do (with sources), where KesherAI is today (checked in the code, not from memory), and what to do. The last section is one prioritized list. Tasks from it are on the board.

## The short version

| Area | Where KesherAI is | The biggest gap |
| --- | --- | --- |
| UI and UX | Strong: one menu for computer and phone, settings search, a task board, approvals in one place | No simple mode for a new user, and no command palette |
| Agent UX | Strong: most of the patterns the research names already exist | No receipts with undo for what an agent changed, and no time or step budget per run |
| Accessibility | Middling: labels, focus rings and reduced motion are there | The chat was read aloud word by word (fixed with this research); no screen-reader test yet |
| Hebrew and RTL | Strong: 140 logical CSS properties against 12 physical ones | Mixed Hebrew and code in one line is not isolated everywhere |
| Performance | Good: pages load on demand, the chat shows the last messages only | The main bundle is 513 KB, and nothing measures start time or typing lag |
| Developers | Strong: 24 docs, a code guide, AGENTS.md, a plugin SDK with a scaffold | No rule in lint stops one part of the code reaching into another |
| Modders and plugins | The weakest area | Plugins run inside the server with full access; permissions are declared but not enforced |
| Modularity | Middling: 49 route files, one file per area | `server.ts` builds everything in one 980-line function and imports 112 files |

## 1. UI and UX

### What others do

- **Two levels, not one.** LM Studio has two modes: User ("show only the chat interface, and auto-configure everything") and Developer (everything, including load and inference settings). It used to have three and merged Power User into Developer ([LM Studio docs](https://lmstudio.ai/docs/app/user-interface/modes)).
- **The app chooses the settings, the user can override.** llama.cpp fits a model to memory by itself; LM Studio and Ollama pick GPU layers for the user.
- **A keyboard path to everything.** VS Code, Linear, Obsidian and Raycast all have a command palette (Ctrl+K or Ctrl+Shift+P): type what you want, press Enter.
- **Lists, not cards.** Linear and Material show work as plain rows with a status mark, a title and one quiet line (see RESEARCH_LOG, 2026-11-11).

### Where KesherAI is

- One menu for the computer and the phone (`useAppMenu`), pinned pages, the user's own shortcuts.
- Settings have a search box and nine categories.
- The engine fits models by itself, and "What fits?" and "Calibrate" show and tune it (0.6.105).
- There is no simple mode. A new user sees every page: Unreal, Unity, Pipelines, self-work, My day.
- There is no command palette.

### What to do

1. **A simple mode (default for a new install).** Chat, images, models and settings only. "Show everything" in Settings turns the rest on. LM Studio's two levels are the model: a third level was removed there because nobody could say who it was for.
2. **A command palette (Ctrl+K).** Pages, chats, models, settings by name, and actions ("new code chat", "load model"). The data already exists in `useAppMenu` and the settings search words.
3. **Empty pages that say what to do next.** Every list page with nothing in it shows one sentence and one button.

## 2. Agent UX: when the app acts for you

### What others do

A chat alone fails for agents: they work for a long time, in steps, across programs, and the user cannot see what changed, stop it, or undo it. The interface has to be a control surface ([HatchWorks](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/)). The patterns, and whether KesherAI has each:

| Pattern | KesherAI |
| --- | --- |
| Task board with owners and outcomes | Yes (the shared board) |
| Activity timeline | Yes (the folded activity line in chats, self-work's log) |
| Start, stop, pause, resume | Stop and resume, yes. No pause |
| Autonomy levels (suggest, draft, execute) | Yes (ask, auto-edit, auto, plan) |
| Plan first, then run | Yes (plan mode and `present_plan`) |
| Receipts with undo | Partly: checkpoints restore a folder; there is no "what this run changed" list |
| Evidence for answers | Partly: web sources are linked; knowledge-base answers do not show their passage |
| Approval gates | Yes, in one inbox, on the phone too |
| Safe failure ("I'm stuck") | Yes (BLOCKED, and it now ends cleanly when nothing is left) |
| Memory the user can see and edit | Yes (memory tools and the coach's notes) |
| Budgets: time and steps | Self-work has hours. Chats have none |

On approvals ([Kunal Ganglani](https://www.kunalganglani.com/blog/tool-approval-patterns-ai-agents)):

- **Too many approvals make each one worthless.** In the study cited there, people who approved often missed about one threat in three. Decide by rule what can be decided by rule; ask a person only for judgment.
- **A good preview answers four questions fast:** what will run, what will change, where data goes, which permissions it uses. Show the resolved command, not the wrapper (`npm run x` means nothing).
- **Grants should end:** for a task, or for a time.

### Where KesherAI is

- The always-ask list for dangerous commands, rules scoped to a chat, a model or everywhere, and rules with an end time (`ruleAllows`) match this closely.
- Approval previews show the diff or the raw input.
- A rule kept for one command refuses chained commands. That is the "approve the resolved action" idea.

### What to do

1. **A receipt at the end of each run:** files changed (with the diff), commands run, and one "Undo all" that restores the checkpoint. The data exists (events and checkpoints); the page does not.
2. **Resolve wrappers in the preview:** for `npm run`, `pnpm`, `make` show the script that will run.
3. **A step and time limit per chat run,** shown while it runs, with "keep going" at the limit.

## 3. Accessibility

### What others do

- **Streaming breaks screen readers.** A live region on the answer either re-reads the growing text on every word or drops updates; tokens arrive 5 to 20 times a second, and NVDA, JAWS and VoiceOver each handle that differently ([Tian Pan](https://tianpan.co/blog/2026-04-17-ai-accessibility-streaming-screen-readers)).
- **The fix that works** ([azukiazusa](https://azukiazusa.dev/en/blog/accessible-streaming-chat-ui)):
  - The history is `role="log"` with `aria-live="off"`.
  - A separate, visually hidden `role="status"` region exists from page load and says only "writing", "done", "stopped", "failed".
  - Focus stays in the input after sending.
  - Stop is a real button, and focus returns to the input when it goes away.
  - Each message has a hidden heading ("You", "Answer"), so a reader can jump by heading.
- **`aria-busy` alone is not enough:** readers may ignore it.
- **Test with NVDA,** not only VoiceOver. On Windows that is what users have.

### Where KesherAI is (checked in `apps/web/src`)

- 217 `aria-label`s, focus rings (`:focus-visible`), `prefers-reduced-motion` in 9 places, touch targets of 44 px on the board.
- **The bug:** the whole message list was `aria-live="polite"`. A screen reader re-read the answer as it grew.
- No hidden status line, no per-message headings, no high-contrast (`forced-colors`) rules, no screen-reader pass.

### Done with this research

- The chat history is a log that is not read while it streams, with one polite status line: "Writing an answer", "Waiting for your approval", "The answer is ready". In Hebrew and English.
- The history can be focused and scrolled with the keyboard.
- A first `forced-colors` rule for the marks that carry meaning.

### What to do

1. **A hidden heading per message** (who wrote it), so heading navigation works.
2. **Focus:** returns to the input after Stop; a dialog returns focus to what opened it.
3. **One pass with NVDA** on the five main screens, and write what it finds.
4. **An automatic check:** `axe-core` in the existing `ui-check` script, failing on serious findings.
5. **Answer length as a setting** (short, normal, detailed). It helps screen-reader users and everyone on a phone.

## 4. Hebrew, RTL and mixed text

### What others do

- Direction on the root (`dir`, with `lang`), and styles written with logical properties: `inline-start`, not `left` ([PatternFly RTL handbook](https://www.patternfly.org/developer-guides/right-to-left-handbook)).
- Mirror icons that show direction (back, expand). Do not mirror logos, clocks or media controls.
- Mixed text (a Hebrew sentence with a file path or code) needs isolation, or the punctuation jumps to the wrong end.
- Test with native readers. The right result is not always obvious.

### Where KesherAI is

- 140 logical properties against 12 physical ones in `styles.css`.
- `dir="auto"` on titles and user text; `dir="ltr"` on ids and paths in many places.
- Found on 2026-11-11: a task title starting with a Latin word flips the whole line.

### What to do

1. **Replace the 12 physical properties** (or note why each stays).
2. **A `<Code>` and a `<Path>` component** that always isolate (`dir="ltr"` plus `unicode-bidi: isolate`), used wherever a path, command or id sits in a sentence.
3. **A lint rule against new physical properties** in CSS.

## 5. Performance

### What others do

Electron's own checklist ([Electron docs](https://electronjs.org/docs/latest/tutorial/performance)):

- Do not load code before it is needed.
- Never block the main process or the renderer.
- Check what a dependency costs before adding it.
- Bundle the code.
- No polyfills the built-in Chromium does not need.
- No network requests for things that could be local.

For a chat app, two more: draw only the messages on screen, and do not re-parse the whole answer's Markdown on every token.

### Where KesherAI is

- Pages load on demand (32 chunks); the chat shows the last blocks with "Show earlier messages"; 32 memoized components.
- Polling stops while the tab is hidden (0.6.95 on).
- The main bundle is 513 KB. `styles.css` is one 1,950-line file loaded at start.
- The engine side is measured and tuned (fit, calibration, prompt cache, MTP).
- Nothing measures start time, typing lag, or the cost of a long answer.

### What to do

1. **Measure first:** start to first screen, typing lag in a 200-message chat, and time per token drawn. Three numbers, in the `ui-check` run, with a limit that fails the build.
2. **`content-visibility: auto` on messages off screen:** one CSS line that skips their layout.
3. **Split the main bundle** where the measurement says so (the Markdown and code highlighter are the usual weight).
4. **Streaming Markdown:** parse only the last block while it grows; finished blocks stay as they are.

## 6. Developers who join

### What others do

- VS Code: an API that is small, typed and stable; the app's DOM is never exposed; long work returns a promise and can be cancelled; everything registered returns something to dispose ([VS Code extensibility principles](https://vscode-docs1.readthedocs.io/en/latest/extensionAPI/patterns-and-principles/)).
- Boundaries between parts of the code are kept by a tool, not by memory: lint rules such as `no-restricted-imports`, `eslint-plugin-boundaries`, or `dependency-cruiser` fail the build when one part reaches into another.

### Where KesherAI is

- 24 documents, `CODE_GUIDE.md` (a reading guide), `AGENTS.md`, `FORKING.md`, TSDoc on public functions, tests next to the code (113 test files for 117 source files in core).
- A plugin SDK with a manifest schema and a scaffold (`pnpm create-plugin`).
- No boundary rules in lint. One runtime import cycle exists (`conversations.ts` → `graph-edit.ts` → `blueprint-test.ts` → `conversations.ts`), and one file outside `routes/` imports a route (`acp-chat.ts` → `routes/terminal.ts`).

### What to do

1. **Boundary rules in lint:** routes may import services, services may not import routes; `packages/shared` imports nothing of ours; `apps/web` never imports `packages/core`. Start by failing on new violations only.
2. **Break the one cycle** (see `ARCHITECTURE_REVIEW.md`).
3. **A "first change" guide:** one page that takes a new developer from clone to a merged small fix, with the commands.
4. **An architecture map with a picture** in `ARCHITECTURE.md`: the processes, who talks to whom.

## 7. Modders and plugins

This is where KesherAI is weakest, and where others have learned the most the hard way.

### What others learned

- **Isolation first.** VS Code runs extensions in their own process, so a bad one cannot crash or slow the editor. Extensions load only when needed (activation events), and say in their manifest what they add (contribution points), so the app builds its UI without running their code ([VS Code](https://vscode-docs1.readthedocs.io/en/latest/extensionAPI/patterns-and-principles/)).
- **Unchecked plugins get abused.** ComfyUI had malicious custom nodes (ComfyUI_LLMVISION, a compromised ultralytics). Its answer: a registry with automatic scanning, no `eval`/`exec`, no installing packages at run time, no hidden code, a way to switch off a bad node remotely, and plans for verified authors and a sandbox ([ComfyUI security update](https://blog.comfy.org/p/comfyui-2025-jan-security-update), [registry standards](https://docs.comfy.org/registry/standards)).
- **"Arbitrary code on your server" is honest but not enough.** Open WebUI says its Tools, Functions and Pipelines run any Python on the server, that a community listing is not a check, and that only trusted admins should install them ([Open WebUI](https://docs.openwebui.com/features/extensibility/plugin.md)).
- **Review by hand does not scale.** Obsidian reviewed only a plugin's first version, by hand, and the queue grew past 2,300. It moved to an automatic scan of every version, a scorecard per plugin, and a plan for plugins to state what they touch (network, files, clipboard) before install ([Obsidian](https://obsidian.md/blog/future-of-plugins/)).

### Where KesherAI is

- A manifest (`kesher-plugin.json`) with an API version and a permissions list, checked with a schema.
- Plugin pages run in a sandboxed frame.
- **Plugins run inside the server's process.** The code says so: running each in its own process with only its declared permissions "is on the roadmap". Today a plugin can read any file and open any connection, whatever its manifest says.
- Plugin tools ask for approval as `exec` risk. That is the right default.
- No registry, no scan, no signature, no way to switch a plugin off from outside.

### What to do, in this order

1. **Run each plugin in its own process** with a small message API (the same shape as MCP: tools, resources). The declared permissions become what that process is given: a folder, a list of hosts. This is the one change that makes a plugin ecosystem safe to open.
2. **Show permissions before install,** in plain words, and again when an update asks for more.
3. **Declarative contributions:** pages, tools, categories and settings named in the manifest, so KesherAI can list what a plugin adds without running it, and load it only when used.
4. **A scan on install:** no `eval`, no package installs at run time, no obfuscated code. ComfyUI's list is the starting point.
5. **Only then a public list.** Every version scanned, a scorecard, a remote off switch.
6. **API promises in writing:** semantic versions, what `apiVersion` 1 guarantees, a deprecation period before anything is removed.

MCP servers are already the safest extension KesherAI has (their own process, a narrow protocol). Until step 1 is done, recommend MCP for anything that touches files or the network, and plugins for looks and pages.

## 8. Modularity

The detail is in `ARCHITECTURE_REVIEW.md`. The headline:

- The shape is right: packages by role, one route file per area, services passed in.
- The weight sits in two places: `server.ts` (one 980-line function that builds every service and imports 112 files) and what remains of `conversations.ts` (1,154 lines after the 2026-11-13 split).
- Tools for a kind of chat (Unreal, Unity, media, phone) should register themselves in one list instead of being wired by hand in the manager. Then a plugin can add a tool group the same way the core does.

## The prioritized list

Ordered by what protects the user first, then what most users feel, then what developers feel.

| # | What | Why now | Size | Board |
| --- | --- | --- | --- | --- |
| 1 | Plugins in their own process, permissions enforced | Nothing else makes outside plugins safe | Big | t39 |
| 2 | Simple mode for a new install | The first five minutes decide whether someone stays | Big | t40 |
| 3 | Command palette (Ctrl+K) | Fast for everyone, and it is the keyboard path accessibility needs | Big | t41 |
| 4 | A receipt with "Undo all" after each agent run | Trust: see what changed, take it back | Big | t42 |
| 5 | Measure start time, typing lag and token drawing in `ui-check` | You cannot keep fast what you do not measure | Small | t43 |
| 6 | `axe-core` in `ui-check` | Catches accessibility mistakes before release | Small | t44 |
| 7 | A hidden heading per chat message; focus back to the input after Stop | Screen-reader navigation | Small | t45 |
| 8 | Boundary rules in lint (routes, shared, web) | Keeps the modules apart as more people join | Small | t46 |
| 9 | `<Code>` and `<Path>` that isolate direction; the 12 physical CSS properties | Hebrew with code reads right everywhere | Small | t47 |
| 10 | `content-visibility: auto` on chat messages | Long chats stay smooth | Small | t48 |
| 11 | Split `server.ts` by area (see the review) | The largest obstacle for a new developer | Big | t49 |
| 12 | One NVDA pass on the five main screens | Real users, real reader | Needs Roee's PC | t50 |

## Sources

- [LM Studio: UI modes](https://lmstudio.ai/docs/app/user-interface/modes)
- [HatchWorks: agent UX patterns](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/)
- [Kunal Ganglani: 10 tool approval patterns](https://www.kunalganglani.com/blog/tool-approval-patterns-ai-agents)
- [Tian Pan: the accessibility gap in AI interfaces](https://tianpan.co/blog/2026-04-17-ai-accessibility-streaming-screen-readers)
- [azukiazusa: accessible streaming chat UI](https://azukiazusa.dev/en/blog/accessible-streaming-chat-ui)
- [PatternFly: right-to-left handbook](https://www.patternfly.org/developer-guides/right-to-left-handbook)
- [Electron: performance checklist](https://electronjs.org/docs/latest/tutorial/performance)
- [VS Code: extensibility principles and patterns](https://vscode-docs1.readthedocs.io/en/latest/extensionAPI/patterns-and-principles/)
- [ComfyUI: January 2025 security update](https://blog.comfy.org/p/comfyui-2025-jan-security-update)
- [ComfyUI: registry standards](https://docs.comfy.org/registry/standards)
- [Open WebUI: plugins](https://docs.openwebui.com/features/extensibility/plugin.md)
- [Obsidian: the future of plugins](https://obsidian.md/blog/future-of-plugins/)

Stopped at: game-mod ecosystems (Factorio's mod portal and its data and control stages) were searched but the page could not be read; worth another look before the public plugin list is designed.
