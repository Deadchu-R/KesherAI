# Feature review

A daily look at one area of KesherAI against the leading apps and open-source tools. Each run takes the next area
in the list (wrapping around), writes a dated section at the end of this file, and adds the gaps it finds to the
matching "Backlog" section of docs/WORK_LIST.md.

## Areas

1. Chat and UI
2. Game engines (Unity, Unreal, Godot)
3. Models, engine and agents
4. Devices, hub and phone
5. Editors and media (image, video, sound, 3D)
6. Study and personal tools
7. Platform (plugins, updates, security, tests)
8. Browser and computer control

## 2026-11-21 — Chat and UI

Inventory (where it lives): conversation page `apps/web/src/pages/Conversation.tsx` (branches as linked chats via
`branchOf`, regenerate, incognito chats, undo per turn); composer `ComposerBar.tsx`, `AddMenu.tsx`, `SlashMenu.tsx`
(`/compact /fork /model /new /status /goal /side`, prompt fields); tool steps folded in `Activity.tsx`; approvals
`ControlApproval.tsx`; side panels `ArtifactPanel.tsx`, `DocPanel.tsx`, `CanvasPanel.tsx` (Excalidraw), `SideChat.tsx`;
result buttons `chat/ResultActions.tsx`; voice `VoiceMode.tsx` (local, barge-in), `Speak.tsx`, `Mic.tsx`; compare
`ChatsAtOnce.tsx`, `pages/ComparePage.tsx`; sidebar with hover preview and editing `Sidebar.tsx`, `SidebarEdit.tsx`;
command palette `CommandPalette.tsx`; memory `pages/MemoryPage.tsx`, `chat/MemoryChip.tsx`, `routes/memory.ts`;
sharing `chat/ShareDialog.tsx`, `routes/shares.ts`, guests (`GuestApp.tsx`, `routes/guests.ts`); imports
`ImportChats.tsx`; appearance `AppearanceSection.tsx`; gamepad `gamepad.ts`, `PadHints.tsx`; tabs `tabs-state.ts`.

