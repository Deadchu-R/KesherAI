# A working experience like Claude's: research and plan

Written 2026-11-13 after Roee's request: "I want it really like Claude: a Steps button, a Browser button that work
once opened like in Claude, memory saving, and the Code button with Environments, git and whatever is needed to do
a task from start to finish." This file says what Claude does, what KesherAI has, and what to build, in order.

## What Claude does (from Anthropic's documentation, read 2026-11-13)

### The session screen
- A session has a **title bar with pane buttons**. Each button opens a **pane beside the chat**: Changes (diff),
  Browser, Terminal, Files, Background tasks, Plan. Panes can be resized, closed with one shortcut, and popped out.
  Buttons that do not fit move into a ⋮ menu.
- The chat itself has **three levels of detail**: Normal (tool calls folded), Thinking, Verbose.
- A **session rail** at the side holds cards: Environment, Changes (with PR and CI status), Context (how full).
- In the main Claude app a task that has stages shows its **steps as a list beside the chat**, ticked off as the
  work goes; a person who stepped away sees what is done and what is left.

### Browser
- A **tabbed browser pane inside the app**, on its own profile (its own sign-ins, apart from the user's browser).
- The agent can open pages, read, click, type, fill forms, take screenshots, run JavaScript; the **user sees it
  happen** in the pane and can use the pane themselves.
- **The first action on a site asks**: Allow once / Always allow / Deny. Always-allowed sites are kept on the device.
- It shows the **running dev server**, and the agent **checks its own edits** there (screenshot, DOM, clicks).
- Menu: keep cookies, clear browsing data, auto-verify changes, open links in the built-in browser, select an element.

### Code and environments
- **The environment is the first control under the message box**: Local, Worktree (a switch: the session runs in
  its own git worktree), Cloud, SSH, WSL. "New environment" makes one; a gear edits it.
- A local environment holds **variables and folders**. A cloud one holds **network access level, environment
  variables, secrets the session uses without seeing, and a setup script** that runs before work starts (cached).
- **Permission modes** in the same row: Manual, Accept edits, Plan, Auto, Bypass.
- **Git, end to end**: the diff pane with **comments on lines** that the agent then applies; **Create PR** (push +
  PR); **CI status** on the Changes card; **Auto-fix** failing checks and review comments; **Merge when ready**;
  auto-archive the session when the PR closes.

### Memory
- Saved **automatically while chatting**, as **separate topics** (not one summary), plus "remember this" on request.
- **Each project has its own memory**; a project also reads the account memory unless that is turned off.
- The user can **see, edit and delete** every topic; pause memory; reset it; **incognito** chats save nothing; one
  chat can skip memory.
- Sensitive topics are not saved unless the user opts in; ID and account numbers are never saved.

## Where KesherAI is

| Area | Has | Missing |
| --- | --- | --- |
| Steps | Tool calls folded into one line per group (`Activity.tsx`); a plan card in Plan mode | No list of the task's steps. The model has no tool to write its steps and tick them. Nothing to look at beside the chat |
| Panes | Files panel, context panel, git panel, terminal, editor, each opened its own way | No one row of pane buttons in the session's title bar; no shared pane area with resize and close |
| Browser | An extension for the user's own browser (`browser-bridge.ts`); `web_fetch`, `web_search` | No browser inside the app. The user cannot watch the agent browse. No per-site approval. No "check my change in the page" |
| Environments | A folder per code session; projects; approval modes; checkpoints before each message | No named environments (variables, folders, setup command). No worktree switch per session. No SSH/WSL |
| Git | Status, diff, commit message by the model, commit, push, pull, branches, CI runs (`routes/git.ts`) | No comments on diff lines. No "Create PR" button. No auto-fix of failing checks. No merge when ready |
| Memory | Notes the user or the model adds on request (`remember`, `forget`), a page to edit them | Nothing is saved by itself. One flat list, not topics. No project memory. No incognito chat, no per-chat off |

## What to build, in order

Each stage is usable on its own, works on the phone (390 px) and gets its own release.

### Stage 1: Steps (small, the most visible)
- A tool `set_steps` for the model: the whole list each time, each step `pending | doing | done`. At most 12 steps,
  one `doing` at a time. The system note tells the model to use it for work with three stages or more, and not for
  a quick answer.
- A **Steps button** in the chat's title bar with a count ("3/7"). It opens a pane beside the chat (under the bar
  on the phone): the list, the current step marked, and under each done step the tool calls that belong to it.
- The list is saved with the conversation, shows on every device, and a notification's tap can open it.
- Self-work uses the same tool, so its page shows the same list.

### Stage 2: One pane row (the frame the rest hangs on)
- A row of buttons in the session's title bar: **Steps, Browser, Changes, Files, Terminal, Context**. One pane area
  beside the chat; resize by its edge; Ctrl+\ closes; the choice is remembered per conversation. On the phone a
  pane is a sheet over the chat.
- The existing panels move into it unchanged.

