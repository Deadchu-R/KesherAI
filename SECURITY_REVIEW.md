
## Scan after 0.5.19 (0.5.20)

- Device invite links (`POST /api/remote/devices/invite`): at most five an hour, each announced on the computer and the phone; keys removable alone.
- Desktop "connect to another computer": the other computer's window has no preload (no bridge), its own partition, stays on its origin (navigations and redirects elsewhere are stopped), only microphone and clipboard-write permissions; keys stored with the system's encryption (safeStorage).
- Look pictures: searched at fixed addresses; downloaded only through DuckDuckGo's picture proxy or from upload.wikimedia.org (a result's own address is never fetched, so results cannot reach the home network); 8 MB for a background, 2 MB for an icon; bytes checked to be PNG/JPEG/WebP; SVG never stored; one search at a time, four a minute; safe search strict.
- Service worker: the "starting" page replaces 502/503/504/530 on navigations only.
- Dependencies: DOMPurify (inside Monaco) pinned to ^3.4.17 through an override (fixes a critical and a high advisory). Open: zod 3 memory exhaustion on oversized input (fixed only in zod 4); every request body is capped by Fastify's body limit and config files are local, so the exposure is small; the zod 4 move stays on the list.

## Scan after 0.5.24 (0.5.25)

- split_across_computers: only the text the chat's model writes (parts and shared context, capped at 24 parts, 8,000 and 6,000 characters) goes to the user's own computers in My devices, over the same token-protected connection as their models; no files, tools or keys. Results come back as tool output (data for the model, not instructions to it).
- My devices reads every devices.json KesherAI made in the user's Drive (drive.file scope: KesherAI sees only its own files); entries without an id or date are dropped; the newest entry per computer wins.
- Unity: project names, folders, editor versions and template ids are checked before the CLI runs (arguments, never a shell); `self-update`, create and open are local-only.
- Sidebar reorder: local storage only; no new requests.
- Performance: the model menu reloads the connection names only when it opens; the split runs one part at a time per computer, so no computer is overloaded.

## Scan after 0.5.29 (0.5.30)

- Unity chat tools: the CLI gets arguments as a list (no shell); command names `[a-z0-9_.-]` words (≤ 4), parameter names checked, the command's own flags after the `--` fence; unity_command and unity_script_eval ask first; unity_script_eval is never offered to Telegram chats; screenshots are written to the chat's own outputs folder or the project's Temp/.
- Unreal MCP setup: local only; the .uproject is backed up before it changes; only the two plugin entries and the per-user auto-start line are written; the connection is 127.0.0.1:8000.
- Graph tools: changes are `write` risk (asked in "ask" mode), the model's operations are checked by parseOps before the bridge applies them, one undo step in the editor.
- Update all my computers: each computer is reached through its own token-protected address from My devices; updates come only from the project's GitHub releases (the same path as "Install update"); results are reported per computer.
- Performance: the Unity CLI check runs at most once a minute in the background; tool lists are built per message as before.

## Scan after 0.5.35 (0.5.36)

- Updates: the installer is now checked against the sha512 the release publishes in its update feed (latest.yml / latest-mac.yml / latest-linux.yml) before it runs; a mismatch deletes the file and stops. The download must be exactly the release's size. Update logs are redacted (tokens, keys, Bearer values, passwords in addresses), stay on this computer (.kesher/logs, the last ten), and are shown only on the Updates page behind the usual access token.
- analyze_chat reads only files inside the chat's folder or folders the user attached (resolveForTool), at most 20 MB, and never sends the chat anywhere.
- + → Project: local only; it opens the chosen folder to the chat's file tools, as attaching files does. Switching the chat's Unity project from the phone works only among projects already added on the computer.
- Tool search changes which tool descriptions the model reads, not what may run: every tool keeps its own risk and approvals.

## Scan after 0.5.40 (0.5.42)

- Figma: the token is saved only on this computer (local-only route, format checked), never returned by any API (GET /api/figma says only whether one is saved), not part of the settings sync between computers, and sent only to api.figma.com in a header. Frame pictures: HTTPS from Figma's image hosts only, no redirects, 12 MB, PNG bytes checked.
- Menu placement keeps every popup at z-index 1000, below the protected approval cards (100000); it changes only position and size.
- Desktop watchdog: starts this app's own server only when the one it shows stops answering twice; it never attaches to another address.
- My devices: an unreachable computer keeps its connection (same address and token as before), so nothing new is exposed.
- Performance: popup watchers are disconnected when a menu closes.

## Unity chat tools (0.5.46)

- Paths: every Unity file tool resolves the path against the project, refuses `..`, absolute paths outside it and roots other than the allowed ones (writes: `Assets/` only), and follows symbolic links on the existing part of the path to make sure it still lands inside the project.
- Writes: code files only (no .dll, .exe, scenes or prefabs), 300,000 characters at most, recorded for KesherAI's Undo, risk "write" (the user's approval setting applies; never offered to Telegram chats). An Editor script can run code inside Unity, so this is treated like run_command in the docs.
- C# built by the tools: user and model text enters only as escaped C# string literals (backslash and quote escaped, control characters dropped); component type names must match a strict identifier pattern; numbers must be finite. Tested with an injection attempt in a GameObject name.
- The CLI is run with an argument list, never a shell; `recompile` and `logs --console` take only fixed flags plus the project path.
- Performance: the CLI check starts when the server starts (so the first chat has the tools) and is cached for a minute; file listing stops at 500 files and 12 folder levels; hierarchy at 400 objects.

## My devices: faster, live, sleep notice (0.5.47)

- `POST /api/devices/presence` sits behind the normal access token (a computer only reaches another with the token that one published in the user's own devices.json); it accepts only a known device id and "asleep"/"awake", and only changes whether this computer waits on that one's models. `POST /api/devices/announce` is local only (the desktop app on suspend, shutdown, resume and quit).
- Addresses of a computer are tried at once (first answer wins, 8 s each) instead of one by one; another computer's model list is served from the last answer (up to 10 minutes old) and refreshed in the background, so opening a chat never waits on it.
- Reading answers aloud by itself now starts off (new setting key), under Settings → Accessibility.
