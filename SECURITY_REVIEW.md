
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
