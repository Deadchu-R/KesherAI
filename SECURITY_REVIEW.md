
## Scan after 0.5.19 (0.5.20)

- Device invite links (`POST /api/remote/devices/invite`): at most five an hour, each announced on the computer and the phone; keys removable alone.
- Desktop "connect to another computer": the other computer's window has no preload (no bridge), its own partition, stays on its origin (navigations and redirects elsewhere are stopped), only microphone and clipboard-write permissions; keys stored with the system's encryption (safeStorage).
- Look pictures: searched at fixed addresses; downloaded only through DuckDuckGo's picture proxy or from upload.wikimedia.org (a result's own address is never fetched, so results cannot reach the home network); 8 MB for a background, 2 MB for an icon; bytes checked to be PNG/JPEG/WebP; SVG never stored; one search at a time, four a minute; safe search strict.
- Service worker: the "starting" page replaces 502/503/504/530 on navigations only.
- Dependencies: DOMPurify (inside Monaco) pinned to ^3.4.17 through an override (fixes a critical and a high advisory). Open: zod 3 memory exhaustion on oversized input (fixed only in zod 4); every request body is capped by Fastify's body limit and config files are local, so the exposure is small; the zod 4 move stays on the list.
