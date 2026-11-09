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

9. **The agent's file tools: links that point out.** A symlink whose target does not exist yet ("dangling") has no real path. Writing through one used to create its target, which could be outside the folder. Now every link on the way is checked by where it points.
10. **Plugins from the internet.**
    - Installing one from Git, and turning any plugin on, work only on the computer itself.
    - A new plugin starts turned off. Turning on a plugin you installed asks first, says that it runs code on your computer with full access, and lists the permissions it asked for. Plugins still run inside the core's process; giving each its own process with only its permissions is on the roadmap.

11. **Scan after 0.5.4.** Every 5 changes the new code is scanned for security and speed.
    - **Fixed:** the tunnel's "who is behind me" header (`cf-connecting-ip`) was trusted from anyone. A device on the home network could send it with a different address on each try and so dodge the limit on wrong tokens. It is now trusted only from the tunnel itself, which connects from this computer.
    - **Changed:** the global request size went from 50 MB to 25 MB. Routes that take more set their own limit.
    - **Checked, no problems found:**
      - compression (it never touches live streams)
      - heartbeat routines (a quiet run removes only the chat it made)
      - `learn_skill` (the name becomes a safe folder name, it always asks first, and from Telegram it can be approved only on the computer)
      - the access log (it keeps no tokens, query strings or contents)
12. **Access log** (Settings → Phone → "Who came in from outside"). It shows every address that came in from outside and every refused try. Five refusals in ten minutes send an alert.

13. **Scan after 0.5.8.** It covered the plugin preview, the start screen, and Telegram pictures and voice.
    - **The plugin preview** fetches only from GitHub, with owner/repo checked first.
    - **Telegram files** come only from Telegram's file address. The path Telegram gives is checked, files are capped at 20 MB, and KesherAI makes up the file names itself.
    - **The web interface** has no `innerHTML` and no `dangerouslySetInnerHTML`.
    - **New: pages the API answers with get a strict Content-Security-Policy.** These are the sign-in result pages and the printable chats and documents. They load nothing from outside and make no connections. A printable chat gets a script only when it opens the print dialog.

14. **Access from anywhere, made safer without turning it off:**
    - **A key for each paired device.** A device that pairs on the home network gets a key of its own (`kd_…`), and KesherAI keeps only its SHA-256 hash. One device can be removed without touching the others. The request log names the device that came in.
    - **"Only paired devices through the internet link"** (recommended). Through the tunnel, the shared token (used by the QR code and your other computers) is refused, and only device keys get in. If the shared token ever leaks, for example in a screenshot of the QR code, it is useless from the internet.
    - **Idle devices.** A device key not used for 30 days (you can change this) stops working through the tunnel until the device is used once on the home network.
    - **A full request log.** It keeps the last 1000 requests from outside: time, address or device, method, path, result and time taken. It never keeps tokens, query strings or contents.
    - **Alerts.** You get one when a single address is refused 5 times in 10 minutes, and one when 40 requests are refused within an hour from any addresses.

15. **Scan after 0.5.14.** It covered device keys, reset, training, the request log and the desktop rescue window.
    - **Reset** and removing a device work only on this computer.
    - **Device keys** are kept as hashes only and compared in constant time.
    - **The training uploads** are limited to PNG, JPEG and WebP, and the folder name is made safe.
    - **Faster:** the request log is now saved at most every 30 seconds instead of 5. The phone asks every few seconds.

16. **Scan after 0.5.67** (the Unity and devices work, 0.5.49–0.5.67). No new security findings.
    - **Unity windows:** the install, live and platform windows run fixed commands. The only inserted values are the Unity version, read from ProjectVersion.txt and limited to letters, digits and dots, and the module name, from a fixed list. The routes work only on this computer.
    - **Opening a Unity project to a chat** happens only for a folder already on the Unity page's list (exact match), so a typed "[Unity project: …]" line cannot open another folder.
    - **File tools in a project:** paths still go through the folder check, so `..` and links out of the project are refused.
    - **Computers going to sleep:** the presence message needs the remote token and a known computer; the announce route is local only.
    - **Faster:** the user PATH is read from the registry at most once a minute instead of every 10 seconds (it ran synchronously, blocking the server briefly while the Unity page polls).
    - **A crash on start found here:** `@fastify/static` 10 needed an ES-module-only dependency, which Electron's Node cannot load. 0.5.13 fixed it, and CI now loads the core with `require(esm)` switched off.