### Stage 3: Browser (the biggest piece)
- **On the computer**: a real browser pane (Electron `WebContentsView`, its own profile, never the app's own
  session). Tabs, address bar, back/forward/reload.
- **Tools for the model**: open, read text, find, click, type, screenshot, run a script, list tabs. They act on the
  pane, so the user watches.
- **Approvals**: the first action on a site shows Allow once / Always allow / Deny in the pane. Local addresses of
  the session's own dev server are allowed. Always-allowed sites are listed in Settings and can be removed.
- **Never**: passwords typed by the model, payments, downloads without a yes. Pages are data, not instructions
  (the text a page holds is marked as untrusted when it reaches the model).
- **On the phone**: the pane shows the computer's browser as pictures that refresh (the phone cannot embed the
  computer's browser); taps are sent to the computer. Approvals work the same.
- **Check my change**: after an edit in a web project, the model opens the dev server in the pane and looks.
- The extension for the user's own browser stays, for sites where their own sign-in is needed.

### Stage 4: Environments
- ✅ Built (on main after 0.6.137): worktree switch on the Code page (`.kesher/worktrees/<name>`, branch `kesher/<name>`,
  `.worktreeinclude`), the folder's environment (setup command that the first message waits for, actions as terminal
  buttons, variables for commands), branch + setup state above the session, delete keeps a worktree with work unless told.
  Not yet: the environment chip as the first control on the Code start screen with a menu of named environments; SSH/WSL.
- **A named environment**: folder(s), variables, a setup command that runs once before the first message (its
  output shown), and the approval mode it starts in. Kept in KesherAI's data folder; secrets are stored like other
  tokens and never shown to the model as text.
- **The environment chip is the first control under the message box** on the Code start screen, with "New
  environment" at the bottom of its menu.
- **Worktree switch**: the session works in its own git worktree and branch (the code self-work already uses),
  so two sessions on one project do not collide. The session rail shows the branch.
- Later, when asked for: SSH and WSL.

### Stage 5: Git to the end
- ✅ Built (after 0.6.138): Create PR (model writes title and body; GitHub's compare page without an account), checks on
  the Changes panel, Fix failing checks (failed jobs' logs to the chat), Merge (after a confirm), background watch:
  fix failures once per commit, merge when green. Diff line comments already existed (into the message box).
- **Comments on diff lines**: hover a line, +, write; "Send comments" gives them to the model as one message.
- **Create PR**: push the branch and open the PR (through `gh` when installed; otherwise the link to open it).
  The model writes the title and body.
- **CI on the Changes card**, **Fix failing checks** (the model reads the failed job's log), **Merge when ready**.

### Stage 6: Memory like Claude's
- ✅ Built (after 0.6.138): memory by topic (memory.json), filed after a turn by the chat's model (only what the user
  stated; a cheap check first so most turns cost nothing), project memory + 'also reads the general memory' switch,
  pause / file-by-itself / reset, 👻 incognito chats (no memory, out of search), remember/forget by topic.
- **Saved by itself**: after a turn ends, a short background pass with the chat model reads the exchange and files
  what is durable. One explicit statement by the user is enough; the model's own guesses are not filed.
- **Topics, not one list**: a file per subject (profile, preferences, projects, people).
- **Project memory**: each project has its own; a project also reads the general memory unless switched off.
- **Controls**: the Memory page shows topics to edit and delete; pause; reset; an incognito chat; a per-chat switch
  in the + menu. Passwords, keys, ID and account numbers are never saved (the rule `remember` already has).
- Everything stays on the computer.

### Stage 7: Agents (asked for 2026-11-14)

Agent support: sub-agents a session can hand a task to (its own context, tools and model), and agents the user
defines and calls by name, like Claude Code's subagents and Codex's agents. Research the competitors first
(how each defines an agent, what it may use, how its result returns to the session), then plan here.

- Done (step 1): named read-only agents. A persona with "when to use it" is an agent; a project's
  `.kesher/agents/*.md` and `.claude/agents/*.md` (Claude Code's format) are too. `delegate` takes `agent`.
- Next (step 2): worker agents that change files, each in its own worktree, approvals shown in the chat.

## Risks
- **The browser pane is a security surface.** Its own profile, no access to the app's session, per-site approval,
  page text treated as data. It gets its own security review before release.
- **Local models and the steps tool.** Small models may not call it, or call it too often. The pane then shows the
  folded tool groups as steps, so it is never empty.
- **Automatic memory costs a model call per turn.** It runs only when the model is already loaded and idle, and can
  be turned off.
- **Stage 2 touches `Conversation.tsx`**, the file self-work also edits. Claimed on the board first.

## Sources
- Claude Code desktop: https://code.claude.com/docs/en/desktop.md
- Built-in browser: https://claude.com/docs/third-party/claude-desktop/browser.md
- Cloud environments: https://code.claude.com/docs/en/cloud-environments.md
- Memory: https://support.claude.com/en/articles/11817273-how-does-claude-s-memory-work