| Feature | KesherAI | Best competitor(s) | Who is better and why |
| --- | --- | --- | --- |
| Edit, regenerate, branch | Edit opens a branch as a new linked chat; regenerate; `/fork` | Open WebUI 0.11–0.12 (`/fork`, fork from a shared chat); Claude/ChatGPT in-place version arrows | Tie on power; they are better on in-place `‹ 1/2 ›` switching without leaving the chat |
| Search and sidebar | Full-text search over chats and the day journal; hover preview; reorder; tabs | Open WebUI 0.11 (folders, notes, channels, hover preview, `@` search); LM Studio agent app 1.2.1 (sessions in Cmd+P, `/archive`, day separators) | KesherAI about equal; LM Studio's palette over chats and archive is neater |
| Memory and incognito | Memory page and chip, incognito chats that skip memory and search | Claude (2026: memory as categorized entries edited in conversation, topics shared with Cowork, monthly "Reflect" recap) | Claude better: editable topic entries and a periodic recap |
| Canvas / artifacts | Artifact, document and Excalidraw panels; Word/Excel/PPT previews | Claude (Jun 2026: highlight text in a draft, describe the edit, applied in place); LM Studio Canvas 1.1.6–1.1.8 (draggable, exports) | Claude better for targeted edits by selection; KesherAI matches LM Studio |
| Voice | Local voice mode with barge-in, read-aloud, dictation into any app | Open WebUI 0.12 realtime call (talk handled by a voice model, work handed to the chat's model, approvals kept in the chat); Cursor speaks progress | KesherAI better on privacy (fully local); Open WebUI better on the voice-to-agent hand-off |
| Thinking and tool steps | Folded step list ("7 steps"), helper runs, thinking level only for external agents (`AgentChip.tsx`) | Open WebUI 0.12 and LM Studio 1.2.2 (thinking depth per chat); Jan 0.8 (thinking toggle, collapsible thoughts); Cursor (per-turn duration, "waiting for approval" status) | They are better: a thinking-level control for local models and clearer turn status |
| Compare models | Chats at once and a Compare page | Open WebUI (Compare toggle in the message box); Msty Splits and Model Squad | Tie; Open WebUI's in-box toggle is quicker |
| Queue / steer while working | Send is off while the chat is busy (helpers can be steered) | Jan 0.8 (queued messages as editable chips, two-stage Stop); Cursor Oct 2026 (mid-run messages steer by default, "Send now") | They are better: KesherAI's main chat cannot queue or steer |
| Context and compaction | `/status` and `/compact`; Usage page | Cursor (live context use after summaries); Open WebUI `/status` | Competitors slightly better: an always-visible context meter |
| Sharing and collaboration | Read-only expiring links, guests with their own chats, shared projects with alerts | Open WebUI 0.12 shared chats ("Allow replies" / "Clone only", names, live streaming, typing); ChatGPT group chats (Nov 2025) | They are better for several people in one chat; KesherAI better on safety (expiring capability links, alerts) |
| Keyboard, gamepad, phone | Remappable keys, command palette, gamepad and on-screen keyboard, 390 px phone layout | Open WebUI remappable keys; Claude mobile manages agents | KesherAI better (gamepad and console mode are unique) |

### What we do better

- Everything runs locally by default: voice mode, read-aloud, dictation into any app, memory and search stay on the computer.
- One chat reaches the whole tool set (Unity, Godot, Unreal, ComfyUI, editors) with result buttons and editors per output.
- Gamepad support, console-style hints and a phone layout of the same app; tabs for chats, editors and pages.
- Safer sharing: 128-bit expiring links, view counts, revocation, guest alerts; incognito chats.
- Imports chats and personas from ChatGPT, Claude and Gemini; prompt fields and built-in slash commands.

### What they do better

- Steering: messages typed while the model works are queued or steer the run (Jan, Cursor); KesherAI blocks the send.
- Targeted edits in a side draft by highlighting text (Claude).
- In-place version arrows on edited and regenerated messages (Claude, ChatGPT), instead of a separate branch chat.
- Thinking-depth control per chat for local models (Open WebUI, LM Studio); clearer turn status and duration (Cursor).
- Multi-person live chats with "Allow replies" / "Clone only" modes (Open WebUI, ChatGPT group chats).
- Memory as editable topic entries plus a periodic recap (Claude).

### Missing in KesherAI

- Message queue and steer while busy, with a two-stage Stop.
- Highlight-to-edit in documents and artifacts.
- `‹ n/m ›` version arrows on a message.
- Thinking-level picker for local reasoning models (on/off/low/high).
- Always-visible context meter in the composer, with a compact suggestion near the limit.
- Shared chat where guests reply in the same thread, live, with names and typing.
- Realtime voice hand-off: a small voice model talks, the chat's model does the work, approvals stay on screen.
- Monthly memory recap and memory grouped in editable topics.
- Chats and projects in the command palette; archive instead of delete; day separators.

### Ideas to improve

- S: Composer stays enabled while busy; new messages become queued chips (edit, delete, send now); Stop clears the queue first.
- M: Steer mode: a queued message is injected at the next tool step of the running turn (setting: queue or steer).
- M: Highlight-to-edit in DocPanel and ArtifactPanel: select text, type a change, the model rewrites only that span with a diff.
- S: Version arrows on a message whose branches exist (reuse `branchOf`, switch in place).
- S: Thinking picker in the model menu for reasoning models (maps to chat template flags / reasoning effort).
- S: Context ring in the composer from `chat-status.ts`; at 80% offer `/compact`.
- S: Turn duration and status line ("waiting for approval", "running tool") under the busy answer.
- M: Shared chat mode "Allow replies" for guests, with sender names, live streaming and typing indicator.
- L: Realtime voice hand-off with a small local voice model, approvals routed to the screen.
- M: Memory topics view and an opt-in monthly recap card.
- S: Command palette lists chats and projects; `/archive`; day separators in long chats.

### Sources

- Claude release notes: https://support.claude.com/en/articles/12138966-release-notes
- Open WebUI 0.11: https://openwebui.com/blog/v0-11-0-the-interface-reorganized
- Open WebUI 0.12: https://openwebui.com/blog/v0-12-0-a-voice-that-talks-back-and-a-face-to-go-with-it
- LM Studio changelog (0.4 and the agent app 1.1.x–1.2.x): https://lmstudio.ai/changelog
- Cursor release notes: https://cursor.com/docs/release-notes
- Gemini Drop, July 2026: https://blog.google/products-and-platforms/products/gemini/gemini-drop-july-2026/
- Msty Studio 2.9: https://msty.ai/blog/msty-studio-2.9.0
- Jan 0.8.0: https://www.jan.ai/changelog/2026-05-22-jan-v0.8.0
- ChatGPT group chats (Nov 2025, secondary): https://www.techcrunch.com/2025/11/20/chatgpt-launches-group-chats-globally/

Not verified this run: ChatGPT 2026 release notes (page did not load), Gemini Canvas and Live, LobeHub 2.x chat features
(changelog page empty).

Stopped at: Chat and UI done. Next run: Game engines (Unity, Unreal, Godot).
