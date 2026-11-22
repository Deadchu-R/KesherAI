# Helpers in any app, timers and events

KesherAI's tools that work outside its own window, and the ones that work by themselves later. All of them use
your own models on this computer unless you chose a cloud model; keys can be changed in **Settings → Keyboard and
helpers**.

## Text Helper: selected text in any app (Ctrl+Alt+K)

1. Select text anywhere: a web page, an email, a Word document, a chat.
2. Press **Ctrl+Alt+K** (Control+Option+K on a Mac). A small window opens by the mouse with the text.
3. Press **Summarize**, **Translate** (Hebrew ↔ English), **Fix mistakes**, **Simpler**, **Explain** or **Reply**, or
   type your own question about it.
4. **Copy** the answer, or **Replace the text** to put it where the selection was. **Esc** closes the window.

Nothing is read until you press the key, and your clipboard is put back as it was. Add your own buttons (a name and
an instruction, up to 12) in Settings → Keyboard and helpers. Every question goes to one "✍ Text helper" chat, which
asks before any tool that writes or runs (selected text may come from a page that tries to steer the model).

**On the phone:** select text in any app and choose **KesherAI** in the selection menu.

## Dictation into any app (Ctrl+Alt+D)

1. Put the cursor where the words should go (any app).
2. Press **Ctrl+Alt+D**. A small bar at the bottom of the screen listens; it never takes the focus.
3. Speak. Press **Ctrl+Alt+D** again, or pause for two seconds, and the text is typed where the cursor is.

Whisper turns speech into text on this computer (Settings → Speech sets the language and sets Whisper up). At most two
minutes at a time; **Cancel** throws it away. On the phone the keyboard's own voice typing does this already.

## Timers and notifications from the model

Ask a chat "check the download again in an hour" or "remind me at 9:00". The model sets a timer; the chat shows a
clock with the number waiting at the top, where each can be cancelled. When it is due, the request comes back into
the chat (marked "⏰ Timer") and the model answers it; a timer that came due while KesherAI was closed fires after it
starts, marked late. The model can also send you a notification (computer and phone) when you asked to hear about
something; at most one a minute. Incognito chats have no timers.

## Routines that start on an event

In **Pipelines → Routines**, besides "at a time", "every few minutes" and "each start":

- **When a web page changes**: the page's text is read every 15 minutes or more, with no model; the routine runs only
  when it changed, and gets the lines added and removed.
- **When files change in a folder** (a folder inside your home folder, set on this computer): the routine gets the
  names of the changed files.
- **When a download finishes** (optionally only one whose name contains some text, e.g. `gguf`).

## Canvas: a board you and the model draw on

Ask a chat to draw something: "draw the login flow", "sketch the architecture of this project", "make a mind map of
these ideas". The model puts shapes and arrows on the chat's canvas (KesherAI lays them out as a flowchart along the
arrows), and a **Canvas** button appears at the top of the chat. The canvas is an Excalidraw board: move, restyle and
add to the drawing yourself; the model sees your changes when it reads the canvas, and its own appear while it is
open. **Export** saves a PNG, an SVG or an `.excalidraw` file. Every canvas is listed under **Create → Canvas**, where
you can also start one without a chat (or open one from a chat's ⋯ menu). Incognito chats have no canvas.

## Sharing a chat as a page

In a chat's **⋯** menu, **Share…** makes a read-only web page of the chat as it is now: what you wrote and the
answers, without tool steps, without paths from this computer and without your name. Copy the link and send it.
**Update to the chat now** puts later messages on the same link; **Stop sharing** closes it at once. A link works
for a day, a week, 30 days or until you stop it, and people outside your home network can open it only while
**Access from anywhere** is on (Settings → Phone, where every shared chat is listed with how often it was opened).
Incognito chats cannot be shared.

## Files in the chat

Attached files show as chips in your message; a tap opens a preview: a table for Excel, CSV and TSV (with sheet
tabs), the slides for PowerPoint, a Word document or an HTML page as a page (no scripts run in it), pictures and text.
The model reads Excel and PowerPoint files too.

## Pictures in Knowledge

Pictures in a knowledge folder (a whiteboard, a receipt, a screenshot) are described once by your chat model when it
is a local model that sees pictures (Models → 👁), never a cloud model, and only while no chat is working. Search
then finds them by what they show.

## "What fits?"

Next to each model on the Models page: what llama.cpp will put on the graphics card, the context it can keep, and
how much system memory the rest needs next to what is free now; a warning when the model would be read from the disk.

## Claude helpers: live progress on the phone and in the hub

When the lead Claude starts an outside helper (a Claude helper agent that KesherAI does not run itself), it tells
KesherAI, and the phone shows one live notification for it ("Claude: <title>", the latest step, steps so far, the
time; replaced by a summary when it ends). The same run is a row in the hub's **Claude** curtain. No Claude tokens go
into the mid-run updates: the steps come from git.

**The lead calls** (from this computer, or a paired device), at the helper's start and its end:

```
POST /api/agents/external
{ "id": "claude-live-notify", "title": "Live Claude-helper notifications", "status": "running", "steps": 4 }
{ "id": "claude-live-notify", "status": "done", "result": "Route, watcher and tests are in." }   (or "failed")
```

`id` is letters, digits, `.`, `_`, `-` (at most 40); `status` is `running`, `done` or `failed`; `title` (120), `step` (a
step the lead wants to add, 120), `steps` (how many are expected, 1 to 200) and `result` (400) are optional and are cut
to those limits. `GET /api/agents/external` lists the runs. A run nobody reports on or commits for during 3 hours is
closed as failed.

**The helper adds a trailer line** to each of its commits, with the same id (before the Co-Authored-By lines):

```
Helper: claude-live-notify
```

While a run is open, KesherAI runs `git fetch origin main` every minute in the task inbox's git project (Settings >
Task inbox) and every new commit on `origin/main` with that trailer becomes a step of the run (its subject and short
sha). Commits without the trailer, or for a run that is not open, are ignored. Code: `packages/core/src/external-agents.ts`.

**While KesherAI is off** the lead cannot call the route. When KesherAI starts (about 20 s later), it looks at git from
the last `origin/main` commit it saw (kept in `external-agents.json`; with none, the last 12 hours): every `Helper: <id>`
commit that belongs to no known run makes a finished "Claude: <id>" run with those commits as steps, with one summary
note on the phone (none when the run ended more than 12 hours ago). KesherAI only reads git; it never sends a helper's
progress back to Claude.