17. **Scan after 0.5.74 and the library store** (Unreal tools, long jobs, live output, library store).
    - **Fixed:** writing Unreal C++/Python/build files now asks like a command, in every mode. A `.Build.cs` runs when compiling and `Content/Python/init_unreal.py` when the editor opens, so a page that injected instructions could otherwise slip code into a later build the user approves without seeing it.
    - **Installing programs always asks** (winget, choco, msiexec, Visual Studio Installer, apt, brew…), even with "always allow": found in the Unreal test (0.5.73).
    - **Long jobs** run detached with their arguments quoted for cmd; arguments with `" % ^ & | < > !` are refused rather than escaped. The job list is behind the normal sign-in.
    - **Library store:** https only; repository and ref names are checked; archive entries that would land outside the library's folder are dropped; only documentation and source text is kept, no programs; archives over 400 MB are refused.
    - **Faster:** Unreal engines are looked up at most once a minute (it reads the launcher's logs and several drives, and every Unreal tool asked); a running build's log is read from where it was last read, not whole every two seconds.

18. **Scan after 0.5.78** (the + menu, fewer tokens, Drive uploads, job logs, live output, running a game on the phone).
    - **Running a game on the phone** asks first, takes a checked package name, passes every adb argument as a list (no shell), and returns only the app's own log lines and crash reports that name it, never the rest of the phone's log (other apps' data). USB debugging is never turned on by KesherAI.
    - **Drive uploads** go only to the user's own Drive through this computer's Google sign-in, with the `drive.file` scope (KesherAI sees only files it made), and ask first.
    - **Fixed:** the `.uproject` backup was overwritten by each later change, so the first original could be lost; now the first one is kept.
    - **Faster:** checked the + menu: its lists load only when a flyout opens, capped at 30.

19. **Automatic checks on every version** (asked for by the user, so less is left to checking by hand). The release now runs ci.yml first and publishes nothing when a check fails:
    - lint, types, every test, and `scripts/smoke.mjs`: the real server started with an empty data folder (a path with a space) must answer, serve the interface, refuse a foreign Origin and `Origin: null`, and ask a DNS-rebinding Host for the token;
    - `pnpm audit --prod --audit-level high` and gitleaks (secrets in the code or its history);
    - a test that every `cmd /s /c` line in the core keeps its quotes (it broke twice);
    - Windows: the same tests and smoke test on a Windows machine, plus a .bat in a folder with spaces run directly and as a long job (not blocking until it has been green there);
    - CodeQL (security-extended) on every push to main and weekly, in the Security tab.

20. **Scan of 0.5.87–0.5.88** (other AI apps give KesherAI tasks over MCP; Unreal plugins). Checked by requests against the real server:
    - `/mcp` from this computer answers; a foreign Origin, `Origin: null`, `Sec-Fetch-Site: cross-site` and a form post are refused (403); a DNS-rebinding Host and another device without the token get 401. The smoke test now checks `/mcp` too, on every version.
    - `kesher_approve` is off until the user turns it on (only on this computer: the setting cannot be changed from another device). Even then it never approves a command KesherAI marks dangerous (deleting, installing programs…) or screen control (`computer_use_app`).
    - A chat started by another app gets the same rules as one the user starts: changes outside its own folder and every command ask.
    - `unreal_port_plugin` asks first, runs the engine's own build tool with its arguments as a list, and never deletes the old plugin (it is renamed to a backup).

21. **The access log reviewed with the user (November 9).** Every refused request came from the user's own phone (paired, with its own key) opening pages only the computer may use (/api/pair, /api/notifications, /api/remote); no wrong-token tries at all. Changes:
    - Notifications can be set from a paired device (the phone app's Settings), except where they go (the ntfy server) and whether they carry the text: those stay computer-only.
    - Pairing, the internet link and the tokens stay computer-only; the phone app says so instead of asking and being refused.
    - A paired device's own 403s are shown as "your device: a computer-only setting" and no longer count toward the "someone tried to get in" alerts, so real alerts are not drowned out.

## Known, not yet fixed

- **zod 3:** GHSA-mrhx-c7xc-m3w5 (high), memory use when validating oversized constrained collections; the fix is only in zod 4.6.6+. It is the one advisory the release's automatic audit is told to skip (`pnpm.auditConfig.ignoreGhsas` in package.json), until the move to zod 4. zod checks the local config file, request bodies and plugin manifests. The worst case is a slow or crashing server, not access. Moving to zod 4 changes how `.default({})` fills nested defaults, so it needs its own careful change.

## Still to review

- **Each route's own checks:** local-only settings, and the size limits on request bodies.
- **Plugins:** the plugin sandbox and permissions, and the code the community store installs.
- **The agent's file tools:** how folder boundaries handle symlinks and `..`, and the approval rules.
- **Remote access:** token rotation and how the token is stored on the phone.
