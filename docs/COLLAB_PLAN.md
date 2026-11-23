# Collaborators without engines: plan

Status: **plan only** (2026-11-21, Roee's request in WORK_LIST "Collaborators without engines"). No feature code yet.
The sync channel (git or KesherAI's hub) is decided after research task c-20261121-39 arrives; both are shown neutrally below.
Design boards: `tools/design/scenarios/collab.json` (CollabProjectView, CollabSceneLocked, CollabApplyCard). They are drawn on the nearest
existing screens (the guest Scenes tab, the Games page's sync sheet) with mock data; the new chips (lock, "from Dana", "synced ✓") are
text in the mock fields and become real in the steps below.

## The goal
A collaborator's KesherAI needs **no Unity, Unreal or Godot**. Only the main PC has the engine versions and the KesherAI plugins.
The collaborator edits in KesherAI's stand-ins and editors, syncs, and the main PC applies the changes through the plugins and sends
results back (pictures, compile and play results). Works on a 390 px phone and in remote; Hebrew and English.

## What already exists (this plan builds on it, nothing here is new ground)
| Piece | Where | What it gives us |
|---|---|---|
| Unity scene stand-in | `packages/core/src/unity-scene.ts`, `routes/unity-scene.ts` | Reads a `.unity` YAML scene from disk without Unity; moves queue in `KesherAI/pending-moves.json`, applied by the Unity package with Undo when the scene is open. |
| Unreal level stand-in | `routes/unreal-level.ts`, `unreal-level-tools.ts` | Lists `.umap` levels and actors from disk; moves go into the open editor as one undo step, or through a headless editor that saves the level. |
| Godot scenes | `routes/godot-scene.ts` | Text scenes (`.tscn`): editable by anyone. |
| Checkpoints | `game-checkpoints.ts` | One checkpoint per sync batch before any engine write: a whole change rolls back in one tap. |
| Sync and clashes | `game-sync.ts`, `routes/games.ts`, GamesSyncSheet | Pending list, "Sync now", ask-every-time clash sheet, one report per sync, phone notification only on failure or a clash. |
| Scene rooms | `scene-rooms.ts` | Who has a scene open (colour, camera, selection), in memory, guests limited. |
| Guests | `guests.ts`, `guest-scenes.ts`, `routes/guests.ts` | Invite link and key, read/edit roles, relative scene paths only (never absolute), Scenes tab. |
| Shared chats | `shared-chat.ts`, `shares.ts` | Guests reply in a chat under the owner's rules, no tools unless allowed and every action approved. |
| Pairing | `routes/pair.ts` | A code approved on the PC makes a paired device. |
| Hub | `hub-client.ts`, `routes/hub.ts` | One outward WebSocket from the PC, sealed tasks become board items, sealed results go back; the hub never makes the PC run anything. |
| Task inbox | `task-inbox.ts`, `docs/INBOX.md` | Tasks as files on the `kesher-inbox` git branch, results as files; data is parsed and checked, never run as a command. |

What is missing: a collaborator who owns a **copy of the files** (today a guest only looks at the owner's PC), a way for changes to
travel and be reviewed, locks, and results going back to a person.

## Roles
- **Main PC** (Roee): has the engines and plugins. The only place changes become real in the engine. Sees every incoming change before it is applied.
- **Collaborator** (Dana): has KesherAI and a synced copy of the key files. Edits stand-ins and text files. Cannot run the engine, a build or a command on the main PC.
- A collaborator may be paired (full KesherAI on her own PC) or a guest through an invite link; both use the same change packet below.

## What a collaborator can edit without the engine
| Engine | Files | Without the engine | How the change lands |
|---|---|---|---|
| Unity | `.unity` scenes, `.prefab`, ScriptableObject `.asset` (YAML text) | **Yes**: read and edit through the stand-in and inspector. | As a change packet of moves and values; the main PC queues it in `pending-moves.json` (Undo when open, applied when Unity opens or headless). Plain YAML edits are applied as a text patch after a clash check. |
| Unity | C# scripts, `.asmdef`, `.json`, shaders | **Yes**, text. | Text patch on the main PC; compile result returned. |
| Unity | textures, models, audio (binary) | Add or replace as whole files only. | Copied in; `.meta` guid created by Unity on the main PC (never invented by the collaborator). |
| Unreal | `.umap`, `.uasset` (binary) | **No direct editing.** Only **pending operations** (move, add, set value, material) read from the header and recorded as ops. | Ops applied on the main PC through the Bridge plugin (Undo when open, headless editor when closed). |
| Unreal | C++ (`.h`, `.cpp`), `.ini`, `.uproject` text | **Yes**, text. | Text patch on the main PC; Live Coding or a headless build result returned. |
| Godot | `.tscn`, `.tres`, GDScript | **Yes**, all text. | Text patch (engine optional: a headless Godot check if present). |

Rule of thumb: text is patched, binaries are never merged: they are replaced whole by one owner, or changed only as ops by the plugin.

## The change packet (one unit that travels)
A packet = who, project, base (hash of each file as the collaborator saw it), then a list of **text patches**, **ops**, **whole files**
and a short note. It is a file (JSON plus attachments), size-limited, checked on the main PC: relative paths only, inside the project,
no paths that escape, no executable or settings files, no engine or plugin folders. Nothing in it is ever run as a command.
The main PC stores each packet as a pending batch under one checkpoint (existing `game-checkpoints.ts`), shows it as the card
"3 changes from Dana waiting: apply" (board CollabApplyCard), and applies on **Apply** (default: always asks; Roee may later allow auto-apply per collaborator for text-only packets).

## Locks and conflicts
- **One lock per scene or level** (and per binary asset), owned by one person, so two people never edit the same binary. Text files (scripts) need no lock: they merge by patch with a base hash.
- A lock is taken by opening the scene for edit, shows as "locked by Dana, 12 min left" (board CollabSceneLocked), is renewed while she works, and **auto-releases** after inactivity (default 30 min) or when she syncs and closes the scene. Roee can always release or take over (with a notice).
- Everyone else sees the scene read-only with a **"ask for it"** button (a short note to the owner of the lock).
- A text patch whose base no longer matches meets the existing clash sheet: keep mine, keep theirs, or skip; never decided alone.
- Locks live on the main PC (the one authority) and are copied to the channel; if the main PC is off, locks are not granted and the collaborator edits drafts that wait.

## Results back to the collaborator
After Apply the main PC returns a small result packet: per change applied, skipped or clashed; a **picture** (scene capture from the existing capture tools), the **compile result** (errors with file and line) and a **play result** (smoke test, as night builds will give). Sent over the same channel, shown in her project view as "synced with Roee's PC ✓" and a results card; phone notification on failure only (existing rule).

## Security (decided rules for this plan)
- Paired devices or invited guests only; every packet is tied to a device and a person; revoking a device drops its locks and queued packets.
- A collaborator **may never**: run engine commands, builds or scripts on the main PC; change settings, plugins, secrets or the engines; read files outside the shared project; see absolute paths, other projects, chats not shared with her, keys or email; apply her own changes; delete a project or checkpoint; take Roee's lock.
- Everything arriving is data: parsed with strict schemas, size and count limits, path checks (reuse `guest-scenes.ts` rules), binary types allow-listed; text patches shown as a diff before apply (existing scene-diff view); executable-looking files (`.exe`, `.dll`, `.bat`, `.sh`, plugin DLLs) rejected by default.
- Checkpoint before every apply; one tap to undo the whole packet. Packets are sealed on the channel (hub) or signed commits (git), and nothing personal (Windows username, paths, email) is ever written into them.
- C# and C++ from a collaborator is code that will run on the main PC: it is always shown as a diff and never auto-applied.

## The two sync options (neutral; decided after c-20261121-39)
| | A. Git (a repository or branch the project's key files live in) | B. KesherAI's hub (the outward WebSocket, sealed) |
|---|---|---|
| Fit with what exists | The task inbox already moves tasks and results as files on a branch. History, diff and rollback come free. | Hub already carries sealed tasks and results with presence, and works through NAT with no open port on the PC. |
| Binaries (scenes, `.uasset`, textures) | Large files need LFS or lose history to size; binary merges are impossible (locks needed anyway). | Packets can stream large files in chunks with resume; no history of its own (checkpoints cover it). |
| Setup for the collaborator | Needs a Git host account and access; heavier for non-technical people. | Pair with a code or open an invite; no account on a third service. |
| Offline | Works offline, syncs later; the main PC pulls when it wants. | Needs the PC online or a hub that holds sealed packets until it is. |
| Locks | Need an extra mechanism (a lock file, or LFS locks). | One authority on the main PC, presence is built in. |
| Privacy and cost | Project lives on a third party's server unless self-hosted. Free tiers have size limits. | Sealed end to end, but depends on the hub's hosting and its limits. |
| Risk | Merge conflicts on binaries; secrets or paths leaking into history are permanent. | New transfer code to build and secure (size limits, resume, abuse). |
A hybrid is possible: git for text, hub for binaries, locks and results. Decide after the research; steps S1 to S4 below do not depend on the choice.

## Step plan (S small, M medium, L large; in order)
1. **S: packet format and validator** (`collab-packet.ts` with tests): schema, size and path rules, allow-list of kinds. Accept: bad paths, escapes, oversize and executable kinds are rejected by tests; a good packet round-trips.
2. **S: Apply on the main PC for text and Unity ops**: turn a validated packet into one checkpoint plus a pending batch using the existing queue; shows in the sync sheet "from Dana". Accept: test applies a text patch with a matching base and refuses a mismatched one into the clash sheet.
3. **M: locks** (`collab-locks.ts`): take, renew, release, auto-expire, owner override; in memory plus a file; API and the lock chip on the Scenes list. Accept: tests for expiry, double-take, override; board CollabSceneLocked matches a real screen.
4. **M: the main PC's "N changes from Dana waiting: apply" card** with a diff view, Apply, Skip and per-collaborator rules. Accept: works on a 390 px phone and from remote; Undo restores through the checkpoint.
5. **M: Unreal ops** (header-read levels to pending ops, applied through the Bridge, headless when closed). Accept: an op made on a PC with no Unreal applies with Undo when the editor is open and headlessly when closed (checked on the main PC through KesherAI only).
6. **M: results back**: compile result, play result, scene picture packaged and returned; "synced ✓" and results card in the collaborator's project view. Accept: a failing compile reaches the collaborator with file and line.
7. **L: the sync channel** (git, hub or hybrid, per the research): transport, chunked binaries with resume, pairing and revoke, offline queue. Accept: two machines with no engine on one of them complete edit, sync, apply and result; revoke stops it at once.
8. **M: collaborator's own project view**: a real copy of the files (scenes, scripts, data) with the stand-ins and editors on it, not only the owner's open scenes. Accept: board CollabProjectView is the real screen, with Hebrew and English and the phone width.
9. **S: security pass and docs**: re-check rules above against code, add to SECURITY_REVIEW.md, user guide.

## Open questions for Roee
- Auto-apply for text-only packets from a trusted collaborator, or always ask? (default here: always ask)
- Lock time-out default (30 min) and whether Roee's own lock may be taken over after a warning.
- Is a collaborator also allowed to use the chat model on the main PC, or only her own?


## Live co-editing decision (GE-10, approved by Roee 24.11; from c-20261121-39 and c-20261122-12)
**Server-authoritative last-writer-wins per property, with a soft lock while a drag is active.**
- The main PC (or the hub) is the single authority: every edit is an operation `{object, property, value, revision, author, at}` sent to the server, which accepts it and broadcasts the accepted value to everyone. The latest accepted write for a property wins (LWW per property), so two people moving different objects — or even different axes — never fight.
- While someone drags an object, the server holds a **soft lock** on it (TTL 30 s, renewed by the drag stream). Others see the object as taken (a chip with the owner's name and colour) and their writes to it are rejected with a `clash` notice until the drag ends. No hard locks: a dropped connection releases the soft lock within the TTL.
- **No CRDT (Yjs/Automerge) for transforms.** Positions/rotations are continuous numbers where last-writer-wins is what users expect, and a CRDT would add weight and surprise ("my snap got merged with her drag") for no gain. CRDT merge stays only where it already belongs: text files (scripts) merge by patch with a base hash.
- Presence (who is in the scene, their camera frustum, their selection, their colour) is **ephemeral state**, not history: streamed through the sync channel (hub/relay), never persisted, never in checkpoints.
- Conflicts that do occur (a rejected write, two writers on one property) surface as the existing collision card (GE-9) with mine/theirs/skip.

## Live co-editing of one scene (Roee 22.11 07:20)
Roee wants collaborators to work on the same scene at the same time and see each other: presence (who is in the scene, their camera/viewpoint as a small avatar or frustum, their selection outlined in their colour), live object moves/rotations streamed to everyone, per-object soft locks while someone drags, chat beside the scene, and the main PC applying the merged result to the real project through the plugins. Like Unreal Multi-User Editing / Figma multiplayer / Roblox Team Create, but with the engine only on the main PC. Research how those do it (CRDT vs server-authoritative ops, conflict rules, transport through the hub or LAN WebRTC), before building. Ties into the sync-channel decision above.
