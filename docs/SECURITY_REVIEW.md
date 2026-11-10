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

22. **Connecting Claude from anywhere (0.5.92).** A custom connector in the Claude app reaches KesherAI's MCP server through the internet link. Its key is a device key with scope `mcp`: it opens `/mcp` and nothing else (tested: /api, /v1 and the device list answer 403 to it), shows under paired devices and is removed alone. It travels in the link (`?token=`), since connectors without sign-in send no headers; the request log never keeps query strings. Like device links, a few can be made an hour, each is announced on the computer and the phone, and approval cards stay the user's.

23. **Fixed addresses for access from anywhere (0.5.93):** the user's own Cloudflare tunnel (a subdomain of their domain) or Tailscale Funnel (their ts.net name). Choosing one and setting it up is computer-only. Funnel passes requests to 127.0.0.1, but they name another host and carry forwarding headers (and `Tailscale-Funnel-Request`, now in the list), so they are never "from this computer" and need a key; they count as coming through the internet link for "only paired devices" and the idle-key rule. The Cloudflare tunnel's key file stays in the user's ~/.cloudflared.

24. **Scan after 0.5.95** (phone notifications, connector keys, fixed addresses, the Unreal checks, the editor socket).
    - **Fixed:** from a paired device, phone notifications could be turned off or moved to a new topic: a stolen phone could silence the "someone tried to get in" alerts. Both are computer-only now.
    - **Fixed:** pressing "Sign in to Cloudflare" again started another cloudflared each time; now the waiting sign-in's page is reused.
    - **Checked:** a connector key cannot make more keys (its scope closes /api); the editor socket's bare-Origin exception is for `/api/unreal/ws` only and the socket stays computer-only; the Cloudflare address is checked before it reaches cloudflared, whose arguments are a list (no shell); `unreal_python` writes its script only inside the project's Saved folder.
    - **Faster:** `unreal_compile` and `unreal_python` answers are much shorter (distinct errors only; no start-up noise), and the Unreal guide sent with each message is ~57% smaller.

