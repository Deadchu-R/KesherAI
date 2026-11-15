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
