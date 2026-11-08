# Security review (November 2026)

This review went through the code part by part. Each finding is listed with what was changed.

## Fixed

1. **Other websites could use KesherAI on this computer (high).** The API sent `Access-Control-Allow-Origin` for any origin, and requests from this computer need no token. So any web page open in the user's browser could read chats and change settings through `http://localhost:7420/api/…`. Now:
   - **Cross-site requests are refused.** For `/api`, `/comfy-ui` (ComfyUI's API can run any workflow) and `/mcp` (it reads your knowledge), a request is refused when its Origin is foreign, when it is `null`, or when the browser marks it `Sec-Fetch-Site: cross-site`. That covers simple form posts and no-cors GETs too.
   - **Allowed origins:** the interface's own address, the Android app (`http://localhost` with no port) and, for `/api/browser` only, the browser extension.
   - **CORS headers only where safe.** They go only to those origins, plus `/v1` for web apps. From a foreign page, `/v1` always needs an access key, even on this computer.
2. **DNS rebinding (high).** A site can make its own name resolve to 127.0.0.1. Its requests then come from this computer and look local. Now `isLocalRequest` also requires the Host header to name this computer (localhost, 127.0.0.1, ::1 or the computer's own name). Otherwise the request needs the token.
3. **Encoded paths.** The auth check now decodes the path the way the router reads it, so `/%61pi/…` is treated as `/api/…`. It also merges repeated slashes, and a malformed encoding gets a 400.
4. **Content-Security-Policy for the interface.** Scripts, styles, fonts, pictures and connections may come only from KesherAI itself, plus Google profile pictures. This stops a chat's Markdown or a look's CSS from loading outside pictures, a known way to leak data, or anything else from outside.
5. **Desktop bridge (Electron IPC).**
   - Every bridge call must come from KesherAI's own main frame, on its own address. Frames inside it (ComfyUI, plugin pages) are refused.
   - "Run" opens only files in KesherAI's outputs folder or in a code session's folder.
   - Navigation inside the window is limited to KesherAI's exact address.
6. **Dependencies.**
   - `@fastify/static` went from 8 to 10.1.10, which fixes path traversal and route-guard bypasses.
   - `ws` went from 8.18.3 to 8.22.2, which fixes a memory disclosure and a DoS.
7. **Telegram** (see TELEGRAM.md).
   - Pairing works only on purpose and closes after wrong codes.
   - Chats are limited: they always ask, get no screen or browser control, and cannot approve commands by default.
   - `/lock` turns the bot off, there is a rate limit, and alerts go out.
8. **Looks** (see APPEARANCE.md). A look is data plus cleaned CSS. A safety-guard cascade layer keeps approvals visible and unchanged.

## Known, not yet fixed

- **zod 3:** GHSA advisory on memory use when validating oversized constrained collections; the fix is only in zod 4.6.6+. zod checks the local config file, request bodies and plugin manifests. The worst case is a slow or crashing server, not access. Moving to zod 4 changes how `.default({})` fills nested defaults, so it needs its own careful change.

## Still to review

- **Each route's own checks:** local-only settings, and the size limits on request bodies.
- **Plugins:** the plugin sandbox and permissions, and the code the community store installs.
- **The agent's file tools:** how folder boundaries handle symlinks and `..`, and the approval rules.
- **Remote access:** token rotation and how the token is stored on the phone.