25. **Scan after 0.5.99** (zod 4, the editor's project path, the Blueprint model choice and AI bubble, target phones).
    - **Fixed:** a phone read over USB names itself (its model and GPU strings), and that text goes into the model's brief: it is now cut to plain characters and 60 letters, so a phone cannot carry instructions to the model.
    - **Fixed:** reading the plugged-in phone runs one at a time (each read runs adb and dumpsys).
    - **Checked:** the editor's `projectFile` is kept only when it is a real `.uproject` on this computer, and a chat takes it only when its name matches the project the page named; the editor socket stays computer-only. The Blueprint edit's `model` must be a chat model listed here. Target phone ids must be in the catalog or read over USB. The Unity frame-rate script is written only into the project, only for an Android build the user approved, and only with target phones chosen.
    - **Dependencies:** zod 4 (0.5.96) removed the last audit exception; `pnpm audit --prod` is clean.

26. **Scan after 0.6.2** (the code start screen, the Blueprint editor, the code view, the plugin's own update).
    - **Checked:** "Update automatically" closes Unreal only through the plugin, which first asks on the computer to save unsaved work (Cancel keeps it open); the editor that is opened again is the engine's own `UnrealEditor.exe` from the engine folder found on this computer, with the `.uproject` the plugin reported (kept only when it is a real file here). The plugin's files are replaced only inside the project's `Plugins/KesherAIBridge` (the old one removed, as Install does).
    - **Checked:** the Blueprint editor's actions go through the same `/api/unreal/apply` (one undo step in the editor); the right-click search sends only words to the editor (no paths or code); undo/redo are the editor's own. The editor socket stays computer-only.
    - **Checked:** the code view's "Apply" is a request to the model like the AI bubble (capped at 8,000 characters); the code start screen opens a code session only in a folder that exists (`assertFolder`), as the old dialog did.
    - **Faster:** `unreal_read_graph` / `unity_read_graph` now answer with the graph as code (much shorter than every node, pin and link).

27. **Scan after 0.6.7** (Widget Designer, Figma → widgets, textures, new Blueprints, the plugin's self-update from an old plugin).
    - **Checked:** a new Blueprint's name must be letters, digits and `_`, its folder must be under `/Game` (checked in KesherAI and again in the plugin); a waiting one is kept only in KesherAI's own data folder.
    - **Checked:** Figma → widgets asks only api.figma.com with the token in a header; each picture comes only over HTTPS from Figma's image hosts (at most 12 MB, must be a PNG), is written to KesherAI's data folder under the widget's sanitized name, and is imported only under `/Game/UI/Figma`. The plugin imports only `.png` files that exist and only under `/Game`.
    - **Checked:** widget changes are capped (200 operations a call); they change only the chosen Widget Blueprint's widgets, in one undo step. The model's operations are cleaned first (one property per change).
    - **Checked:** an update started from an old plugin waits for the user to close Unreal (never closes it itself); with plugin 0.1.6+ Unreal asks to save first and Cancel keeps it open.

28. **Scan after 0.6.12** (the Test button, Blueprints connected to chats, projects and scripts from the phone, continuing after a restart).
    - **Checked:** a test run plays only in the editor's play world (the Actor is placed there, the level is not changed) and always ends with `play_stop`; one test at a time. KesherAI reads back only the plugin's own picture (`Saved/KesherAI/test-run.png`), never another path the socket names; the editor socket stays computer-only.
    - **Checked:** from the phone, + → Project adds only a Unity/Unreal project found on the computer (KesherAI's Unity projects, Unity Hub's list, the usual Unreal Projects folders, the connected editor); any other folder still needs the computer's own dialog. + → Script searches only the chat's own folders (its workspace and what was given to it), skips generated folders, does not follow symlinked folders and stops after 30,000 entries.
    - **Checked:** "Continue where it stopped" sends a fixed message only for a chat KesherAI itself recorded as working when it closed; the list is kept in KesherAI's data folder and capped.
    - **Fixed:** effects in the web app returned values by accident; newer Chrome returns a Promise from `scrollIntoView`, which React then called (the Blueprint page crashed). All effects now use block bodies, and a lint rule keeps it so.
    - **Dependencies:** `pnpm audit --prod` checked again.

29. **Scan after 0.6.19** (computers finding each other, memory/processor/temperature limits, the split choosing models by hardware, one-click plugin install, startup routines with a folder, view_image, checkpoints of game projects, Verse).
    - **Fixed:** an "I'm here" datagram that named one of the user's computers started a check of that computer each time; a flood of them (from anyone on the network) made this computer call out without limit. Now at most one check per computer every 10 seconds. The check still goes only to the addresses that computer published, never to the sender.
    - **Checked:** a routine's folder can be set only on the computer, only inside the home folder (not the home folder itself); saving a routine from the phone with a folder is refused, and a phone edit replaces the action, so it cannot keep or add one.
    - **Checked:** one-click plugin install from the phone takes only a project found on the computer; the plugin is written only into that project's `Plugins/KesherAIBridge`.
    - **Checked:** `view_image` reads only through the chat's own folders (the same resolver as the file tools), picture types only, at most 8 MB. The split asks another computer's `/api/guard` with that computer's own device key and uses only that computer's own models. The temperature read runs a fixed command (no input). Checkpoints of Unreal/Unity projects skip generated folders and files over 50 MB. The Verse translation takes only a model listed here and caps the code it sends.

30. **Scan after 0.6.21** (tool calls written as text, the Unity test and performance tools, self-work, long-term approvals, the window's saved place).
    - **Checked:** a tool call a local model writes as text (Qwen3-Coder XML, Hermes JSON) is read only from the model's own answer, only when the request offered tools and the answer had no real call; it then goes through the same approvals as any call (a quoted file cannot skip them).
    - **Checked:** "Always allow" for a while ends at its time (rules that ended are dropped on the next save, and never match); a rule for one command matches only that command's words followed by plain arguments: anything chained after it (`;`, `&&`, `|`, `>`, backticks, `$( )`, a new line) needs approval again. Dangerous commands (push, recursive delete, installing programs, admin rights) still ask every time, whatever the rules say.
    - **Checked:** self-work works only in a git project inside the home folder with no uncommitted changes, on a new `kesher-self/…` branch; git runs with its arguments as a list and never pushes, merges or switches back. The check command is a command line the user typed on the computer; from the phone a run can only start again with the same project and the same check. Stop rules: goal met, BLOCKED, 3 failures in a row, 45 minutes per item, 30 minutes waiting for an approval, the time limit and 80 turns.
    - **Checked:** the Unity test always leaves Play Mode (also on an error) and reads back only its own picture in KesherAI's folder; `unity_performance` only reads.
    - **Checked:** the window's saved place is used only when it is on a connected monitor.

31. **Scan after 0.6.24** (code views, C# scripts as nodes, the task board, the self-work worker).
    - **Checked:** C# scripts are read and written only inside the active Unity project's `Assets/`, only `.cs`, at most 400 KB, through the same path guard as the chat's Unity tools (links followed, must stay in the project); a write is refused when the file changed since it was opened, and the old text is kept in KesherAI's folder first. From the phone this is allowed (the paired owner), like the chat's `unity_write_script`.
    - **Checked:** the self-work worker listens on 127.0.0.1 only, with remote access and device sharing off whatever its settings say; it runs from its own copy in KesherAI's data folder (never the install folder, so an update can neither break it nor be blocked by it). The main app talks to it only at that fixed local address; a sender can never choose where a request is passed. Worker-only routes (`upgrade`) and the worker's `notify` are refused unless they come from this computer; `notify` only takes a chat link of KesherAI's own form.
    - **Checked:** the task board is one file in KesherAI's data folder, written atomically (temp file + rename) one writer at a time; requests from the interface always write as "roee"; at most 50 changes a call, titles and texts capped, notes kept to the last 500.
    - **Checked:** self-work's git calls take arguments as a list; `fetch` only reads; the worktree is a new folder next to the project and a new branch; nothing is pushed or merged.
    - **Checked:** the C++/Verse/C# views send only the graph as code to the chosen local model and show the answer as text (never run or written anywhere).

32. **Scan after 0.6.27** (Unity AI Assistant connection, the interface check, the styled-frame flow, variables panels for C# scripts, Blueprints and Script Graphs, full screen).
    - **Checked:** variable changes go to the editor as data (Unreal: a JSON message on the plugin's local socket; Unity: one CLI argument, the CLI started with its arguments as a list, never a shell). At most 50 changes a call; names and types are checked again in the editor (a type must be a real class or struct). From the phone this is allowed, like the graph edits it already makes.
    - **Checked:** C# variable edits are text changes made in the page and saved through the same `/api/unity/script` guard as before (Assets only, `.cs`, size cap, mtime check, a copy kept first). Renaming touches only the class's own code, never strings or comments.
    - **Checked:** connecting Unity's AI Assistant is allowed only from this computer, writes one entry into the project's `UserSettings/mcp.json`, and gives it a key limited to the MCP tools (not the whole API).
    - **Fixed:** on Windows, saving a library file failed when another program held it for a moment (antivirus, a reader): now it tries again a few times and removes its temp file when it gives up.
    - **Checked:** the interface check (CI) starts the server on 127.0.0.1 with an empty data folder and no network discovery.

33. **Scan after 0.6.30** (the shared code editor, Rider mode's language server, Unreal C++ editing, inline suggestions, the AI bubble on code, plugin 0.1.10).
    - **Checked:** Unreal C++ files are read and written only inside a project found on this computer (or the one open in the editor; a sender cannot name any other folder), only under `Source/` and `Config/`, only `.h/.hpp/.cpp/.inl/.cs/.ini`, through the same path guard as the Unity scripts (links followed, must stay inside), at most 400 KB, refused when the file changed since it was opened, the old file kept first. Compiling runs Unreal's own Build.bat with its arguments quoted and refused when they hold cmd's special characters (the same runner as the chat's tools), or asks the open editor for Live Coding.
    - **Checked:** the language server is csharp-ls from the user's own `.dotnet/tools` folder, started with the project's own .sln and no shell; installing it (`dotnet tool install --global csharp-ls`, the user's own tools, no admin rights) is allowed only from this computer and was approved by Roee. Its WebSocket serves only the active Unity project; messages over 2 MB are dropped; the server is stopped 10 minutes after the last editor leaves.
    - **Checked:** inline suggestions and the AI bubble send the code around the cursor (at most 6 KB before and 2 KB after) or the file to the model the user chose (or the active one); answers are only shown or put into the editor, never saved or run until the user saves. Off when no inline model is chosen.
    - **Checked:** code coloured for reading (chat blocks, translations) is the editor's own escaped output; nothing from a model is put into the page as HTML.

34. **Scan after 0.6.37** (self-work's model pick and LM Studio loading, models found on the computer, the built-in engine's port, approval wording).
    - **Checked:** self-work talks only to the LM Studio address in the user's own provider settings (never one a sender gives) and only lists, unloads and loads the chosen model there.
    - **Checked:** "Set it up for me" now loads a copy of a recommended model it finds in another app's folder (LM Studio, Ollama, Hugging Face…). It only reads it, checks it is GGUF by its first bytes, and never copies, moves or deletes it. "Load" by path still accepts only KesherAI's folder and folders the user added.
    - **Checked:** when another program answers on the engine's port, the engine starts on a free port on 127.0.0.1 (never on the network), so the health check cannot be answered by that program.
    - **Fixed:** the approval card said PowerShell's `Format-List`/`Format-Table` "can erase a disk". Now only `format X:`, `Format-Volume`, `mkfs`, `diskpart` and `fdisk` get that warning. A mention of a file such as `llama-server.exe` no longer makes KesherAI push the model to build a program.
    - **Performance:** looking for models on the computer walks big folders (ComfyUI, the Hugging Face cache), so the result is kept five minutes and dropped when the model folders change.

35. **Scan after 0.6.39** (embedding models found on the computer, search by meaning while indexing again, the window place, check_code wording, LM Studio's bundled models).
    - **Checked:** setting up search by meaning is still allowed only from this computer. The model it may pick comes from KesherAI's own folder or another app's model folder (never from a request), is only read, and runs in KesherAI's embedding engine on 127.0.0.1.
    - **Fixed:** after the embedding model changed, a base that was still being indexed again was searched with the old model's vectors, so the results meant nothing. Search now uses only vectors from the active model, of the same size, and falls back to words for the rest.
    - **Checked:** the window place file holds only positions and sizes. A hidden window's place is no longer written.
    - **Performance:** the computer is looked over once per setup, and the models page keeps the result for five minutes. LM Studio's bundled-models folder is small.

36. **Scan after 0.6.45** (project facts, the engine's context share, persona settings, importing MCP servers and personas from other apps).
    - **Checked:** project facts are fixed sentences filled only with a command's program part (one word, or `python -m module`), whitespace and backticks removed, at most 80 characters, 4 facts and 600 characters per chat. Command output never reaches the prompt as text. They are stored in KesherAI's folder, and the user sees and removes them.
    - **Checked:** MCP servers found in other apps' configs are listed with their command and only the names of their keys. They are added turned off, only from this computer. The server reads the config again when adding (the page only names the server); only http(s) addresses are accepted; key values are copied only when ticked.
    - **Checked:** personas from LM Studio presets and Ollama Modelfiles are added only when ticked, only on this computer, with the same limits as any persona (20,000-character instructions, 6 starters of 300 characters). Settings are range-checked (temperature 0–2, top_p 0–1, up to 4 stop texts of 40 characters).
    - **Checked:** a request too long for the model is retried once per step, with a smaller window (never below 2,000 tokens).
    - **Performance:** reading Ollama's manifests read the params layer twice per model; it is now read once, together with the examples.

37. **Scan after 0.6.50** (personas from LobeHub/Open WebUI files, more MCP config paths, AnythingLLM's models, the context fixes, the release workflow).
    - **Checked:** a persona file can be uploaded from the phone too (it only adds personas). It is limited to 20 MB and 100 personas, each with the usual persona limits; an icon is at most 2 characters.
    - **Checked:** the Microsoft Store path for Claude Desktop is found by listing only `Packages\Claude_*`. The config file there is read with the same rules as the others (listed without key values, added turned off).
    - **Checked:** the learned characters-per-token ratio is held between 1.5 and 6, and a refused request is retried at most twice per step.
    - **Fixed (release):** the three builds used to create two releases with one tag. Now one draft is made first, the builds upload into it, and it is published with its notes at the end, only if the draft step succeeded (verified with 0.6.49: one release, 11 files, notes).

38. **Scan after 0.6.52** (the code page's git panel, looser edit_file, the write_file guard, context from memory, sampling defaults, self-work skipping items).
    - **Fixed:** a new file's diff used `git diff --no-index`, which reads any path on the computer, and the path came from the request. Now only a new file that git itself lists in the chat's project is shown.
    - **Checked:** the git routes find the project from the chat (never a folder from the request). File paths go after `--`, and a path that starts with `-` is refused. Branch names must look like branch names (no option, no `..`). The message goes to git as one argument. One git write runs at a time per project. Push needs a confirmation in the panel. `GIT_TERMINAL_PROMPT=0` means a push that needs a password fails with git's message instead of waiting.
    - **Checked:** the paired phone can commit and push too. That is by design, since the phone is the owner's device with its own revocable token. The push still asks first.
    - **Checked:** a skipped self-work item is undone with `reset --hard` and `clean -fd` only in the run's own worktree, never in the project's checkout. Files git ignores are kept.
    - **Checked:** looseEdit changes the file only when the loose match is unique, and the change still goes through the same approval and diff as edit_file.
    - **Performance:** the context is no longer fixed. llama.cpp's fit shrinks it before moving layers to system memory, so a model that fits the card keeps its full speed.

39. **Scan after the 0.6.55 changes** (Gemini CLI and Claude Code in the terminal, self-work routines, Resume and the stuck-turn watch, the commit-in-turn check, the engine's context, checkpoint and margin settings, the phone's downloads button).
    - **Fixed:** a self-work routine runs its check command on this computer, and a routine starts self-work through the route as a local request. A paired phone could therefore have saved a routine with any check command. Now a self-work routine is saved from the phone only with the same project and check as the last run (the panel's Start rule); on the computer, as before.
    - **Checked:** the terminal starts only commands it knows by name (`gemini`, its install and update, `claude`). The request never gives a command. Claude Code's environment points it at KesherAI on 127.0.0.1 and clears ANTHROPIC_API_KEY, so the user's own key is not used. Gemini CLI gets no extra environment and keeps its own sign-in.
    - **Checked:** `/api/agent-clis` only runs `where`/`which` with fixed names.
    - **Checked:** the commit-in-turn check and Resume read git in the run's own worktree only. Resume refuses a finished run and a run whose folder is gone.
    - **Performance:** shortening older tool outputs no longer moves every turn (the engine's prompt cache survives). Hybrid models get context checkpoints every 1,024 tokens. Fitting leaves 2 GB free on the card. A commit check runs every 30 s during a turn, which is one `git rev-parse`.

## Known, not yet fixed

- ~~**zod 3:**~~ fixed in 0.5.96: moved to zod 4.6.7 (GHSA-mrhx-c7xc-m3w5 no longer applies; the audit has no exceptions). `.default({})` became `.prefault({})` so nested defaults still fill in; the parsed config of an empty and of partial files is identical to before.

## Still to review

- **Each route's own checks:** local-only settings, and the size limits on request bodies.
- **Plugins:** the plugin sandbox and permissions, and the code the community store installs.
- **The agent's file tools:** how folder boundaries handle symlinks and `..`, and the approval rules.
- **Remote access:** token rotation and how the token is stored on the phone.

## Scan 40 (2026-11-10): Select, model delete, Antigravity CLI buttons, notifications page, Menu

- **`/api/inbox/answer`:** `requestId` must match `^[\w-]{8,64}$`. `conversationId` reaches `conversations.open`, which only opens known ids (it looks up the library's summaries, so no path is built from the request). Self-work answers go only to the worker address KesherAI started itself, never to an address from the request. Same access as `/api/approvals` and `/api/conversations/:id/approvals` (local, or a paired device's key).
- **`/api/inbox` notes:** these are the bodies exactly as they went to the phone, so "include the text" still decides whether a message's content shows. The body is shown as text, and only `#/` paths become links.
- **Terminal `agy*`:** still only named commands, never a command from the request. The installer is Google's own `install.ps1` over HTTPS and runs only when the user presses the button. PATH adds only `%LOCALAPPDATA%\agy\bin`.
- **Model delete** (scan 39 follow-up): only inside the models folder, never the loaded model; checked.
- **Performance:** the bell polls `/api/inbox` every 6s and skips hidden tabs. The worker query has a 3s timeout, and the worker is not asked when it is not running. The Menu adds no listeners while closed.
- **Nothing to fix.**
