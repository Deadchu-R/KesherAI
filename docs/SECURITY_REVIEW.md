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

## Scan 41 (2026-11-10): ACP client, Antigravity code chats, saved notifications, MTP setting

- **ACP spawn:** the command comes from a fixed table (`agy acp`), never from the request. The only input is the code chat's own folder, which is an absolute path that must exist, passed as one argument after `--add-dir`. No shell is used. Only code chats get it. Processes end with the chat and when KesherAI quits.
- **Sign-in and permissions:** KesherAI advertises no file-system or terminal capability and never handles tokens. Each permission answer is mapped to one of the agent's own options, and anything else is a cancel; a test checks this. KesherAI never passes `--dangerously-skip-permissions`.
- **notifications.json:** title, body as sent, `#/` path, time and channels only; the one-time Approve / Deny codes are never written. A test checks this.
- **`/api/engines/llamacpp/settings` `mtpDraft`:** an integer from 0 to 16, or null; anything else is a 400. It has the same access as the existing `parallel` setting.
- **Performance:** one agent process per open Antigravity chat, started on its first message. Saving notifications is debounced to once a second.
- **Nothing to fix.**

## Scan 42 (2026-11-10): Claude Code import, home-folder guard, Antigravity choices, MTP default

- **Claude Code import:** this computer only (403 from devices). Only `.jsonl` files under `~/.claude/projects` are read (a relative path that would leave it is refused; tested), at most 60 MB. Thinking, tool output and Claude Code's wrappers are never copied, so secrets in command output stay out. A session from the home folder or a drive root becomes a plain chat, not a code chat over everything (found on the PC; tested).
- **`/api/conversations/:id/agent-options`:** only for code chats on an outside agent. `configId` and `value` are strings of at most 200 characters, and the value must be one of the agent's own choices (tested). Opening the menu starts the agent's CLI, which the chat's first message would do anyway.
- **MTP default 2:** an engine flag only.
- **Nothing to fix.**

## Scan 43 (2026-11-10): board categories and shortcut, board file path, load view, Terminate

- **Board categories:** one of `normal | cooldown | fable`. Anything else is an error on edit and becomes `normal` on add. Self-work is told to take only `{cooldown}` tasks, and it still refuses outside agents (`agent/*`), so Antigravity never runs unattended.
- **`/api/self-work/board/file`:** this computer only (403 from devices). On the phone, + pastes the task list instead of a path, so the PC's folder names never reach a device. The username was removed from the code and from git history (filter-repo; checked on a fresh mirror).
- **`/api/pc-status`:** read only, with the same access as the rest of the API (local, or a paired device's key). It shows the card's name, load and memory, never files or processes. The guard's measurement is throttled to once every 2.5 s whoever polls. The page skips the poll while its tab is hidden (fixed now).
- **`/api/system/terminate`:** needs `{confirm:"terminate"}`, and the page asks first. It needs a JSON body, so a cross-site form cannot send it. It stops self-work (and its worker, only at the address KesherAI started), ComfyUI and the engine, then restarts. It leaves a `terminated` mark in the data folder, so the next start, within 10 minutes and once only, loads no model and starts no ComfyUI. Found on the PC: without it, both came back by themselves. Tested.
- **Fixed:** the hidden-tab poll, and the start after Terminate.

## Scan 44 (2026-11-11): 0.6.73–0.6.86 (phone menus, board in plain chats, notifications, settings, git identity, engine fixes)
- **`POST /api/conversations/:id/board-project`:** the request names no folder. The server picks the newest code chat's folder that is a git project inside the home folder (not the home folder itself) and grants that to the chat. From the phone, the most this can do is open a folder the user already works in to one of their chats.
- **`list_files` and `search` in granted folders:**
  - Both still go through `resolveForTool`, which accepts only the workspace or the granted roots.
  - `search` gained a `path`, checked the same way.
  - Folders are compared by real path (8.3 short names on Windows), so nothing outside them is reached.
- **Antigravity approval cards** now show the diff or raw input the agent sends (capped at 6 KB), so edits are not approved blind.
- **`saveConfig`:**
  - Writes a new file with mode 0600, then renames it, one write at a time. Two writes at once had corrupted config.json (found in CI).
  - The temporary file is removed when the rename fails.
- **The agent's git identity:** `KesherAI <kesherai@noreply.invalid>` for every command the agent runs and for self-work's git. The user's own git email never reaches an agent commit (`.invalid` is a reserved domain).
- **Notifications:**
  - A waiting note keeps only the conversation id (`ref`) and how it ended.
  - The history file still keeps no actions or one-time codes.
  - A stopped run sends no "Done".
- **Live stream:**
  - The server pings every 10 s.
  - The page reopens a stream that is quiet for 25 s, and only while the page is visible. There is no new endpoint.
- **Start-up routines:** at most once in 6 hours. Repeated restarts no longer make a chat and a notification each time.
- **Unity gating:**
  - The project name goes into a RegExp only after escaping.
  - Matching only decides which tools go to the model. It grants no access.
- **Not changed, noted:**
  - A saved rule (Nov 7) lets run_command run everywhere without asking. It is the user's choice; dangerous commands still ask. It is listed for Roee in his Thursday list.
  - Destructive git on the PC (reset --hard) was refused by the safety check and left for the user.
- **Result:** nothing to fix.

## Scan 45 (2026-11-11): 0.6.87–0.6.95 (chats at once, shortcuts, pins, unified menu, self-work panel, board rows)
- **Shortcuts (`PUT /api/shortcuts`):** an address must be `#/…` (a fixed character set) or http/https up to 500 characters; `javascript:`, `data:` and `file:` are refused (tested). Web shortcuts open with `rel="noopener noreferrer"`. Up to 25, names up to 40 characters.
- **Pins (`PUT /api/pins`):** app pages only (`#/` and word characters), up to 40, de-duplicated.
- **`POST /api/conversations/:id/board-project`:** grants only a folder that was already a code chat's workspace, inside the home folder and with `.git`; never a path from the request. The grant goes through the session's own checks.
- **Self-work approvals in its panel:** the same `decide()`/`dangerReason()` gate; nothing new can approve without a click. The disk-erase rule no longer flags `wmic … /format:list` (tests added), and still flags `format C:` and `Format-Volume`.
- **Performance:** the self-work panel and the board stopped polling every 5 s while the tab is hidden (the phone in a pocket). The board drew one bordered box and one pill per row; now plain rows with a divider.
- **Privacy:** no email, Windows user name or personal path in the code or commit messages since scan 44 (checked with `git log -p` on the new commits).

## Scan 46 (2026-11-11): 0.6.96–0.6.101 (the phone app's own notifications, self-work's reviewed work, self-work page)
- **Phone notifications (`/api/phone-push/*`):** only a paired device with its own key (not the shared token), so removing the device stops them. The UnifiedPush address must be https, without a user name, up to 1000 characters, on a name that resolves only to public addresses (no SSRF into the home network). Redirects are not followed. 404/410 drops it. The message is encrypted for the phone (RFC 8291), so the distributor's server sees only ciphertext. Confirmations count only from the device they were sent to. At most 3 live connections per device. `GET /api/phone-push` gives the paired phone the internet link it already uses.
- **On the phone:** only the computer the app has open can set where notifications come from (origin check against the open page). Approve/Deny need an unlocked phone (`setAuthenticationRequired`), and post only to the computer's one-time `api/quick-approve/<32>` addresses. UnifiedPush calls are guarded, so a failing library cannot stop the app.
- **Self-work's reviewed work:** a diff-line comment goes into the chat as the user's own text (nothing runs). `insertStep` only edits the in-memory graph. All 4 commits carry the agent identity (`kesherai@noreply.invalid`); `.kesher-self/plan.md` was kept off main.
- **Self-work page:** reads the worker's last run from its own fixed file (no path from the request). A run the worker no longer runs shows as stopped. Notifications open `#/self-work`, not a chat the main app cannot see.
- **Access alerts:** 5 refusals from an address a paired device used in the last hour now say "a device was refused" (seen: the phone app updating), not "someone tried to get in". It is still reported, because a mobile network shares one address among many people.
- **Phone app pairing:** a Google sync no longer writes the shared token over the phone's own key. Before this, every start traded it again: a new device on the computer each time, and old codes refused.
- **Privacy:** the new commits and code hold no email, user name or personal path (checked the self-work patches before applying).

## Scan 47 (2026-11-11): 0.6.102–0.6.105 (right key no longer locked out, engine calibration, what fits, self-work's self-review, one task list, settings split)
- **Lockout (`packages/core/src/auth.ts`):** the guessing lockout (20 wrong keys from one address in 10 minutes) now refuses only wrong keys. A right key is never refused because the address had wrong tries first — a phone on a mobile network shares its address with many others, and it once locked the user out after one old code. Wrong keys are still locked out (tested: `tunnel.test.ts` — 20 wrong tries make a 429, then the right key still comes in).
- **Calibration (`packages/core/src/calibrate.ts`, `llamacpp.bench`, `POST /api/models/calibrate`):** llama-bench measures reading and writing at 8- and 16-bit context, at 0/16K/48K tokens, and KesherAI recommends one. The model path is checked with `allowedModelPath` (models folder or a folder the user added); the engine and every chat must be quiet first (409); one run at a time, stoppable; the tool is spawned with an arguments array, no shell. `calibrate.ts` itself is pure parsing and advice. The result is kept per model and card; using the recommendation changes only `kvType`.
- **"What fits?" (`packages/core/src/fit-preview.ts`, `POST /api/models/fit`):** llama-fit-params (the same fitting llama-server does at start, test allocations only) answers how many layers go to each card and what fits next to what is loaded. The model path is checked with `allowedModelPath`; the tool runs with a 120 s limit and a 100 KB output cap; the answer is kept a minute per model. `fit-preview.ts` is a pure text parser (tested). "Memory to leave free on the card" (`fitTargetMiB`): the API accepts an integer 512–16384 MB (validated in `PUT /api/engines/llamacpp/settings`), the UI offers 1–8 GB with 2 GB the default.
- **Self-work's self-review (`packages/core/src/self-work.ts`, AGENTS.md):** after an item's check passes, the model gets one review turn with a short checklist before KesherAI commits — read the own diff, match the code around, exact names, Hebrew and English, nothing left over, close with `ITEM DONE: <board id>`. An item finished without its closing line is named from the plan line it ticked. The review is a model turn inside the same session: no new tools, no new paths, no privilege; the commit stays on KesherAI's side.
- **One task list, by size (`packages/core/src/task-board.ts`, `TaskBoardView.tsx`):** Claude and self-work share one list; tasks get a size (small for self-work, big for Claude), a task can be handed to self-work (it takes it first whatever its size), Fable's tasks stay apart. The board's endpoints were not changed; `add` and `note` keep the existing size limits and validation.
- **Settings split (`apps/web/src/settings/`):** four sections (ActiveModels, GoogleDrive, OneDrive, Sync) moved next to the other section components; a move only — same components, imports fixed, no behavior change.
- **Phone screen (t21):** the computer panel scrolls on a short phone screen (PcLoad and Terminate were below the fold) — one `@media` rule on the existing `.hub-pop` and `--bar-h`.
- **Tests (`packages/core/src/server.test.ts`):** the server test no longer depends on the built example plugin — it writes its own echo plugin into a temp dir (hermetic, fast, same assertions).
- **CI:** the browser install is more patient — one timed try of the system packages, then the browser alone (Ubuntu's mirrors failed two releases on 2026-11-11).
- **Not changed, noted:** the calibration and fit endpoints answer a 500 with the engine tool's own error message, as the other engine routes do; it is a local tool's text, not user input.
- **Not changed, noted (pre-existing):** self-work's `git add -A` picks up `.kesher-self/plan.md` (not gitignored), so the plan file keeps reaching main and a review removes it again (a732193 did; many earlier runs too). On the board.
- **Privacy:** the new commits and code hold no email, user name or personal path (checked the whole range's diff).

## Scan 48 (2026-11-13): 0.6.106–0.6.107 (self-work's four runs, the conversations.ts split, chat accessibility)
- **Self-work's runs (t26–t28, t31, t36, t37, ModelFolders, gitState), reviewed before main:** the access log's key kind is derived from the key's shape and a constant-time compare with the shared token; the value is never stored (tested). `gitState` runs `status` before `diff` so two git processes do not open the index at once on Windows. No path, email or user name in the patches.
- **The split (t7):** moves only. `ruleAllows` (the "always allow" rules) is byte-identical in `approval-rules.ts` and still covered by its tests; the tool builders became functions over the same services, with no new input reaching them.
- **Import cycle removed:** `graph-edit.ts`, `blueprint-test.ts` and `widget-edit.ts` import `model-turn.ts`, not `conversations.ts`.
- **Chat accessibility:** the history is `role="log"` with `aria-live="off"` and a separate polite status line; no user text goes into the status line (fixed phrases only).
- **Performance:** the live region on the whole history made assistive technology re-process the answer on every token; that is gone. Nothing else changed at run time.
- **Noted for later (docs/DESIGN_RESEARCH.md §7):** plugins still run inside the server's process with full access; permissions are declared, not enforced. It is the top item on the list (t39).

## Scan 60 (2026-11-14, after 0.6.181–0.6.183 and the pure nodes)
- Plugins in their own process (t39): a plugin without "network"/"shell" could reach Node's raw bindings
  (process.binding("tcp_wrap"), "spawn_sync") around the refused modules. Fixed: process.binding and
  _linkedBinding refuse; tested.
- The file sandbox kept the installed app's plugins from starting (the runner is inside app.asar, read as one file):
  the archive is now readable, and the fallback (own process without Node's file sandbox) looks at the whole error.
- Pure nodes: values are read from the user's own script and written back into it; no new input from outside.
  Parsing is linear in the value's length.
- GPU cleanup (0.6.181/182): only orphaned engines of KesherAI's own (llama/sd/whisper-server, parent gone) are closed.

## Scan 61 (2026-11-14, after 0.6.185–0.6.188)
- Plugin runner copy (0.6.188): it was written under a fixed name in the temp folder; on a shared Linux /tmp another
  user could place a link there or swap the file before it runs. Now in a new owner-only folder (mkdtemp), mode 0600.
- Game Helper: the global key Ctrl+Shift+G took VS Code's Source Control from every app; now Ctrl+Alt+G. The capture
  route answers this computer only; the picture route serves only game-*.jpg from that chat's folder.
- Sign-in returns (0.6.186): allowed only as a top-level GET navigation to the four callback paths; each checks its
  one-time state (and PKCE), so a page cannot complete a sign-in it did not start.
- Controller and handheld code runs in the page only; the zoom bridge (setZoom) clamps to 0.5–2.

## Scan 62 (2026-11-14, after 0.6.189–0.6.191 and the plugin file limits)
- Plugin file limits (runner): `new fs.ReadStream/WriteStream(path)`, `fs.openAsBlob` and `fs.glob` went around the
  wrapped functions; now checked too. Tested (a stream outside the plugin's folders is refused).
- Native code: without Node's permission model a plugin could `process.dlopen` a .node file from its folder and do
  anything; now refused unless the plugin declared "shell".
- Environment: every plugin process got KesherAI's whole environment (API keys a user set there included); now only
  what a program needs to run (PATH, temp, home and app-data folders, locale). Tested.
- Screens off (0.6.190): an owner action like restart (the token or this computer); no input.
- Unreal project lookup (0.6.191): a project file found by name among the projects KesherAI already lists, written to
  its own last.json; no path from a request.

## Scan 63 (2026-11-14, after 0.6.193–0.6.195 and the night's later changes)
- Performance: the controller's right stick looked for the page's scrolling area every frame (a style read per
  element on the page): kept for a second now.
- Game Helper load line: reads /api/guard every 5 s only while its window is open. The LB question puts the card's
  name in a web search the user asked for.
- Phone readings for charging habits stay in the phone's own localStorage (the last 240), never sent.
- LM Studio's MCP servers import like the others: off until the user turns each on after seeing its command.
- @lezer/highlight: CodeMirror's own highlighting tags, already in the tree; no network or code from outside.

## Scan 64 (2026-11-15, after the loop guard, self-work item cost, 0.6.198 icons and 0.6.199 Text Helper)
- Text Helper keystrokes (0.6.199): Copy and Paste are pressed only after the user's own global key (Ctrl+Alt+K), by a
  PowerShell helper that reads two fixed words from its stdin ("copy", "paste"), never text from a page; macOS sends a
  fixed osascript line. The Paste IPC is accepted only from the helper's own window (sender check plus the app's
  origin), up to 50,000 characters. `-ExecutionPolicy Bypass` applies to that one process, not to Windows.
- The clipboard is put back after each Copy and Paste (text, HTML, RTF, a picture; copied files are not kept).
- Fixed: selected text can come from any web page or email and carry instructions for the model, so the Text helper
  chat is made in "ask" mode (every tool that writes or runs asks).
- Fixed (performance): the helper waited for its answer by reading the whole chat every 0.7 s; it now waits on the
  small activity list and reads the chat once.
- Selections wait in memory only (30 at most, 20,000 characters each, 10 minutes), behind the access token.
- Line icons (0.6.198): static paths drawn in React (no HTML from data); the user's own icons keep winning.
- Loop guard and item cost: counters in memory; no new input.

## Scan 65 (2026-11-15, after 0.6.201–0.6.204 and dictation)
- Fixed: chat timers saved their prompt to timers.json from an incognito chat too; incognito chats get no timer tools.
- Timers: a fired timer runs in the chat's own mode, so approvals still hold (no way around them through a timer); at
  most 10 per chat, 30 days ahead. notify_user: one a minute and 20 a day per chat; the text is the model's, and a
  tap opens the chat (no outside link).
- Dictation (Ctrl+Alt+D): the microphone is on only after the user's own key, for at most two minutes; the recording
  goes to /api/speech/transcribe (Whisper on this computer, or the cloud service the user chose for speech) and is not
  kept. The bar's window never takes focus, may only navigate inside the app, and is the only sender its paste IPC
  accepts (up to 20,000 characters).
- "What fits?" (0.6.201–0.6.202): llama.cpp's own error line is shown (cut to 300 characters), no paths added.
- Unreal bridge race (0.6.204): a disconnect during hello no longer throws (unhandled rejection in the server).
- Performance: the dictation bar loads the app again for each use (about a second); acceptable now, a kept-warm bar
  is a later improvement.

## Scan 66 (2026-11-15, after 0.6.205–0.6.207 and event routines)
- Office files (0.6.207): a small zip reader with limits (4,000 entries, 64 MB unpacked in all, each entry no more
  than its header says, so a crafted "zip bomb" stops); previews only inside the chat's folder, up to 50 MB; Word
  and HTML are shown in a frame with `sandbox=""` (no scripts, forms or same origin) and a CSP of no outside loads.
- Event routines: page routines read only http/https addresses the user gave (20 s, 3 MB), and a run happens only
  when the text changed. Fixed: the page's change and the changed file names reach the model quoted, as data, not
  instructions. Fixed: a watched folder is set only on this computer and only inside the home folder (the rule of a
  routine's own folder; from the phone a folder could otherwise be watched anywhere). The model has no tool that
  makes routines; only the user's own requests do.
- A folder routine ignores changes while it runs and for a minute after (its own writes do not start it again);
  changes are gathered for 20 s (up to 200 names).
- "What fits?" second run (`--fit-print on`) uses the plan's own arguments; nothing from a request reaches it.

## Scan 67 (2026-11-15, after 0.6.209–0.6.210 and the night's last changes)
- Keyboard (0.6.209): saved combinations are cleaned (known ids, real keys); a global key must hold Ctrl, Cmd or Alt,
  so no setting can take plain typing away from other programs; the desktop's `kesher:keys` IPC answers only the
  app's own pages; a key another program holds is reported, never forced.
- Pictures in Knowledge (0.6.210): read only from the folders the user put in a knowledge base, up to 8 MB; described
  only by the local chat model with its own vision file, never a cloud model; they wait while a chat is working (the
  card stays the user's), 12 per pass.
- A model server that is not running is now named as such (the model id only; no address or key in the message).
- Chat line icons: static drawings. Training and reset routes moved to their own files unchanged (reset stays
  local-only).
- Self-work: a run that asked for a path outside its folder was left waiting (approvals are Roee's), then stopped and
  started again told to use only its board tool. Nothing was approved on his behalf.

## Scan 68 (2026-11-15, after 0.6.211–0.6.213 and the git panel push)
- Fixed: the git panel's Push ran a plain `git push` when the branch had an upstream. Self-work branches follow
  origin/main, so with `push.default=upstream` a Push in such a chat would have gone to main. Push now goes only to a
  branch of the same name (origin/<branch>), with a test against a real bare repository.
- Dictation bar kept loaded (0.6.212): the microphone is closed at the end of each dictation (the tracks are stopped);
  the hidden window holds no stream. A new press while the microphone is still opening lets the old one go.
- Text Helper actions (0.6.213): cleaned (names up to 40 characters, instructions up to 1,000, 12 at most); they go
  only into the user's own prompts.
- Chat timer routes and the persona icon: moved / static, no new input.

## Scan 69 (2026-11-15, 0.6.217)

- **Found on the PC, fixed:** llama-server ran with no API key and allowed every origin ("CORS allows all origins"), so
  any website open in a browser on this computer could use the local model and read its answers. Each engine now
  makes a random key, passes it in llama-server's environment (`LLAMA_API_KEY`, not visible on the command line), and
  KesherAI's own providers send it. The key never reaches the interface (providers are listed with `hasApiKey` only).
- New `POST /api/{unreal,unity}/close`: same authentication as every API route (this computer or a paired device);
  "without saving" loses work, so it needs the explicit choice in the page's menu, and the editor plugin refuses it
  with the editor closed (headless) or, when saving, while the game plays.
- Model listing: split GGUFs now get an estimate for their full size (was the ~10 MB first part: "fits, 55,000 t/s").
- To check next: ComfyUI on 127.0.0.1:8188 has no key either (it does not send CORS headers by default, so pages cannot
  read its answers, but a simple POST could still queue work).

## Scan 70 (2026-11-15, 0.6.219)

- Task board: Claude and self-work may now finish or free each other's items (Roee's request). Who writes (`as`) is
  declared by the caller, behind the API's normal authentication (this computer or a paired device), so the board is a
  way to coordinate, not a security boundary; nothing on it unlocks a tool or a permission. Items Roee claimed still
  stay his. The self-work model is told to touch Claude's items only when Claude's note asks.
- Engine log: each model load now says who asked (start-up, a request, the Models page, calibration, updates), and
  `GET /api/engines/llamacpp` shows the last model's file name only (no folder), so the phone sees no local paths.
- server.ts B1/B2 moves, the phone rules move and ui-check's speed numbers: no behaviour change; tests unchanged and
  passing (562).
- Load race (0.6.218): an overtaken load no longer writes the settings. A second cause of an old model coming back
  after a restart is still open; the new engine log will show it on the next restart.

## Scan 71 (2026-11-15, 0.6.221)

- **Canvas (new):** canvases live in `<data>/canvases/<id>.json`; ids are checked (`[\w-]{1,80}`, so no path can be
  named) and a chat's canvas id is derived from the chat's id. Saves are capped at 5 MB and 5,000 elements, take a
  revision (a stale page cannot overwrite the model's newer change: 409, then it merges), and drop anything that is not
  an element with an id and a type. The `canvas` tool is `read` risk: it changes only the chat's own canvas, and
  incognito chats have none. Text from the model is capped (500 characters a shape).
- **Excalidraw 0.18.1** (new dependency, Roee approved): loaded only on the Canvas page. Its fonts are served by
  KesherAI; its built-in fallback to esm.sh is blocked by the CSP (`font-src 'self'`), checked in a browser: nothing is
  fetched from outside, the two unused fonts that try it stay unloaded. Its library browser and file opening are off.
  An `.excalidraw` file the user exports is plain JSON; opening files in the page is turned off for now.
- server.ts B3/B4 moves and the engine log line: no behaviour change. ui-check passes at both widths, including the
  Canvas page; speed numbers unchanged (0.3 s / 8 ms / 3 ms).

## Scan 72 (2026-11-15, 0.6.222–0.6.224)

- **Share links (new):** `/s/<token>` is outside `/api`, so the auth hook lets it through and the route itself is
  the check: a 128-bit random token (22 characters, base64url) compared by exact match; anything else is 404, and an
  expired or revoked share is 404 at once. The page sends `default-src 'none'` (no script, no picture, no request),
  `frame-ancestors 'none'`, `noindex, nofollow`, `no-referrer`, `no-store`. Its content is escaped HTML; only bold and
  inline code are turned back into tags, after escaping. The snapshot keeps the user's words and the answers only (no
  tool calls, results, approvals or instructions), files by name, and hides the home folder, any `C:\Users\<name>` or
  `/home/<name>` path, and key-like strings (sk-, ghp_, kd_, Bearer, token=, user:password@). The owner's routes stay
  under `/api` with the usual key; the share list never returns the token apart from the link's path. Tested from a
  non-local address: `/api/shares` 401, `/s/…` reaches the route. Incognito chats cannot be shared; sharing is always
  the user's action (the model has no tool for it).
- **pnpm audit (0.6.221 build):** 7 high findings came in with Excalidraw (nanoid, lodash-es) and a low one (katex):
  pinned to patched versions with pnpm overrides; `pnpm audit --prod --audit-level high` is clean again.
- **Image model:** a support file (VAE, LoRA, text encoder) saved as the active image model is no longer used; the
  chat tool falls back, pipelines say so.
- On the PC (Roee's request): the feature-research routine now uses KesherAI's active model, and the LM Studio
  connection was removed from this computer's settings (the code keeps LM Studio support; it is found again only if it
  is running at start-up, for that session).

## Audit 2026-11 (0.6.235): what else to check

From docs/AUDIT_2026-11.md §5. Fixed now: an update whose installer has no sha512 in the release's feed (the feed
did not load, or does not list the file) was installed with the check skipped; now it is deleted and not run, with
a test. Confirmed on the real 0.6.234 release that latest.yml, latest-linux.yml and latest-mac.yml list every
installer. Open: S2 connection keys in plain text in config.json (encrypt with safeStorage), S3 a test that the
Android bridge answers only the paired computer and links open outside the app, S4 signing (waits on SignPath),
S5 an outside scanner's rules for Electron.

## Scan 87 (2026-11-16, 0.6.266 + drug cards: Study)

- Course files: the id must match `[a-z0-9-]{8,40}` before it becomes a path (`../etc` is refused: tested); writes go
  to a `.tmp` and are renamed, one at a time. Lecture text is capped at 400k characters, summaries at 100k, cards,
  terms, drugs and quiz fields each have their own caps; reviews keep the last 50,000 and quizzes the last 200.
- Model output (summaries, terms, cards, quiz questions, drug cards) is parsed as JSON and copied field by field as
  strings; the page shows it as text or through RichText (no raw HTML), and the flowchart reader turns Mermaid into
  text boxes (no diagram library, no HTML). Quizzes are graded by code; medication answers are computed by code.
- Same access as the other pages (the phone through its paired token). Nothing leaves the computer except the text
  sent to the chat model the user chose. The design and PDF files hold made-up nursing examples, no personal data.
- Performance: the course list reads each course file once (cached after); the review queue sorts at most one
  course's cards. Nothing new runs at start.
- Git: no email, Windows username or personal paths in the new commits (checked).

## Scan 86 (2026-11-16, 0.6.264: MCP Apps)

- A tool's view (third-party HTML from an MCP server) runs in `<iframe sandbox="allow-scripts">` with no
  `allow-same-origin`: an opaque origin, so no access to KesherAI's page, cookies, localStorage or the API token; a CSP
  meta first in `<head>` (default-src 'none', https domains only from the server's own list, form-action and base-uri
  'none'). Messages are taken only from that frame's `contentWindow`.
- What the view can do: call tools of its own server only (`toolOf` checks the server and the disabled list); tools
  not marked read-only need the person's confirm (the server refuses without `confirmed`); open https links in the
  browser; put text in the message box (never sends by itself). Views over 8 MB are refused; `ui://` only.
- Tool results kept on the step for the view: ≤ 512 KB, the model does not see them.

## Scan 85 (2026-11-16, 0.6.263) and the app that closed after ~20 s

- Cause found (0.6.256–0.6.262): the knowledge indexes kept vectors as JSON numbers (2.4 GB, one base 515 MB) and
  every base was read and re-indexed together at start; the main process passed V8's 2.2 GB heap and was ended
  without an exit, a dump or a Windows report. Found with the sampled heap profile in `logs/main.log`
  (`knowledge.js` held 915 MB at 7 s). Fixed: float32 `<id>.vec` files (JSON 2.4 GB → 300 MB), old indexes read
  one at a time and rewritten, start-up re-index one base at a time. On the PC: heap 388 MB and steady.
- `logs/main.log` diagnostics (0.6.259–0.6.262): local only; child process lines are commands KesherAI itself
  starts (paths and model names, no keys: keys go in headers or env, never in arguments — checked); request lines
  hold method and path only (no query, no body); the heap profile holds function names and file lines of the app.
- MCP stdio transport: a program that writes 16 MB without a line end has its buffer dropped (was unbounded).
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.

## Scan 84 (2026-11-16, after 0.6.257 + APK 465)

- `GET /api/conversations/:id/peek` (sidebar preview): behind the key like every `/api` route; reads the saved chat
  from disk without opening a session (no model, no tools); returns at most three messages of 240 characters, code
  blocks replaced by "[code]". Unknown ids answer 404. Tested.
- `logs/main.log`: written only on this computer, cut back past 1 MB; holds start lines, exit codes and stack traces
  (file paths of the app, no keys or messages). The uncaught-error handler logs and keeps the app running, as
  Electron's own dialog did, without the dialog.
- Phone live connection: after 10 minutes without the computer it retries every 15 minutes (battery), and at once
  when the app opens (`LiveService.poke`, only while not connected). A page renderer crashing three times in five
  minutes closes the app instead of restarting it in a loop.
- Text Helper: the `cut` flag is a boolean kept with the selection; nothing new leaves the computer.
- `/status`, tab arrow keys, `<Code>`/`<Path>`, grouped and Hebrew notification titles: client-side only.
- Lint: no module-level listeners in apps/web; nothing below `routes/` imports from it (A6).
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.

## Scan 83 (2026-11-16, 0.6.256 + APK 464)

- Animate (`/api/comfy-ui/flows/:id?asset=`): the asset id must match `[\w-]{1,80}`, must exist and be a picture;
  only its bytes go to the local ComfyUI's `/upload/image` under a fixed name `kesher_<id>.<ext>`. No path from the
  request reaches the disk.
- Speed up from outside: emptying the Recycle Bin, closing a program and the Windows Update cache are behind the
  key like every `/api` route (the paired phone may use them, as asked: every feature works in remote). The update
  cache still needs Windows' own administrator prompt on the computer, so it cannot be done from the phone alone.
  `closeProgram` takes only `[\w .()+-]` names and never Windows' parts, security or KesherAI's engines.
- Phone crash report: Android's exit reason and the first 6000 bytes of its trace (addresses and library names, no
  messages or keys) are sent once, the same way and to the same route as the Java crash report, with the same caps.
  The renderer guard writes down only the page path, not its query.
- Phone health: package names are escaped before they go into the page; `clearOwnCache` deletes only inside the
  app's own cache folder (canonical path check); uninstall and emptying the trash use Android's own confirmation.
- App lock: the framework's BiometricPrompt with the device credential; nothing is stored but on/off.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.

## Scan 82 (2026-11-15, 0.6.255)

- Reviewed the ten changes since scan 81 (MoE estimate, Compare, What's new, charts, keys at rest, CivitAI, the GGUF
  reader, answer timing, games and cleaning, boost). Notes below hold.
- Found and fixed (performance): the GGUF header reader read a tokenizer one string at a time (the models list took
  89 s on the PC); it reads in 1 MB pieces and stops before the tokenizer (0.6.253). A `pos += await …` ordering trap
  in the array skip was found by a new test and fixed.
- Charts: SVG drawn from numbers only (labels as text nodes, no HTML from the model); bad JSON shows as code.
- What's new: release notes are shown as text (bullets), never as HTML.
- typecheck, lint and tests pass (619).

### Notes (0.6.252–0.6.255)

- Speed up (pc-clean.ts): only fixed folders inside the user's own profile (and Steam's shader cache); contents only,
  never the folder itself; symbolic links and junctions are not followed; files newer than a day are kept in temp;
  a browser or Steam that is running keeps its cache. The page asks before deleting, and says it is permanent.
- Boost (pc-boost.ts): emptying the Recycle Bin and closing a program each need a yes on the page; Close sends a
  normal close first (the program may ask to save) and forces only after a second yes; Windows parts, security,
  drivers and KesherAI's own processes are never listed or closed (allow-list of names, `[\w .()+-]` only). Windows
  Update's cache runs only through Windows' own administrator prompt (UAC), with a fixed encoded command.
- Games (pc-games.ts): read-only; removal only opens the store's own page from three fixed link shapes.

- CivitAI (F5): the download address, size and SHA-256 come from CivitAI's API by version id (never from the page),
  only `https://civitai.com`; the file name is cleaned to `[\w.-]` and lands in the LoRA folder; the picture proxy
  fetches only `https://image.civitai.com`, images only, 3 MB at most; adult models are off unless asked, and their
  pictures are never shown. The CivitAI key is set from this computer only, never returned, and stored encrypted.

- Keys at rest (S2): provider keys and the Telegram, Figma and GitHub tokens are written to config.json as
  `enc:v1:<base64>`, encrypted with Electron's safeStorage (DPAPI on Windows: only this Windows account can read them),
  in the main app and the worker. Plain configs still load and are encrypted on the next save. A secret that cannot be
  read (another account, a run without the desktop app) is kept as it was, not lost or used. Without safeStorage
  (Linux without a keyring, `pnpm dev`) keys stay as before.
- Not changed: "My devices" settings sync sends cloud provider keys to the user's own Google Drive app folder, as
  before (a separate question for Roee).

## Scan 81 (2026-11-15, 0.6.249)

- Checked on the PC (0.6.248): smart auto approvals is off by default and its toggle shows at 390 px; the persona
  builder with web search wrote a full draft in about 70 s with 5 sources; nothing was saved by itself.
- Page text: numbered HTML entities (`&#x27;`) are decoded, and `&amp;` is decoded last, so `&amp;lt;` stays the
  text `&lt;` and never becomes markup. Display only.
- Performance: the persona research is at most 3 searches and 2 page reads (20 s and 30 s timeouts each).
- Notes below still hold. typecheck, lint and tests pass.

### Notes (0.6.247–0.6.248)

- Persona builder research (0.6.248): web pages are read with `web_fetch`'s rules (public addresses only, the user's
  blocked sites and safe search) and reach the writer inside `<web_notes>` as data; the result is only a draft the
  user reviews, never saved or run by itself; sources are dropped before saving.

- Smart auto approvals: only `exec` tools with a command, only in "auto-edit", never for the always-ask list or a
  tool that insists on asking; the reviewer sees the person's typed messages and the command only (no tool output, no
  attachments), so a prompt injection in a file or page cannot reach it; anything but a clear ALLOW asks the person.
  Turning it on needs a request from this computer; `change_setting` cannot touch it. A model that writes its own
  user message cannot: the asked text comes from the session's user turns only.

## Scan 80 (2026-11-15, 0.6.246)

- Checked on the PC: the feed serves only names its feed lists (`../../config.json` → 404), ranges work (206), and
  "is the computer free" answers. Notes below still hold.
- Found and fixed: Fastify's `inject` fails in the packaged app (an ES-module cookie helper), so three internal calls
  answered 500 (busy checks, starting self-work from a routine, saving a self-work routine from the phone). They call
  the route over 127.0.0.1 now (`local-call.ts`); the rules each route applies are the same (from 127.0.0.1 a call is
  local, as before with inject).
- Phone rows: text beside a button in a card keeps 180 px; CSS only.
- typecheck, lint and tests pass (597).


- Update feed (`/api/updates/feed/:file`): read-only; only a plain file name (no folders, no `..`) that the feed
  itself lists, or the feed file; behind the same token as every other route from another device. The build folder
  is set only from this computer and must hold a complete feed. Another computer's installer is run only after its
  sha512 matches the feed that computer served, as with GitHub; the trust is the device link (my own computers, same
  Google account, their token).
- Install when free: in memory only; installs only a version the normal check found; never while a chat, self-work,
  a download or another update runs.

## Scan 79 (2026-11-15, 0.6.244)

- Settings from the chat (`change_setting`): only the listed keys can change, each value is checked, and every change
  waits for an approval card showing old → new. Never from Telegram.
- Model beside (`/api/engines/beside/*`): the same allowed-folder and GGUF checks as the main load; the main model
  can't be loaded twice; the engine listens on 127.0.0.1 only, on a free port; it stops when KesherAI closes and is
  not remembered.
- Loaded now, connections as rows, the new look (Heebo, tabs, cards): display only, no new reads or writes.
- No personal paths, names or emails in the tree (one test uses a made-up `/Users/me`).
- Performance: the beside engine is made on first use; nothing loads until asked.
- typecheck, lint and tests passed at the release commit. Nothing to fix.

## Scan 78 (2026-11-15, 0.6.240)

- Side chat (`/api/conversations/:id/side`): the question is cut to 4,000 characters; it answers only for a chat that
  exists (so threads are bounded by the chats), with no tools, and never writes the chat (a test checks the events
  are unchanged). The thread is in memory, 20 turns at most per chat. Same access as sending a message (the phone
  with its token). A chat answered by an outside agent (`agent/…`) is refused.
- Model test questions (`/api/models/benchmark`): the same allowed-path and GGUF checks as before; ten fixed
  questions to the local engine only, 120 s each at most; answers are matched by pattern, nothing is stored.
- The @ menu: reads the same lists the + menu reads (knowledge, pages); a model pick goes through the chat's normal
  PATCH. The phone app's computer/phone switch links to the app's own page (its address is the app's, not a page's).
- Inbox: "Watch and approve" became a tab; the screen still needs computer control on, as before.
- Performance: the usage map is drawn from the existing `/api/usage` totals (no new reads).
- typecheck, lint and tests pass (590). Nothing to fix.

## Scan 77 (2026-11-15, 0.6.238)

- Character cards (`characterCard`, `cardFromPng`): the PNG is read in the browser and only the card's JSON is sent;
  a chunk with a wrong size ends the loop (the reads are clamped); a picture without a card says so. The card's words
  become a persona's instructions (cut to 20,000 characters, the name to 60), like any persona the user writes; the
  upload route keeps its 20 MB limit and 100 personas.
- Graph wires (`appearance.wires`): only the three styles, a radius 0–40 and two booleans pass `cleanAppearance`.
- Updates: an installer is never run without the release's sha512 (deleted instead), and a second one cannot start
  for 10 minutes; the example plugins stay off until turned on; the fault log skips answers under 500.
- Customize page, sidebar and message-box changes: interface only (no new routes).
- typecheck, lint and tests pass; `pnpm audit --prod`: no known vulnerabilities. Nothing to fix.

## Scan 76 (2026-11-15, 0.6.234)

- Chat tool groups (`chat-tool-groups.ts`, `chat-tools-games.ts`): the same tools and notes; the Telegram rule (no
  screen, browser or engine code for a chat written from Telegram) is unchanged in what it removes and now has its
  own test.
- Song covers (`songCover`): the style and title go to the active image model only, cut to 300 and 80 characters;
  no file path or user data beyond the song's own words; a failure leaves the song without a cover.
- ACE-Step 1.5 XL (`folderNames`): ComfyUI's `/models/<folder>` is asked only for the fixed folders a ready-made flow
  names (diffusion_models, text_encoders, vae), never a folder from a request. The 19.9 GB download ran only after
  Roee's yes.
- Meeting recordings: `PUT /api/journal/recordings` takes `days` only as an integer 1–3650 (else 400);
  `pruneRecordings` deletes only folders it lists inside `journal/recordings` (ids from the listing, not from a
  request), by the age of `recording.wav`; a meeting being recorded has a fresh folder and stays. Kept recordings
  were never deleted before (a privacy gap: found and fixed here, 30 days by default).
- Outside commit 150f0f86 (llama.cpp's short "Context size has been exceeded."): a wider pattern for the existing
  shorten-and-retry path, which still runs at most twice and only above 2,000 tokens of context. Nothing to fix.
- Performance: songs take ~20 s with turbo or XL on the PC, ~50 s more with a cover from Qwen-Image; recording
  cleanup reads the meetings only when something was deleted.

## Scan 75 (2026-11-15, 0.6.231)

- server.ts split B3 (ComfyUI), B7 (`server/routes.ts`) and B8 (`server/start-engines.ts`): the same calls in the same
  order. The key check for remote access (`setupRemoteAccess`) is still registered before `registerRoutes`, so it
  covers every route; the smoke test (foreign origin and `Origin: null` refused, DNS rebinding needs the token, `/mcp`
  refuses a foreign site) passes on the built server.
- Start-up routines wait while a chat works or a model loads; the engine log line carries the routine's name (the
  user's own words, shown as text in the log view, never as HTML).
- make_music with ACE-Step 1.5: the language and key are mapped to the node's own lists (anything else falls back to
  `en` / no key), the length is clamped to 10–600 s and the tempo to 40–220. Found: the style and the lyrics were not
  bounded on their way into ComfyUI and the song's saved details; now 1,000 and 8,000 characters. The 10 GB model is
  downloaded only after the user's yes (an approval card), as before.

## Scan 74 (2026-11-15, 0.6.228)

- Phone app crash capture (Android `Crashes`, `POST /api/faults/phone`): the app keeps only the error, the stack,
  the thread and the phone model and Android version (no messages, keys or addresses), and sends it only after the
  health check with the computer's key. The route is behind the key from outside like every `/api` route, and cuts
  each field (80/500/1400 characters). Found: a non-finite or out-of-range time (`at`) threw in `toISOString()` and
  answered 500; now it is ignored ("unknown time"), with a test.
- The live service's `startForeground` and every `startForegroundService` are caught: Android refusing the
  foreground service no longer closes the app (the likely cause of "the app closes on connect").
- Graph wires by finger (`pinNear`): the nearest pin within 40 px is found by a loop over the drawn pins on each
  pointer move: linear in the pins on screen (hundreds at most), no allocation beyond one array per node; the
  node-id selector is built with `CSS.escape`.
- Self-work setup moved to `server/build-extras.ts`: the same calls, the worker's upgrade and idle exit unchanged.

## Scan 73 (2026-11-15, 0.6.226)

- server.ts split B4–B6 (conversation manager, remote access, notifier, Telegram, routines moved to `server/`): no
  behaviour change. The auth hook is registered at the same point among the routes (`setupRemoteAccess`), and the
  remote tests (401 from outside, device keys, the lockout, `/s/` reachable) pass unchanged. Pieces made before the
  chats read them through a function at use time, as they did through `services` before.
- Unreal plugin 0.1.19: the version its hello sends now matches its `.uplugin` and KesherAI's latest (a test checks
  all three), so an installed plugin is not offered again. Close from KesherAI tested on the PC (UE 5.8, no dialog).
- `pnpm audit --prod --audit-level high`: clean. ui-check passes at both widths; speed 0.3 s / 8 ms / 3 ms.

## Scan 88 (2026-11-16, 0.6.267 – 0.6.274: benefits, avatar wizard and remote, warm speech models, NVIDIA speech engine)

- Avatar clips: `PUT /api/study/avatar/clip` checks the WebM header and stops at 400 MB; ranges are parsed as numbers
  and clamped to the file. Installing the camera (`POST /api/study/avatar/camera` `install`) is refused from remote;
  start and stop are allowed (they only show or hide the avatar feed). The administrator prompt is Windows' own.
- whisper-server processes listen on 127.0.0.1 only, on a random port, and are closed after 10 idle minutes and when
  KesherAI exits. `warm` only starts them for models that are already downloaded.
- NVIDIA engine upgrade: the download comes only from ggml-org/whisper.cpp's GitHub releases; the release tag is
  stripped to `[\w.-]` before it names a folder; the new folder must contain `whisper-cli.exe` and `ggml-cuda.dll`
  before the old engine is removed, and removal is limited to folders inside KesherAI's own speech engine folder.
- Student benefits are fixed text and links in the app (no network lookups, nothing sent).
- Performance: the speech engine on NVIDIA computers was the processor build (whisper.cpp renamed its CUDA download);
  fixed in the picker, with an upgrade for engines already installed.

## Scan 89 (2026-11-16, 0.6.275 – 0.6.279: course sync, hardware fit, execFile fix, phone connect crash, version watch, lecture files, exam plan, course tutor)

- Course sync (`POST /api/study/sync`, 80 MB): every course from the phone passes `cleanCourseData` (course ids
  `[a-z0-9-]{8,40}` before they become a path, other ids `[\w-]{1,80}`, texts and lists capped as on the computer,
  unknown fields dropped, FSRS state and quizzes size-capped). A traversal id is refused (tested). Deleted courses are
  kept in `_removed.json`, which can never be read as a course (its name fails the id check).
- Lecture files (`POST /api/study/extract`, 70 MB of base64): the size is checked again after decoding (50 MB); only
  the extension decides the reader (PDF, PowerPoint, Word, text, or a picture to the chat model); nothing is written
  to disk. The file name is used only for its extension and the suggested title.
- Course tutor (`POST /api/study/courses/:id/ask`): the history is cut to 6 turns, roles other than user/assistant
  and non-text content are dropped, each turn is capped at 4000 characters, the question at 2000. Lecture text can
  steer the answer (prompt injection), but the tutor has no tools: it can only write text.
- Graphics detection: the log's child-process wrapper kept `util.promisify.custom`, so every `promisify(execFile)`
  (hardware, updates, firewall, ffmpeg) reads stdout again. Found because the RTX 3090 was not detected.
- Phone app: the bridge call is answered before its message channel is replaced (the native crash when connecting);
  native crash reports are decoded on the phone (signal, cause, frames: no memory contents, no addresses beyond the
  fault address).
- Version watch: reads only `/api/version`; it never reloads during a lecture recording.
- Performance: passage search is one pass over the course's words per question (fine for hundreds of lectures);
  the exam plan is computed per course in the course list (one pass over its cards).

## Scan 90 (2026-11-16, 0.6.280 – 0.6.281: avatar look-alive layer, lip sync)

- Lip sync server (tools/lipsync): listens on 127.0.0.1 only, on a random port, and refuses a connection without
  KesherAI's per-run random token (32 hex characters, never shown to the page). The page never reaches it: frames
  come through KesherAI's own `/api/study/avatar/lipsync/stream` (the page's CSP allows only KesherAI), behind the
  usual login.
- Its install (7 GB) is refused from remote; it runs PowerShell with a script KesherAI writes itself (paths quoted
  for PowerShell, tested with an apostrophe), downloads only from GitHub (MuseTalk), PyTorch's index, OpenMMLab's
  wheel index and HuggingFace; the copied s3fd face detector is checked by its sha256 prefix before use. A failed
  native step stops the install before it is marked ready.
- The microphone is read only while the avatar camera runs with lip sync on; audio stays in memory (4 s ring), is
  never written to disk, and leaves only as frames (and, if she chose it, as her own voice into the audio device she
  named).
- Settings (on/off, microphone, cable device) are capped at 120 characters and passed as separate process
  arguments (no shell).
- Performance: on an RTX 3090 beside the chat model, 25 fps with the card making the next step while threads blend
  and encode the last; the server stops with the camera and gives the card back.

## Scan 91 (2026-11-16, 0.6.288 – 0.6.290: phone menu and connect screen, name and form of address, files on the phone)

- Name and form of address: the computer keeps the name without control characters or `<`/`>` (60 characters at
  most) and the address only as f, m or p (anything else is refused). The phone does the same before storing; both
  put the name only into text (never HTML). The phone takes the computer's setting when it connects (behind the
  usual token); a bad address from the computer is ignored by the phone's converter. The models get the name in their
  instructions: she can only steer her own chat with it.
- Hebrew converter on the phone: the same shared code as the computer, bundled; it changes only whole words from a
  fixed list.
- Files read on the phone (slides, Word, PDF): the zip reader keeps the computer's limits (64 MB unpacked in total,
  4000 entries, never more than an entry claims, unpacked by the browser's own DecompressionStream and stopped at
  the limit). PDFs go through unpdf (pdf.js 6.4, past the 2024 font-code bug) with eval turned off. Files never
  leave the phone. The 1.7 MB reader loads only when a file is chosen.
- Photos with no computer go only to the model she chose (on the phone, or the internet model she set up herself),
  shrunk to 1600 px.
- Remote search: Back closes it through a history entry that is removed when it closes some other way.
- Performance: the menu builds once per page; the converter's regular expression is built once per form.

## Scan 92 (2026-11-16, 0.6.292 – 0.6.300: phone menu and chat screens, study grading, phone chat to the computer)

- Phone chat to the computer (`POST /api/import/phone-chat`): behind the usual login (the phone's token); only
  user/assistant text is kept, at most 200 messages of 20000 characters, the title cut to 120, an 8 MB body limit.
  It is stored like any imported chat (no model runs until she writes); the id is a hash of the phone's chat id and
  length, so the same chat sent twice opens the same copy. The phone opens the computer only at `#/c/<id>` (checked
  against a strict pattern before use).
- Phone chat list: titles, model names and renames are put in as text (never HTML); a rename is cut to 80
  characters; deleting asks first and removes only that chat's own stored messages.
- "From Study" in the + sheet attaches a lecture's summary or text that is already on the phone (12000 characters
  at most); nothing leaves the phone unless she sends the message.
- Study mode grading: the model's verdict is read as JSON and only "right", "partly" or "wrong" is accepted; the
  verdict line is KesherAI's own text. The script cleaner is one character-class pass (no backtracking).
- Bottom bar press-and-slide: the click the browser makes is replaced only for trusted pointer clicks; keyboard
  activation still works.
- Performance: the chat list is drawn from the phone's stored list (100 chats at most) on each search keystroke;
  the menu panel's position is measured on open and on resize only.

## Scan 93 (2026-11-16, 0.6.301 – 0.6.304: focus timer, homework help, "explain this", live translation)

- Focus sessions (`POST /api/study/courses/:id/focus`): minutes clamped to 1–600, 5000 sessions per course at most;
  from the phone they pass the same course cleaning as the rest of a sync (numbers only).
- The phone's "time's up" alarm: a receiver that is not exported, an immutable pending intent, title and text cut
  to 120 and 300 characters; an inexact alarm, so no special alarm permission is asked for.
- Homework help, "explain this" and live translation only add prompts: the selection is cut to 3000 characters,
  a translated piece to 4000, the homework exercise to 3000 in each turn; none has tools, and their answers are
  shown as text. Other scripts are removed from Hebrew answers.
- Live translation runs beside the transcript (not awaited), so a slow model never holds the recording.
- Performance: the streak looks back at most ten years of days once per Study page load; the week is one pass over
  the focus sessions.
- Found on the PC (not a code issue): after a restart the 80B chat model, with its experts in system memory and the
  file mapped from disk, processed prompts at under 1 token a second until warm. Left as is: loading it fully into
  memory instead needs the RAM to hold it; to be measured with Roee.

## Scan 94 (2026-11-16, 0.6.305 – 0.6.310: Anki, course summary, search across courses, notes, open and case quizzes)

- Anki import (`POST /api/study/courses/:id/cards/import`): the file is read as text only, tab-separated; fronts and
  backs are cut like any card, duplicates skipped. The export is plain text with a sanitized file name.
- Course summary (`POST /api/study/courses/:id/summary`): built only from her lectures' own summaries; at most 50000
  characters sent per step and 120000 kept; it is shown through RichText (React text, no HTML) on the computer and as
  text on the phone. A phone sync passes it through the same cleaning (a string, ids checked).
- Search across courses (`GET /api/study/search?q=`): the query is cut to 200 characters and matched by plain
  substring (no regular expression from her text); at most 40 hits; courses come from the in-memory cache, so a
  keystroke (debounced) does not read every file again.
- Her notes (`PATCH …/lectures/:lid` `{ notes }`): cut to 50000 characters, kept with their time so a sync keeps the
  newer notes; shown as text.
- Open and case quizzes: questions need a model answer of 4–1200 characters; at most 30 written answers of 3000
  characters each, a 1 MB body limit, and the grade line is KesherAI's own text built from a verdict of
  "right", "partly" or "wrong" only. The model has no tools in any of these steps.
- Performance: the open quiz is graded one answer at a time (one short prompt each, about 4000 characters of passages),
  so a 10-question quiz is 10 small turns, not one long one.

## Scan 95 (2026-11-16, 0.6.310 – 0.6.312: field tools, page citations, Commons pictures, slide photos, computer chats on the phone, "continue on the phone", the live call, Android links)

- Field tools (`POST /api/study/courses/:id/tools/:tool`): only the fixed tool list (an unknown id is 404); pasted text
  cut to 40000 characters, a 1 MB body limit; no tools for the model; the answer is shown as text (RichText, no HTML).
  The clinical tools tell the model to drop names and ID numbers ([הוסר]) and say they are practice only.
- Wikimedia pictures: the search address is fixed (commons.wikimedia.org); only scaled copies on upload.wikimedia.org
  over HTTPS are kept, never SVG itself (Commons' PNG copy); on the computer they are fetched by the server with
  `redirect: "error"`, a 1 MB limit and the bytes checked as PNG, JPEG or WebP, then sent as data: copies, so the page's
  image policy stays `'self' data:`. Credits are plain text with the HTML stripped; the link to the file page must be
  on commons.wikimedia.org.
- Slide photos during a recording go through the same `/api/study/extract` as any photo (50 MB limit, vision model
  without tools); the text is cut to 6000 characters per slide.
- The computer's chats on the phone: read with the paired computer's own token; ids must match a strict pattern and
  titles are put in as text; opening one goes through the start screen's `?open=` check (`#/c/<id>` only).
- "Continue on the phone": `GET /api/conversations/:id/handoff` gives text only (12 messages, 12000 characters), behind
  the same token as every route; the phone page reads the address once, keeps only user and assistant turns of text,
  and removes the address from the history. It never runs a model by itself.
- Android: a link on a paired computer's page to another site now opens in the phone's browser (it used to load
  inside the app, since the app allows any address to reach the user's computer); the app's own pages still open the
  computer. The native bridge stays limited to the paired computers' exact origins, main frame only. One WebView
  client now does the isolation headers, the renderer-crash handling and the links (two plugins each set one, and
  only the last set is kept).
- Updates now also wait for Study work running on the model.
- Model JSON with Hebrew abbreviations is repaired by one regular expression without backtracking (a quote between
  two Hebrew letters).
- Performance: the phone's home screen no longer waits for its model engine (374 KB): about 0.6 s instead of 1.4 s on a
  six-times-slower processor. The interface check now also runs at 360 px. The computer's chat list on the phone is
  read at most once a minute.

## Scan 96 (2026-11-16, after 0.6.311: Commons animations and videos, game development field, "the lecture is ready", recording with the screen off, the phone widget, the side menu)

- Commons animations and videos: GIFs are fetched by the computer with `redirect: "error"`, 3 MB at most, and must
  start with `GIF8`; a video's file must be a WebM or Ogg on upload.wikimedia.org over HTTPS (checked in
  parseCommonsPictures). On the computer a video is a link to its Commons page (the page plays nothing from another
  site); on the phone it plays from upload.wikimedia.org with `crossorigin="anonymous"` (the app's pages are
  cross-origin isolated, so nothing loads there without CORS).
- "The lecture is ready": the computer summarizes only lectures that are new from the phone, have no summary and
  more than 200 characters, one at a time, with a chat model already chosen; the notification carries the course and
  lecture titles (her own) and a `#/study/...` path. The summary goes through the same `ask` (no tools).
- Recording with the screen off: a foreground service of type microphone, started only by her tap in the app (Android
  requires that), with its own ongoing notification; the service is not exported. The sound stays in the app's own
  files folder as 30-second WAV pieces, read back only by name (`piece-0000.wav` pattern, no paths) and removed
  after the lecture is saved. Nothing is sent anywhere.
- The widget's buttons open fixed phone screens through a separate channel (`#/phone/...` paths go only to the
  phone's own pages; the computer's interface maps them to the phone app's home address, never to a page a path names).
- Field hints are one shared list; game development adds no tool with more reach (text in, text out).
- Found by CI, fixed: the command used on this side for typechecking (`pnpm -s -r typecheck`) skipped the web app;
  the root `pnpm typecheck` is used now.
- Performance: the side menu's edge scrolling runs one animation frame loop only while a finger or mouse is held.

## Scan 97 (2026-11-17, night): models move, computer tabs, journal OCR, study pictures, course models, kept recordings
- **Kept recordings** (`/api/study/courses/:id/lectures/:lid/recording`): behind the same sign-in as every route; the course id must match `[\w-]{1,80}` and the lecture must exist before a path is built (the lecture id is stripped to `[\w-]`), so no path escapes `study/recordings/<course>/`; only audio types are taken (WebM, Ogg, MP4, MPEG, WAV), 1 KB–400 MB, written to a temp file and renamed. Range reads are parsed strictly (`bytes=a-b`), out-of-range answers 416. Deleting a lecture or a course deletes its audio. Automatic deletion only removes kept audio, never transcripts.
- The token in the phone's player URL (`?token=`) goes only to the paired computer; the request log strips the query (checked: `req.url.split("?")[0]`).
- The audio parsers (400 MB) are global: a signed-in client could send a large audio body to any route. Accepted (signed-in only, buffered once); noted for a streaming upload later.
- **Course models**: a course's model id is checked (`provider/name`), and the file loaded comes only from the scanned model folders (never a path from the request). "Switch now" only stops the waiting.
- **Journal OCR**: a failed read in the Tesseract worker no longer throws outside a promise (it was logged as an uncaught error just before the 22:29 exit; that exit itself came from outside the app).
- **Computer tabs**: open other computers only through the desktop bridge's existing `openDevice` / `openComputer` (same checks as the hub).
- Performance: the model scan for course models is cached 5 minutes; the wait for a free engine checks every 3 s only while a course waits; the recorder keeps Opus at 24 kb/s (~20 MB per 90 minutes) instead of WAV (~170 MB).

## Scan 98 (2026-11-17, night): guiding questions, Godot, phone computer tabs, limits suggestion, engine API guides, WSL, Films for you
- **Godot bridge**: the editor connects to `/api/godot/ws` from this computer only (`isLocalRequest`), like Unreal's. Its file commands work only under `res://` and refuse `..` (checked in a real Godot 4.7.2 editor: a write to `res://../escape.gd` is refused). Every scene change goes through the editor's undo history. Connecting a project only writes `addons/kesher_bridge/` and one `project.godot` line; `/api/godot/connect` is local only; the editor started is a Godot found in KesherAI's engines folder or common install places (never a path from the request).
- **Godot download**: the 4.7.2 Windows editors were checked against the release's SHA512-SUMS before unpacking.
- **Films for you (Stremio)**: the addon routes (`/stremio/<key>/…`) need one of KesherAI's revocable app keys in the address (Stremio cannot send headers); they answer only the manifest and the picks. The key is cut out of the desktop log (`/stremio/…`) and the access log keeps no such path. Posters come through KesherAI only for stored picks and only from Cinemeta's image hosts, no redirects, images up to 2 MB. Only titles go to Cinemeta's search.
- **Guiding questions**: ask_user's questions are checked (1–4, 2–4 options, lengths cut) before they reach the card; the answer is plain text.
- **WSL**: a project at `\\wsl.localhost\<distro>\…` runs commands with `wsl.exe -d <distro> --cd <dir> -- bash -lc <command>` (arguments, not a shell line built from the path); the same approval rules as any command.
- **Phone computer tabs**: open a saved computer by its index in the phone's own list (`index.html?use=N`, digits only).
- Performance: the Godot tools add ~1 k tokens only where Godot is installed or connected; the course-model scan is cached; the Stremio refresh is one model call plus up to 30 small searches.

## Scan 99 (2026-11-17, night): Minecraft/Roblox, a voice of her own, depth frames, unattended self-work, UEFN
- **Mods**: `mod_new` clones only the two official templates (fixed URLs) into a new folder that must not exist; `mod_build` is an `exec` tool (asks like any command), runs `gradlew` with KesherAI's JDK, `rojo` from KesherAI's engines folder, or zips the two packs; arguments as lists, no shell line from input (the .mcaddon path goes through an environment variable to PowerShell). The JDK zip was checked against Adoptium's SHA-256 before unpacking; Rojo came from its GitHub release.
- **Voice**: a clip is kept only with the consent tick, only as a RIFF WAV of 5 s–2 min, under a name of letters, digits, spaces, `_` and `-` (no path); speaking checks the voice name the same way and the language against the list; text is passed to Python as one JSON argument, not a command line. Voices stay in engines/chatterbox/voices on this computer.
- **Depth frames**: a ready flow of ComfyUI's own nodes and two ControlNet files from comfyanonymous' HF repo; nothing new runs.
- **Unattended self-work**: ask_user and request_access no longer wait in a self-work session; folders outside the project are refused there (stricter than before).
- **UEFN**: writes only `.verse` files inside a UEFN project's Content folder (checked with `relative()`; `../` refused, tested).
- Performance: the mod and UEFN tools add ~300 tokens; UEFN's only when its projects folder exists.

## Scan 100 (2026-11-17, 05:10): the five changes after 0.6.316
- **Films for you at 390 px, course model names**: display only; no new input or route.
- **Voice engine fix**: one more pinned package (`setuptools<81`) from PyPI into the voice engine's own Python, so the audio watermark (Perth, marks speech as made by AI) loads again; it is kept on, not bypassed. A marker file stops it running twice.
- **MCP "has its own view" tag; Knowledge base size**: the tag reads `_meta.ui.resourceUri` the server already sends (shown only, never opened from the list); the size is two `stat` calls on KesherAI's own index files per base, inside the list call (cheap: no reads).
- **Lip sync microphones**: names come from Windows' audio list (WASAPI) and are matched back to a device by prefix; the name is only compared, never run. Self-work's version of this task was not taken: it also added an `open any path` route and a desktop zoom hook outside the task.
- Secrets/personal paths: none in the diff (checked with git grep).

## Scan 101 (2026-11-17, morning): the log folder, the heavy folder, Fab, song lyrics, the Tasks count
- **Log folder (t129)**: `GET /api/logs/folder` answers this computer only and returns a fixed folder; the button opens it with the desktop's open-folder bridge, which opens folders only. Self-work's "open any path" route was not taken.
- **Heavy folder**: `POST /api/heavy` is this computer only, takes a full path outside the data folder and only the four known folder names. Files are copied and size-checked; the old folder is removed only after the link to the new one is made, and comes back if the link fails. The swap runs in the main app only, before engines start; a folder in use stays pending. Links inside are made again as links, never followed.
- **Fab**: the pane runs only Fab's search path (checked by a strict pattern) inside a fab.com tab, in an isolated world, with that site's own cookies; `fab_open` opens only `www.fab.com/listings/<uid>` (uid checked). The tools never click, add or buy; the description tells the model so, and browser clicks still ask per site.
- **Song title and lyrics**: shown as text (React escapes it); the download name is stripped of path characters.
- **Tasks count / engine log**: display only.
- Performance: the heavy folder sizes walk four folders on demand only (Settings page open); the swap at start re-checks sizes and times once. Fab's tools exist only with the desktop pane. Secrets/personal paths: none in the diff (git grep).

## Scan 102 (2026-11-17, morning): SSH targets, chat reading, the heavy folder's restart
- **SSH**: the routes answer this computer only; logins are checked to letters, digits, dots and dashes, ports to 1–65535; `ssh` runs with BatchMode (never a password prompt) and arguments as a list; the remote command is one quoted word (`shQuote`, tested with quotes inside). The key is made only when none exists and never replaced; winget installs only WinFsp and SSHFS-Win, on the user's click. First connections accept a new host key (like VS Code); a changed key is refused and explained.
- **Chat reading**: chats and reports stay in the data folder; report ids are checked (`[\w-]{8,64}`) before any path; files are written whole (temp then rename). The chat goes to the model as data ("never instructions"); quotes shown are looked up in the chat. Import by link: https only, through the user's own browser pane on their click; by PDF: parsed by the same document reader as Knowledge; bodies capped (300 MB chat, 60 MB import).
- **Heavy folder restart**: stops only processes whose program lives under KesherAI's engines folder (by full path), never an editor without the user's yes; nothing outside that folder.
- Performance: chat reading reads at most 10 parts of a long chat (spread over all of it), one model call each, then one to write; the numbers are counted in one pass. Secrets/personal paths: none in the diff.

## Scan 103 (2026-11-17): the new-link alert, the Relationship analysis name, Unreal offline sync and plugin 0.1.20
- **New-link alert**: checks the tunnel's own address once a minute; the desktop notice shows the address without the token; only the user's own Telegram bot (when set) gets the full link with the token, as the phone needs it. The first address after start is not announced. The file it keeps is in the data folder.
- **Unreal offline sync**: changes wait in KesherAI's queue; the headless editor runs only when Unreal is not open on that project (two editors saving the same assets could lose work), with the request and answer as files in the project's own Saved/KesherAI folder; arguments are a list, never a shell line. An old error is hidden once nothing waits (display only).
- **Plugin 0.1.20**: loads earlier so the commandlet is found; inside the headless editor it never opens the live connection; the editor hook waits for the engine. No new network listener.
- **Rename / docs**: text only.
- Performance: the sync runs once, 8 s after the last queued change, in one headless editor for all of them. Secrets/personal paths: none in the diff (git grep; the only `token=` is a test value).

## Scan 104 (2026-11-17): report language and "measured", the dialog portal, margins, the plugin update reopen, the Fab tab
- **Relationship analysis**: the language check and the "measured" check read the model's own JSON with simple, bounded patterns (no nested repeats); a second model call happens at most once per report. The "mixed alphabets" note is shown as text.
- **New project dialog**: moved to `document.body` with a portal; the same form, nothing new reaches the server.
- **Plugin update**: Unreal is opened again only when it was open before; no new process is started otherwise.
- **Fab tab**: only the tab KesherAI opened for the search is closed (by its id), never a tab the user opened.
- Performance: the language check is one pass over the report's text; the Fab timer is one per pane. Secrets/personal paths: none in the diff (git grep).

## Scan 105 (2026-11-17): the richer answer, "+" reading every file, the translator, KaTeX/Mermaid, artifacts
- **Fixed: pictures from other sites in an answer** waited for nothing: an address the model wrote (after reading a page that told it to) could carry data out to that site when the picture loads (the known Markdown-image leak). Now only KesherAI's own pictures show at once; another site's picture shows its host and loads on a tap, with no referrer.
- **Artifacts**: the frame is sandboxed without same-origin (no KesherAI API, files, key or cookies), with a content policy blocking every request (`default-src 'none'`, `form-action 'none'`); a meta refresh is removed. What is left: a page script can still move its own frame to another address; it can only carry what the model wrote into the page, which the user sees anyway.
- **KaTeX / Mermaid**: their own output only (KaTeX's safe defaults, no `\href`; Mermaid with `securityLevel: "strict"`, sanitized labels). Loaded only when an answer has math or a diagram.
- **Link cards**: nothing is fetched from the linked site.
- **"+" files**: recordings, videos and code are read only inside the chat's folders (the same check as documents); ffmpeg and whisper get the path as an argument list; frames and transcripts stay on this computer unless the user chose a cloud speech service.
- **Translator**: the answer's prose only; code, inline code and links leave as markers and must come back unchanged, or the original answer stays.
- Performance: KaTeX and Mermaid are their own chunks; the translator runs only when the final answer is in another language or mixes alphabets (one extra model call). Secrets/personal paths: none in the diff.

## Scan 106 (2026-11-17): the design canvas, the translated chip, Moodle, My week, the KaTeX version
- **Moodle**: everything runs in KesherAI's own browser pane with her own sign-in (KesherAI never sees or types a password). The address is checked (https, a host and a plain path); the pane only calls Moodle's AJAX service with three read methods (enrolled courses, the timeline of what is due, site info) and refuses any other; it GETs only `course/view.php?id=<n>` and files under `mod/resource/view.php` or `pluginfile.php` on that same Moodle; nothing is posted to Moodle except the read-method call itself. Files are capped at 60 MB and only PDF, slides, Word and text become lectures; each file is remembered so it is brought in once.
- **My week**: dates and minutes from the model are checked and clamped before they are kept; calendar events are written only on her click, to her primary calendar, with no guests or emails.
- **Design canvas**: screens run in the same sandbox as artifacts (no same-origin, a content policy with no network); comments stay in this browser; "ask for a change" sends a chat message, nothing else.
- **KaTeX**: back on the patched version the repository's overrides require (^0.18.2); the release had failed on the lockfile.
- Performance: Moodle and plans are read on her click or when Study opens; the plan file drops plans two weeks after their due day. Secrets/personal paths: none in the diff.

## Scan 107 (2026-11-17): video overview, media in previews, "Open live" for files, the ↓ button, per-file undo
- **Per-file undo**: the path from the page is only compared with the run's own kept files (never used to open or write anything else); a file changed since asks first, as Undo all does.
- **Open live for a written file**: fetched through the chat's existing file route (inside the chat's folders, with its key) and shown in the artifact sandbox (no same-origin, no network).
- **Video overview**: slides are the model's text, checked and shown as text; pictures come from the existing Wikimedia Commons search with author and licence; nothing new is fetched.
- **Media previews**: the chat's existing download route as the player's source; no new route.
- **↓ button, list numbers, dedent**: display only.
- Performance: the ↓ state changes only when crossing 400 px from the end. Secrets/personal paths: none in the diff.

## Scan 108 (2026-11-17): run review, follow the agent, Hebrew overviews, YouTube lectures, teach-back
- **Fixed: yt-dlp** is a program downloaded the first time she adds a YouTube lecture; it was run without a check. Now it is compared with yt-dlp's own published SHA-256 list (SHA2-256SUMS of the same release) before it ever runs, and removed when it does not match. The video is named only by its 11-character id (checked), the address is rebuilt from it, and yt-dlp gets its arguments as a list; captions and sound go to a temporary folder that is removed afterwards.
- **Run review**: diffs come only from the run's own kept files (read as they are now); capped at 400 KB in all.
- **Follow the agent**: opens files already in the chat's file list in the editor; nothing new is read.
- **Teach-back**: the model's answer is parsed, clamped and shown as text; cards are added through the existing card route on her click.
- Performance: YouTube fetches captions only (no video) unless there are none; the review loads on its button. Secrets/personal paths: none in the diff.

## Scan 109 (2026-11-17): video lectures (MP4 upload, Panopto/Kaltura through her sign-in), the picture proxy, YouTube in the content policy
- **Her sign-in cookies for a video site**: taken from KesherAI's own browser profile only on her click on "Lecture from a link", only for that link's site (its host and its registrable domain, where universities keep the sign-in), https only; written to a temporary file readable only by her user (0600), handed to yt-dlp, and the folder removed right after. Never sent anywhere else, never kept. A YouTube link never takes cookies.
- **MP4 upload**: streamed to a temporary folder (cap 6 GB, nothing held in memory), transcribed, then moved into the course's own folder; the file name is cleaned of path characters. The kept video is served with byte ranges from that folder only; a removed lecture removes its video.
- **Picture proxy** (`/api/web/image`): https only, no user/password in the address, every resolved address checked against this computer and private networks (IPv4 and IPv6, incl. CGNAT and mapped addresses), no redirects, image types only, 10 MB cap, no cookies or referrer. Used only after her tap.
- **Content policy**: frames may now load `https://www.youtube-nocookie.com` only (YouTube's privacy-enhanced player, controlled by postMessage with its origin checked); everything else unchanged.
- **Chapters**: the model's times and questions are checked (in order, inside the video, 3–4 options with a valid answer) and shown as text.
- Performance: chapters are made once on her click and kept; the video plays from disk with ranges. Secrets/personal paths: none in the diff.

## Scan 110 (2026-11-17): function graphs, mastery, save to course, video upload without a size cap
- **```graph blocks**: a model's text, so untrusted. Expressions are tokenised and parsed into closures over a fixed list of math functions and constants; no `eval`, `Function`, or property access, so a block can only compute numbers (tests: `alert(1)`, `constructor`, `process.exit` are refused). At most 8 functions, drawn as SVG paths with coordinates clamped; the wheel handler is on the graph only.
- **Save to course**: the extension posts the page to the KesherAI page in its own side panel only (exact origin), and the app takes it only from its parent when that is a chrome-extension:/moz-extension: page, as "Ask about this page" does. The route caps the body at 1 MB and the text at 200 KB; the source address is kept only when http(s) (a `javascript:` link is dropped) and is shown as a link with noopener. `/api/browser/pane/page` reads only the tab in front, behind the app's token like the other pane routes.
- **Video upload without a size cap** (Roee's choice): still streamed, never in memory; written inside the course's folder (keeping it is a rename, no second copy); stops with 507 when the disk would keep under 2 GB free (checked every 256 MB); folders of cut-off uploads older than a day are removed. The route needs the app's token, so only she can fill her disk. Web videos now come at their best quality (no 720p cap).
- **Mastery**: computed from her own reviews and quizzes on this computer; nothing sent.
- Result: no open issues.

## Scan 111 (2026-11-17): daily goal and reminders, first visit and simple mode, "hard to start", read-along, Open mind fixes
- **Reminders**: built on this computer from her own study data; at most one a day; the text names only counts and the next course/lecture title. With "to the phone" off the note carries `computerOnly`, so neither the phone app nor ntfy gets it (checked in notify.ts: both paths skip it).
- **Goal, prefs and activity routes**: behind the app's token like the rest of Study; only booleans, small numbers (capped: 600 minutes, 2,000 cards, 50 of the others) and an "HH:MM" time are kept; unknown goal kinds are dropped. `POST /api/study/activity/video` only adds one "video" entry (the log keeps the last 20,000), so the worst a misuse does is count a video.
- **Read-along**: sentences are rendered as text nodes (no HTML), the speech engine is the existing one.
- **"Hard to start"**: writes only the focus timer's own local key; no request.
- **Open mind**: the language retry and the stricter "tried before" filter change prompts and filtering only; transcripts stay data in the prompt ("never instructions").
- Result: no open issues.

## Scan 112 (2026-11-17): focus sounds, buddy and energy; My mistakes, path, 5-minute lesson; celebrations, week card, adaptive quizzes, badges; oral practice
- **Focus sounds and celebrations**: Web Audio made in the page (noise buffers, oscillators); nothing fetched or downloaded; a mute switch per device; no confetti with reduced motion.
- **Energy**: `PUT /api/study/energy` takes only "high", "ok" or "low" for today; the file keeps 400 days, nothing else.
- **My mistakes / quick lesson / week / badges**: read-only routes over her own course files; the quick lesson's card ratings go through the existing review route. Nothing new is sent off the computer.
- **Adaptive level**: "auto" is mapped on the server to easy/normal/hard from her mastery; any other value is ignored as before.
- **Oral practice**: speech in through the existing Mic (transcribed on this computer or her chosen speech service, as everywhere), questions out through the existing speech; answers go to the tutor exactly like typed ones, with her lectures as data.
- **Read-along on lecture text**: shown as plain text (React text nodes), never HTML.
- Result: no open issues.

## Scan 113 (2026-11-17): model deletion of split models, the translator beside the main model, slides as PDF/PPTX, writing coach, comparison and mind map tools, the optional path
- **Deleting a split model**: the parts are found only in the same folder as the chosen file, by its exact name pattern and part count (a model with a similar name and another count is not touched), and the route still accepts only files inside KesherAI's models folder; the loaded model (any of its parts) is refused.
- **Translator beside the main model**: only a GGUF path the user chose in Settings is loaded, through the existing beside engine (its own port and key, never exposed); a model id is used as before.
- **Slides**: the PPTX is built in the page from the slides' text with every value XML-escaped and control characters dropped; the PDF is a print of an HTML page built with every text escaped, in a sandbox-free but script-free srcdoc frame (no script in it), removed after printing.
- **Writing coach**: her text goes to her chosen model only; the answer's comments are kept only when the quote is really in her text; the page shows them as text nodes. Her draft is kept in this device's local storage only.
- **Comparison and mind map**: the same tool route as the field tools (her lectures as data); the mind map renders through Mermaid in strict security mode.
- **Path toggle**: one more boolean in the Study preferences.
- Result: no open issues.

## Scan 114 (2026-11-17): KesherAI's slides and documents, the older Pages merged into documents
- **Stores**: decks and documents are one JSON file each under the data folder, named by an id checked against `^[\w-]{1,80}$` (no path from the request); writes go through a temporary file and a rename, mode 0600, under one write lock; a save carries the revision it started from and an older one is refused (409), so the page never overwrites the model's edit unseen.
- **Size**: a document is at most 2 MB, a deck 20 MB with pictures only from https or a `data:image/(png|jpeg|webp|gif)` URL; the routes' body limits match.
- **Live updates**: the SSE stream sends only revision numbers; the page loads the document itself.
- **The chats' tools**: "slides" and "document" act on the chat's own file, or on one the user named by id (the "✨ ask" box sends the open file's id). **Found and fixed**: before this, "✨ ask" on a file not tied to a chat made the new chat edit its own copy, not the open file; the tools now take the id, and refuse an unknown one.
- **Writing buttons**: the selected text goes to her chosen chat model only (the same prompt as Pages had); the answer replaces the selection in the editor, as text.
- **Print to PDF**: **found and fixed**: the print copy (documents and slides) is now a sandboxed frame (`allow-same-origin allow-modals`, no scripts) — the document's HTML is hers or the model's, rendered by RichText, but no script can run in the copy either way.
- **Copy for Word / Google Docs**: puts the rendered HTML and the Markdown on the clipboard on her click only.
- **Pages → documents**: each old page is read from her pages folder once (ids checked, a broken file skipped) and written as a document with the same id; the old files stay.
- Result: two found and fixed, no open issues.

## Scan 115 (2026-11-17): mock exam, grades, timetable, fill-in-the-blank cards and confidence
- **Mock exam**: a quiz request's `mock` is kept only with a group id matching `^[\w-]{4,40}$` and minutes clamped to 5–300; the number of questions stays capped (60); grading is the existing code (multiple choice) and grader (open answers).
- **Grades**: `PUT /api/study/grades` (512 KB limit) is cleaned field by field (at most 200 courses of 10 parts, numbers clamped to their range, text trimmed) and written mode 0600; nothing leaves the computer.
- **Timetable**: cleaned the same way (at most 80 classes, HH:MM times, the end after the start); classes of a course she does not have are dropped; the reminder's "already sent" key is kept by the server, not taken from the page. The note goes through the existing notifier (computer only unless she turns on the phone) and links to her own course page.
- **"Record the class" link**: `?record=1` only opens the recorder in that course; recording still starts on her click and the microphone permission prompt, as before.
- **Fill-in-the-blank cards**: the same card route with one more boolean; model output kept only when the front has a blank and does not contain the answer.
- **Confidence**: one optional boolean on a review.
- Result: no open issues.

## Scan 116 (2026-11-17): reading with highlights, the one-page sheet, questions during a recording
- **Highlights**: `PUT …/lectures/:lid/highlights` (2 MB limit) is cleaned (at most 300, text and note trimmed, page a positive integer, ids checked) into her own course file; the phone sync's cleaner keeps them the same way (and a review's confidence). Cards from highlights go to her chosen model with the highlights and the lecture as data; each highlight is marked once.
- **The sheet**: built in the page from her summary, terms and diagram as React text nodes (the diagram through the existing parser, never HTML); "PDF" is the browser's print of the page with only the sheet visible. No model call, nothing sent.
- **Questions during a recording**: the question (600 characters) and the transcript so far (the last 30,000 characters, 1 MB body limit) go to her chosen model with an instruction to answer from the transcript only; the answer is shown as text.
- Result: no open issues.

## Scan 117 (2026-11-17): KesherAI's own sheets
- **Formulas**: parsed by our own tokenizer and recursive parser into a tree and computed by a fixed table of functions; anything else (unknown names, `;`, property access, calls on values) is a parse error shown as `#ERR`; nothing is ever passed to `eval`, `Function` or a worker. Cycles are caught (`#CYCLE`), recursion is bounded by the cell count.
- **Store**: one JSON file per sheet, id checked, written through a temporary file and a rename, mode 0600, under a write lock; saves carry the revision they started at (409 otherwise); at most 50,000 cells of 2,000 characters, 52 columns and 2,000 rows; addresses outside the grid are dropped; versions keep their own copy of the cells.
- **CSV in**: parsed in our own code from text (6 MB), into cells as typed text — a CSV cell that starts with "=" becomes a formula in KesherAI only (computed by the same safe engine). **CSV out**: values, quoted; **found and fixed**: text that Excel would read as a formula (starting with = + - @) gets a leading apostrophe (CSV injection); numbers stay numbers.
- **The chat's "sheet" tool**: acts on the chat's own sheet or one the user named by id (unknown ids refused), cells cleaned the same way.
- Result: one found and fixed, no open issues.

## Scan 118 (2026-11-17): importing Office files, Word and Excel out
- **Import** (`POST /api/import`, 45 MB body, 30 MB file): the file's type is taken from its name's extension and only .docx .pdf .md .txt .pptx .xlsx .csv are read, by the existing readers (unpdf; our own zip reader for Office XML, reading text only — no macros, no external links, no embedded objects are followed); only the text is kept, as a new document, deck or sheet (with the stores' own caps); the file itself is not written to disk.
- **Word / Excel out**: built in the page from her own text; every value XML-escaped and control characters dropped; sheet names stripped of characters Excel refuses; a formula goes out as its text with its computed value (Excel recomputes).
- Result: no open issues.

## Scan 119 (2026-11-17): screen lens, Windows file replace retries
- **Capture**: `POST /api/lens/capture` answers only requests from this computer (the key's handler); the phone sends its own picture to `/api/lens/shot`. Pictures are PNG only (checked by signature, 20 MB), kept in memory (at most five, ten minutes), never written to disk except a marked part she sends on to a chat (into that chat's own folder).
- **The lens window**: frameless over the primary display, same sandbox, preload and navigation lock as the text helper; its IPC (`kesher:lens`) answers only that window and opens only a `#/c/<id>` chat (checked by pattern, set as text).
- **Actions**: the marked part goes to her chosen chat model; Windows OCR runs PowerShell with a fixed script (the file path passed in an environment variable, never in the command), a 20-second limit, the temporary folder removed after.
- **Replace retries**: a busy file (EPERM/EBUSY) is tried again at most 20 times with a growing wait, then the error stands.
- Result: no open issues.

## Scan 120 (2026-11-17): security and performance after the lens follow-ups
- **Extension lens**: the region layer is injected into the active tab only on her click, removes itself on finish or Esc, and sends nothing; the cut picture goes only to the KesherAI page in the panel (postMessage to its exact origin), which accepts it only from the extension parent.
- **Translation over the picture**: OCR text goes to her chat model as numbered lines; the answer is used only as text (React text nodes), counted against the lines.
- **Several screens**: the desktop captures the display under the cursor and posts it to the local server; the lens window is placed on that display.
- **Phone share into the lens**: asks first; the shared file is removed from the phone's cache either way.
- **Lens window → main window**: only a `#/c/<id>` hash, checked, set as text.
- **Performance, fixed**: the lens keeps three pictures at most (a 4K PNG is 10–20 MB); a sheet draws 200 rows at a time (an imported 2,000-row CSV was 100,000 cells at once); the vision answer stops at 6,000 characters.
- Result: no open issues.

## Scan 121 (2026-11-17): MyAnimeList in Films for you, the lens without a Hebrew OCR pack
- **MyAnimeList by name**: the user name is checked (`^[\w-]{2,32}$`) before it goes into the address; her Client ID (hex, 20–64) is kept in KesherAI's own stremio.json (mode 0600), sent only as MyAnimeList's header; only `https://api.myanimelist.net/v2/` "next" pages are followed (at most 10); answers are read as data (titles, scores) only.
- **MyAnimeList export**: parsed in our own code from text (30 MB body limit), titles trimmed; the .gz is opened in the page.
- **Lens**: a missing OCR language is reported as a fixed word, never as raw command output.
- Result: no open issues.

## Scan 122 (2026-11-17): listening controls, slides, image occlusion, players' speed, live quiz, time notes, studying together, papers
- **Live quiz and focus room (public pages)**: `/q/<token>` and `/f/<token>` are outside /api, so the token is the key: 128 random bits (raised from 72 in this scan), checked against `^[\w-]{8,40}$` before any lookup, so it is safe inside the page's script. Rooms live in memory only (at most 5 of each; 3 hours for a quiz, 12 for a focus room), players at most 60 / members 40, names and tasks stripped of control characters and `<>` and cut short, join bodies 2 KB. The pages run only their own nonce'd script (CSP `default-src 'none'`, `connect-src 'self'`, `frame-ancestors 'none'`, no-referrer, noindex, no-store) and put every name, question and option in through an escaper. A quiz's answer is never sent before the host reveals it; an answer counts once, only for the question showing and only in time. Opening, moving on and closing a room are under /api with her key.
- **Time notes**: kept in the lecture's highlights (at most 300, 2 MB body), a moment only as a whole number of seconds under a day; the course's notes list is read-only and its links are built from ids.
- **Study group links**: https only, no user/password in the address, at most 12, opened with `noopener noreferrer`.
- **Papers**: only her search words or a DOI (checked) go to a fixed address (`api.openalex.org`), encoded, no redirects, 20 s; the answer is parsed as data and every field checked (titles cut, links http(s) only, years in range). "What the studies say" sends only the found abstracts to the local model, and its answer is shown as text. Sources at most 500 per course; BibTeX values escaped, RIS lines kept on one line.
- **Slides, image occlusion**: picture names checked (`^[\w-]{1,80}\.(png|jpg|webp)$`) and read only from the course's own image folder; slide files go through the same import path as before (85 MB limit).
- **Players' speed**: a remembered number from a fixed list; no new input reaches the server.
- **Performance**: quiz phones poll once a second and focus rooms every 5 s, each answer a small in-memory read; no polling once a room is gone (404 stops the pages).

## Scan 123 (2026-11-17): degree progress, a similar problem, where a term appears, problem photos, EPUB/ODT, quiz talk, memory palace, the two-voice podcast, topic videos, scanned PDFs
- **EPUB / ODT / ODP**: read in memory through the same zip reader as Office files (entry count and total unpacked size capped, no file is written), at most 400 chapters; the markup is turned into plain text by our own code (scripts and styles dropped, entities decoded only in the valid code-point range) and is shown only as text.
- **Scanned PDFs**: the PDF and its page pictures stay in a temporary folder removed afterwards; the PowerShell script gets the paths through environment variables (no user text is put into the script; the page limit is our own number); at most 60 pages with Windows OCR, 15 with the vision model; 5-minute limit.
- **Topic videos**: the search words go to yt-dlp as one argument after `ytsearchN:` (so they cannot become options), with `--ignore-config`, names only (nothing downloaded); ids checked (`^[\w-]{11}$`) before links are built from them; adding one goes through the existing YouTube lecture route.
- **Where a term appears**: the term is cut to 100 characters, matching is plain substring search on folded text, at most 500 hits per lecture and 30 lectures returned.
- **Quiz talk, memory palace, podcast, "similar problem"**: model answers are shown as text; the palace and podcast are checked and cut before they are kept (12 spots, 600 characters per scene; 20 000 characters, 200 lines); the palace request body is limited to 64 KB.
- **Problem photo**: the same extract route as lecture photos (resized in the page first).
- **Degree progress**: numbers clamped (credits 0–400 per kind, total 0–600, pass mark 0–100), at most 12 kinds, ids checked.
- **Performance**: "where else" runs only when asked, over the course's own text; the podcast is written once and kept.

## Scan 124 (2026-11-17): hard cards, card timer, note cards, reading in portions, reading font, Moed B, pass/fail, timetable photo, letters, rehearsal, exam eve
- **Hard cards**: the fix only replaces her own card in her course with what the model wrote, checked (front 2000, back 6000 characters, at most 4 cards); the old id goes to `removed` so a sync does not bring it back; the "how" is one of three fixed words.
- **Note cards and portions**: the notes are parsed by our own line pattern (at most 200 cards, lengths capped); `readPos` must be a whole number within the text; a portion's range is clamped to the text and to 40 000 characters before it goes to the model.
- **Timetable photo**: the picture is limited (16 MB body, 12 MB image), its type is one of three image types, and the model's answer is checked (days 0–6, HH:MM, end after start, 80 classes, short names); she picks each class's course before anything is saved; new courses go through the normal course route.
- **Letters**: drafts only; KesherAI never sends mail. The mail link is built with `encodeURIComponent` and has no address (she picks it in her mail app). Inputs are cut (2000 characters of details) and the body limit is 16 KB.
- **Rehearsal**: only the transcribed text and the seconds go to the server (256 KB limit, 30 000 characters used); no recording is kept. The Mic change only adds a time measured on the page.
- **Moed B, pass/fail, reading font, exam eve, card timer**: computed in the page or our own code from her numbers; the exam-eve checklist is kept in this browser only (a convenience).
- **Formulas in a card's question**: the question now goes through the same RichText (KaTeX with its safe defaults, no raw HTML) as the answer already did.

## Scan 144 (2026-11-18): shared projects, stage 1 (guests)
- **Deny by default**: a guest key (`project:<id>:read|edit`) passes the auth hook only for `/api/guest/*`, and never with `.` or `..` path segments (tested with plain and encoded `..`); every guest route checks the guest's own project again. Owner routes (`/api/projects/:id/invites`, `/guests`) are out of a guest's reach.
- **The invite**: 32 random bytes; only its SHA-256 is stored (guest-invites.json, mode 600); one use, 1 hour to 7 days; the only route that takes it as a key is `/api/join/:token` (GET to see the project's name, POST with a name). A name is cut to letters, digits and a few marks (40).
- **What a guest can do**: read the project's chats as text (no tool output, no files); with edit, start chats of their own (`source: "guest"`, incognito, mode ask) and write only in those — never in the owner's chats, which can use tools, so a guest's words never reach a chat with tools. Guest chats get **no tools at all** (no files, computer, network, memory), and memory never files from them. A daily allowance (default 100 answers) per guest.
- **The owner**: is notified when someone joins; sees who has access, when they joined and were last seen; Remove deletes the key at once (tested).
- **Stage 2 (same day)**: the owner is told when a guest tries to go outside the project (a 403 on a guest key; the auth hook marks the device first), comes from a new network address, or sends over 120 requests a minute; optionally during quiet hours. Each kind at most once in 10 minutes per guest.
- **Stage 3 (same day, read only)**: a guest's chat made in the project's own folder gets list_files, read_file and search, nothing else. Secret files (.env*, keys and certificates, id_*, .npmrc/.pypirc/.netrc, credentials, secrets.*, anything in .git or .ssh) are left out of every answer and refused by name, including through `..` (tested). The tools stay inside the folder (the agent's own path check).
- **Stage 4 (same day, Roee chose Google)**: an email invite can be accepted only by that Google account. Google's device sign-in (as on a TV: the guest types a code at google.com/device), so nothing returns to this computer's address; KesherAI asks Google's token endpoint itself (over TLS, at Google's interval) and reads the ID token's claims there, checking the audience (the owner's client) and `email_verified`; the email must equal the invite's. A wrong account is refused and told which it was. The owner's client secret is kept in config.json and never returned by any route or synced. A ban removes the guest and lists their email; a banned email cannot be invited or join until the owner lifts it. A name alone cannot use an email invite (tested).
- 891 tests pass; lint and typecheck clean. No secret, email, user name or personal path in the changed files.

## Scan 143 (2026-11-18): Stremio's link sign-in, tabs, three.js and 3D previews
- **Found and fixed**: a `.gltf` model can name textures and buffers at any web address; the viewer now loads only this app's own addresses and `data:`/`blob:` (a LoadingManager URL filter), so previewing a model (one the agent downloaded, say) never contacts another server. GLB files embed everything.
- **three.js 0.181.0** (pinned, with @types/three): loaded only when a model opens (a lazy chunk), no network of its own.
- **Stremio's link sign-in**: only `link.stremio.com` addresses that match the code are shown; the code is checked before it goes into the request; the key is checked against a token pattern. "New code" just starts again.
- **Tabs**: addresses kept in the browser (localStorage), read back only if they start with `#/` and are under 500 characters; nothing reaches the server.
- No secret, email, user name or personal path in the changed files.

## Scan 142 (2026-11-18): the extension per site, publishing it from GitHub, load settings per model, exes
- **Extension 0.2.6**: no sites at install (`optional_host_permissions`). `allow.html` asks only for an http(s) origin it checks with a pattern (built by background.js from the tab's own address, never from the app's command); "Not now" or no answer in two minutes stops the task with a plain error. The side panel asks for the site in front from the click. Tested in Chromium.
- **Publishing from GitHub**: the service account has no Google Cloud roles; it can only act on this publisher's items in the Chrome Web Store (added there by Roee). Its JSON key lives only in the repository secret `CWS_SERVICE_ACCOUNT`; `scripts/google-token.mjs` signs a 10-minute JWT and prints only the access token, which the workflow masks (`::add-mask::`). The workflow runs on main and by hand only (not on pull requests, so no fork reaches the secrets), and has `contents: read` only. The status check printed the item's public key (public by design) and no secret.
- **Load settings per model**: the fix keeps the engine's arguments cleaned for the build before a model's own go on top; arguments still only from the allowed list, checked on the server.
- **Exes in the relationship analysis**: prompt text only; the report never advises contacting the other person.
- No secret, email, user name or personal path in the changed files.

## Scan 141 (2026-11-18): slash commands, prompt fields, the icon, recovery from a broken answer, focus after dialogs, file previews
- **Built-in slash commands** (`/compact`, `/fork`, `/new`, `/model`): run only from the chat box by the user; they call the existing routes (compact, branch, create, model switch), so no new access. `/model` takes only a name from KesherAI's own list.
- **Prompt fields**: the `{{…}}` fields are filled into the text before sending; nothing is run or fetched from them. The form escapes nothing into HTML (React text only).
- **The icon**: build-time SVG to PNG with Playwright from files in the repository; no network, nothing at run time.
- **Recovery from a broken answer** (llama.cpp's "does not match the expected … format"): at most two more requests per step (again, then without tools), and only for that exact message, so a failing server is not hammered. The note to the model is fixed text.
- **Focus after dialogs** (`refocus`): an IPC message with no arguments; the main process blurs and focuses only the window that sent it. Nothing else is exposed.
- **File previews in the Workspace and under answers**: the same `/files/preview` route as attachments (only files inside the chat's folder, by `resolveInWorkspace`, 50 MB at most). A name in an answer like `../x.csv` is refused there and shows "not found". Word and HTML pages stay in the frame with no scripts (`sandbox=""`, CSP `default-src 'none'`). Web addresses in answers are not made into chips.
- **Performance**: finding the file names in an answer is one regular expression over its text (at most six chips); previews load only when opened (a chip) or picked (the Workspace).
- No secret, email, user name or personal path in the changed files (checked with the guard's pattern).

## Scan 140 (2026-11-18): the model score, Stremio and Trakt sign-in
- **Stremio sign-in**: the email and password go in one 4 KB request to KesherAI and on to `https://api.strem.io/api/login` only (no redirects followed, 20 s limit); the password is never written, logged or returned (a test reads the saved file). Only the session key is kept, in stremio.json (mode 600, like the MyAnimeList client id); `GET /api/stremio` says only whether it is connected and with which email. "Sign out" calls Stremio's logout and removes the key. Library items are read as plain data: strings cut to 200, numbers checked, at most 20,000.
- **Stremio's own sign-in page** (added the same day, Roee asked): the page opens in KesherAI's browser pane (its own storage, apart from KesherAI's pages); she signs in on Stremio's site (Google or Facebook too), so no password reaches KesherAI. The pane's new `stremio` action takes no address from the request: it opens only `https://web.stremio.com/#/intro?form=login` and reads, only from a tab whose origin is exactly https://web.stremio.com, the string at `localStorage.profile.auth.key` (checked against a token pattern) in an isolated world; nothing is typed, clicked or read besides. The page polls every 3 s for at most 10 minutes.
- **Stremio's link sign-in** (added the same day: the page sign-in needs the computer's screen, and Roee is on the phone): KesherAI asks `https://link.stremio.com/api/v2/create` for a code and shows only an address that matches `https://link.stremio.com/<code>`; she signs in and confirms on Stremio's site; `read` returns the session key once, checked against a token pattern. The code is checked before it goes into the address. No password reaches KesherAI.
- **Trakt**: her app's client id and secret must be 64 hex characters; the device code flow means no Trakt password reaches KesherAI; the address shown to her must start with https://trakt.tv/; the token is checked against a plain token pattern and kept like the Stremio key, never returned. Polling is from the page every 5 s while the code waits, and stops when it ends (at most 30 minutes).
- **Model score** (`/api/models/suggest`): reads only KesherAI's own model list and the hardware estimate; "Switch" uses the existing load route (its folder check), "Download" the existing "Start here" route. Nothing is switched without a click.
- **Performance**: the score runs over at most a few dozen models with arithmetic only; the hardware is read from the cached detection.

## Scan 139 (2026-11-18): per-change undo, the hosted API docs, documentation rules, the study split
- **Per-change undo** (`POST …/runs/:run/undo {path, hunk}`): only a file kept for that run can be named (matched against the run's own list, so no path from the request reaches the disk); `hunk` must be a number and a missing or stale one is refused with a message; nothing runs while the agent works. The change is put back with the diff library's own patching (no shell); a file new in the run cannot be undone in parts. The run's fingerprint of the file is updated, so "Undo all" still asks before touching a file the user changed later.
- **Hosted API docs** (`.github/workflows/docs.yml`): runs only on the release branch or by hand, with `contents: read`, `pages: write` and `id-token: write` only; no secrets. It refuses to publish if the built site names a Windows user folder, a home folder (other than the runner's) or a Gmail address; the local build had none.
- **Documentation rule for the interface and desktop shell**: lint only, nothing at run time.
- **shared/study.ts split** (clinical, fields, goals): the same exports through study.ts; the phone's bundle and its study checks pass, and the dose calculations are unchanged (their tests pass).
- **Lip sync self-test on the PC**: the card was freed through KesherAI (self-work paused, chat and image engines stopped), the check ran (lips move, 24 fps), lip sync was stopped and self-work resumed.
- **Mermaid 11.6.0 → 11.17.2 (fixed while scanning)**: `pnpm audit --prod` listed 11 advisories (XSS and CSS injection in labels and classDefs, prototype pollution, endless loops in Gantt / XY / radar charts). Diagrams come from model text, so this mattered even with `securityLevel: "strict"`; the same major version, released three months ago. The audit is now clean apart from the one already ignored with its reason (scan 127).
- **The Study page split** (home cards, lecture view, nursing tools, shared helpers): the same components, typecheck, lint and the interface check at computer and phone width.
- **Performance**: undoing one change reads and writes one file; the docs build adds a CI job only on releases.

## Scan 138 (2026-11-18): phone swipes, the lip sync check, Hebrew logit bias
- **Phone swipes** (`swipe-tabs.js`): passive touch listeners; a swipe only clicks a tab already on the screen (as a tap would), never the Phone/Computer switch or the app's sections, never over fields or sliders.
- **Lip sync check**: the script prints one JSON line; KesherAI reads it with a parser that takes only numbers and a boolean. The sample face used before her clip is MuseTalk's own file inside its folder (no path from the request). A full graphics card gives a fixed message, not the raw error.
- **Hebrew logit bias**: a fixed list of 492 single letters with a bias of −10, sent only to the local llama.cpp server and only when her message is Hebrew; it can make other alphabets unlikely, never forbidden, and carries nothing of hers. The prompt's Hebrew rule is text only. Checked on the PC: llama.cpp accepted it and answered in clean Hebrew.
- **Performance**: the bias list is built once at start; tokenizing it on the server costs a few milliseconds a turn.

## Scan 137 (2026-11-18): imports in the background, chats picked again, swipes, the Study setup's fixes
- **Imports in the background**: `/api/chat-reports/import` checks its input before it returns (an https link; KesherAI's own browser for a link; at least 200 characters of text), then runs on. The page is read with the browser bridge's own `open`/`read` (no new browser power); the wait is capped (15 reads, 3 seconds apart). A sign-in page is recognised and refused with what to do, so a login form is never "imported". Every step is written to the report file only (the step's name and a number). A report left "being written" after a restart shows as stopped; nothing restarts on its own.
- **Chats picked again**: `/api/chat-reports/chats` lists only titles, counts and dates of chats already on this computer. `fromReport` loads a report's own `chat.json` by id; the id must be a plain id (letters, digits, `-`, `_`; else 404), so no path can be built from it. Nothing leaves the computer.
- **Swipes between tabs**: touch listeners are passive; a swipe only clicks a tab or a page link that is already on the screen (the same as a tap), only inside the page, and never on fields, sliders or sideways scrollers.
- **Study setup**: the address question reuses About you (the same `/api/user`); `.button` styles change looks only.
- **Performance**: the import's step updates are one small file write each; the page polls every 3 seconds only while a report is being made, as before.

## Scan 136 (2026-11-18): attendance, self-work's night items, the Windows log
- **Attendance**: kept inside the timetable and checked by `cleanTimetable`: mark keys must be `slotId@YYYY-MM-DD` with one of four marks (at most 2000), rules are whole numbers (0–50 absences or 1–100%), course keys are short ids (at most 100). The notes ("were you there?") carry fixed text and the course's name; on the computer they stay on the computer, on the phone they are local notes. A rule typed on the phone goes through the same cleaning.
- **Self-work's items (reviewed and re-applied by hand, not merged blind)**: SUMIF/COUNTIF criteria are parsed with one fixed regular expression and plain comparisons, no eval. The phone keeps the last 5 rehearsal transcripts (each cut to 4000 characters) in the course, says so on the screen, and can delete them. The word count, the week order and the reading minutes are display only. The heavy-folder test's Windows branch changes only a test.
- **The Windows log**: the app's own log (`logs/main.log`, start and end reasons, child processes, memory) had silently stopped on Windows since the NVDA pass; it runs again. It logs program names and paths of child processes, not their output or the user's text (unchanged).
- **Test profile**: with `KESHER_DATA_DIR` set, the app no longer attaches to the everyday copy on 7420; it uses its own port and data only.

## Scan 135 (2026-11-18): "this question is wrong", asking the course by voice, the test profile
- **Question check (computer)**: `POST /api/study/courses/:id/quiz/:qid/questions/:n/check` finds the question by index (a number that is not a question gives 404); her own answer must be a whole number within the options (400 otherwise). The model's reply is read as JSON only: the verdict is one of three words, the option is bounds-checked, the quote and the explanation are cut to 300 and 600 characters. A lecture that tries to steer the model can at most change the key of a question in her own quiz, which she sees marked "fixed". It sends one model call per tap (lecture cut to 40,000 characters, with the context fallback from scan 134). The answers are shown as text (React and a toast; no HTML).
- **Question check (phone)**: the same prompt and parser on the phone's model; the result is drawn with text nodes. A removed question leaves the saved quiz, which copies only the question's known fields.
- **Ask by voice (phone)**: the microphone opens only on her tap and closes on the second tap (the tracks stopped, the audio context closed); the audio is transcribed on the phone and not kept. 🔊 hands only the answer's text to the phone's own voice.
- **Test profile**: a set `KESHER_DATA_DIR` now also moves the window profile (`<data>/ui`), so a test copy does not share cookies or storage with the everyday KesherAI. The self-work worker keeps its own rule; without the variable nothing changes.
- **Performance**: nothing runs until she taps; no new background work.

## Scan 134 (2026-11-18): fitting the model's context everywhere, Try again on a report, check_code's Unreal scope
- **Context fallbacks (computer Study, the course tutor, chat reports, the phone)**: each is bounded (two or three more tries, each shorter; aborting stops them) and only on errors that name the context; any other error is reported as before. The cut keeps the start of the material and says that the rest was cut, so the model is not misled into thinking it saw everything. No new data is kept.
- **Try again on a failed report**: `POST /api/chat-reports/:id/retry` works only for a report in the error state, refuses one being written (409), reads the chat already stored for it; it uses the same model choice rules as the first run.
- **check_code**: the new `git status --porcelain` runs in the work folder with a fixed command (no user text), 20 s timeout; paths from it are only compared as text to the checker's lines. A project without git, or an Unreal project, keeps the whole-folder check.
- **Performance**: a context error now costs one or two more model calls instead of a failed feature; the halving keeps each retry cheaper than the first.

## Scan 133 (2026-11-18): Back on track, My progress and the goal reminder, long reports and quizzes on a small context
- **Back on track**: `/review?limit=N&backlog=1` caps N at 1–500; the order and the plan are computed from her own course (no new data kept); the pace is one word in the browser's or phone's storage.
- **Long reports (fixed from Roee's phone)**: "Context size has been exceeded" ended an import or a new report with a server error. Parts are now smaller on a context error (halves, then quarters; notes 40k → 20k → 10k characters), a model too small even then gets a 422 with what to do, and the error path no longer leaks a stack or a 500. The retries are bounded (at most three sizes, two levels of halving), so a failing model cannot loop.
- **Quizzes**: at most one more try, with a third of the material; aborting the request stops it.
- **My progress / goal reminder (phone)**: computed on the phone from its own data; the reminder is a local notification with fixed text (no course content in it).
- **Hebrew address**: the converter only swaps listed whole words; the new noun phrases keep their words. No user text reaches a regular expression (the phrases are fixed).
- **Engine**: after a context overflow the llama.cpp server kept failing to find KV space for later requests; it was reloaded on the PC. The fixes above keep requests within the context, so it should not recur; noted for a check after the install.
- **Tests**: the self-work worker test no longer depends on free disk (an environment variable only tests set); the 5 GB rule for users is unchanged.

## Scan 132 (2026-11-17): image cards on the phone, self-work start, the devcontainer, small phone items
- **Image cards on the phone**: the picture is re-drawn on a canvas and saved as a JPEG (at most 1600 px), which also drops the photo's metadata (EXIF, including where it was taken) before it is kept; it stays in the phone's IndexedDB and never leaves the phone (sync carries only the card, with a name that matches the computer's `^[\w-]{1,80}\.(png|jpg|webp)$` check). At most 40 boxes, labels cut to 200 characters, shown as text. The computer does not request a "ph-" picture; it says the picture is on the phone.
- **Self-work start**: the "branch taken" check runs `git rev-parse --verify --quiet refs/heads/kesher-self/<digits>` (a fixed pattern, no user text in the command); a model id gets "main/" only when it lacks it.
- **Devcontainer**: the Microsoft Node 22 image, `pnpm install` from the lockfile (the same packages as everywhere); no secrets or mounts.
- **Phone**: the letter's name and the English score live only in the phone's storage (try/catch, 80 characters).
- **Performance**: picture cards load their image from IndexedDB once per card shown; a 1600 px JPEG is about 200–400 KB.

## Scan 131 (2026-11-17): the NVDA pass, Temp filling drive C, the guided Study setup (computer and phone)
- **Drive C filled by our own tests (fixed)**: the phone-models test made a 2.1 GB fake model (and others 150 MB) with `truncate`, which on Windows (no sparse files) writes real bytes, and never removed its folder. Self-work runs the tests after every step on Roee's PC, so Temp grew to 112 GB and C fell to 3.9 GB (updates and installs fail when C is full). The model tests now remove their folders; 108 GB was cleared. Self-work's older branch still has the old tests, so Temp is cleaned at each night check until it is merged.
- **NVDA pass**: a portable NVDA outside the repo (E:\KesherAI\tools), muted, its speech log read and then deleted, because a screen reader's log records everything spoken, including notifications from other apps (it caught a private chat notification). Nothing from it went into git or the docs.
- **Study setup prefs**: `PUT /api/study/prefs` takes only its ten known keys; each goes through `cleanStudyPrefs` (field only from STUDY_FIELDS, year 1–7, step 0–3, skipped steps only known names). The phone keeps the same shape in its own storage.
- **Downloads in the setup**: only when she taps, through the existing routes (`/api/models/recommended/:id/run`, the speech-to-text setup), which keep their checks and their remote-token rule; the page shows the size first. The phone's "Get a model" only opens the chat tab, where the phone's own download (with its size) is.
- **Phone readiness**: local.html tells Study only whether a model file exists on the phone and whether a computer address is saved; no new network calls.
- **Performance (fixed while scanning)**: the "Getting started" list checked the models (a hardware and disk scan on the computer, loading the model engine on the phone) on every visit to Study, even when all was done. It now runs only while the list shows, and the list hides itself for good once everything is done.

## Scan 130 (2026-11-17): the phone's teach-back, writing coach, My week, highlights, mistakes and match, occlusion pictures
- **Teach-back and writing coach on the phone**: her text and the lecture passages (found on the phone with `findPassages`) go only to the phone's own chosen model; the answers go through the shared `parseTeachBack` / `parseWritingFeedback` (lists and lengths capped, levels in range) and are shown as text through `el()`. "Missing" points become cards through the normal card path.
- **My week**: plans live in the phone's storage (at most 40); the model's steps go through the shared `checkPlan` (dates only between today and the due day, 10–240 minutes, at most 8 steps, no day over 3 hours). Moving `planPrompt`/`checkPlan` to @kesher/shared changed no behaviour on the computer (its tests pass).
- **Highlights**: kept on the lecture through `cleanHighlights` (300 a lecture, 2000 characters, ids checked), so they sync like the rest of the lecture.
- **My mistakes, 5-minute lesson, match**: computed from her own course data on the phone; nothing is sent anywhere; the best time is one number in local storage.
- **Occlusion pictures on the phone**: the image name is checked against `^[\w-]{1,80}\.(png|jpg|webp)$` before the URL is built, and the computer's route checks it again; the device key rides in `?token=` like the recording player, and the access log keeps only the path (the query is cut), so the key is not written to logs.
- **Fixed while working**: a lecture with no diagram or terms printed "nullundefinedundefined" (the DOM's append writes null as text); study-check now fails on any stray null/undefined text on the pages it opens.

## Scan 129 (2026-11-17): the welcome's timetable photo, My week's times, axe in the UI check, grades sync, the phone's mock exam
- **Welcome from a photo**: the picture goes to the local vision model only (the same route as the timetable card); at most 20 courses are made, names from `cleanReadClasses` (cut, checked); slots go through `setTimetable` (only her courses' ids, valid times).
- **My week's times**: computed in the page from her own timetable (no request), nothing new stored.
- **axe-core**: a dev dependency used only by scripts/ui-check.mjs; it is injected with bypassCSP only into the check's own headless browser at computer width; the shipped app and its CSP are unchanged. The release audit (`pnpm audit --prod`) does not include it.
- **Grades sync**: the phone's copy goes through `cleanGrades` (200 rows, numbers in range, ids checked) and wins only when its time is later; the web's own saves stamp the computer's time, so an old copy from a page cannot win.
- **Phone mock exam**: model answers are parsed with `jsonIn`, each question checked (options, a valid answer, calculations re-checked), shown as text through `el()`; stored in the course's quizzes like any quiz.
- **Performance**: ui-check now takes about a minute longer (axe on 22 screens).

## Scan 128 (2026-11-17): sources import, a table as a sheet, the phone's share lens, the circle lens
- **BibTeX/RIS import (fixed while scanning)**: the first BibTeX reader matched whole entries with one lazy pattern over the file, which a broken file (many "@" and no closing brace) could make slow; it now splits the file at each "@" line (at most 2000 entries, 50 KB each) and reads one entry at a time (a 20,000-entry broken file: 5 ms). Up to 4 MB a request; every source goes through `cleanSources` (lengths, DOI shape, http(s) links only); at most 500 sources a course.
- **Comparison table → sheet**: only the first Markdown table's cells, as CSV, through the existing sheet route (its limits); no formulas are made from model text unless a cell starts with "=" as typed by the model — sheets compute locally and only reference other cells (no outside calls).
- **Share → KesherAI on the phone**: only files ShareActivity copied into the app's own share folder can be read (`inShared` path check), at most 10, removed after reading; pictures go to the phone's own model; text files over 400 KB are refused.
- **Circle lens**: the path is kept in memory only while marking (at most 2000 points); nothing new leaves the computer.
- **Downloads default folder**: a .gguf without a category goes to models/chat (still under the models folder; the path check against the base is unchanged).

## Scan 127 (2026-11-17): the phone link page, development plugin folders, a new npm advisory
- **/open (a link that opens the phone app)**: outside /api with the nonce'd CSP, no-referrer, no-store; the key travels only in the link's # part (never sent to the server or logged), is checked against `^[\w.~-]{8,200}$` and leaves the address bar at once (history.replaceState); the intent names the app's package, with the browser as the fallback.
- **Development plugin folders**: added and removed only from this computer (`isLocalRequest`), at most 10, must hold a kesher-plugin.json; they load with the same rules as installed plugins (their own process, permissions shown); the watcher ignores node_modules and .git and reloads at most once per 800 ms; watching stops at shutdown.
- **Release blocked by `pnpm audit` (high)**: GHSA-fc5q-39xc-vjpf, picomatch ReDoS, no fixed version on npm (latest 4.0.7). It comes only through @excalidraw/excalidraw > sass > chokidar (the Sass compiler's watcher), which the built interface never runs and which never sees a user's pattern; ignored by id in pnpm-workspace.yaml with this reason, to be removed when a fix ships.

## Scan 126 (2026-11-17): Tailscale Funnel, finding the computer again, the phone-alone study, photos with vision
- **Funnel visitors were all "127.0.0.1" (fixed)**: Funnel connects from this computer, so every internet visitor shared one address for the wrong-token limit; scanners hit the new ts.net address within minutes (all 401) and could have locked out the user's phone. `clientAddress` now takes the first X-Forwarded-For address when the request carries Tailscale-Funnel-Request (only from loopback; from the network the headers are not believed); the access log marks it "tunnel". Funnel requests are never local (`isLocalRequest` refuses forwarded headers and a non-local Host), and the devices-only and idle-days rules already applied to them.
- **Finding the computer again (link beacon)**: the internet address (no key) is sealed with AES-GCM under a key derived from each paired phone's key hash, and posted to an ntfy topic also derived from it (40 hex characters); ntfy sees only ciphertext, nobody without the key can name the topic or read it, and the phone accepts only an https address with no path and still needs its own key to come in. Off with `remote.linkBeacon`; at most 20 keys a round, every 5 minutes only when the address changed or 6 hours passed. Someone with the config file could read the address (it holds the hashes), but they already have the computer.
- **Phone study alone**: OpenAlex is fetched from the phone (the query only), the model's answers are shown as text through `el()` (textContent), letters open in the phone's mail app and are never sent by the app; grades and the timetable stay in the phone's storage (the timetable syncs with the computer, the later copy wins, slots only for her own courses).
- **Photos with a vision model**: the picture goes to a local model only (the loaded one with its vision file, else a local file under 24 GB); a cloud model is used only when she chose one as her chat model, as before.
- **Performance**: the 31B vision model took about 10 minutes to load on the PC; a 12B one (7.4 GB) was downloaded for photos (about 8 s), and photos now pick the loaded vision model first.

## Scan 125 (2026-11-18): academic English, the course web, the group project board, the study feed
- **Group project board (a public page that writes)**: `/g/<token>` is outside /api; the key is 128 random bits, checked against `^[\w-]{16,40}$` before any lookup, made only when she shares and removed when she stops (the link then answers 404). Teammates can only add a task, take or release one, or tick one done; the action is one of three fixed words, the body is limited to 4 KB, texts are stripped of control characters and `<>` and cut (task 300, name 40), at most 100 tasks. The page runs only its own nonce'd script (the same CSP, no-referrer, noindex, no-store as the quiz and focus pages) and writes every text through an escaper. Her own edits go through /api with her key and keep the share key as it is.
- **Academic English**: only the text she pasted goes to the local model (128 KB body, 8000 characters used); the answer is checked (8 questions, 20 words, lengths cut) and shown as text; adding words uses the normal card route.
- **Course web and feed**: computed from her own course data (at most 400 terms looked up, 300 links; feed at most 60 items); card text in the feed goes through RichText as in review.
- **Performance**: the project page polls every 10 s and pauses while she types; a teammate's lookup reads her courses' files once per request (a handful of courses).

## Scan 145 (2026-11-18): the image editor from the chat, Stremio links, tabs, the report in chapters
- **A page opened with a chat's file** (`#/p/<plugin>/<page>?c=&f=`): `pageInput` hands a file only when it is a picture
  (by its extension), the chat id is plain (`[\w-]`), and the page declared the picture models. The file is read through
  the chat's own download route, which stays inside the chat's folder. A link cannot give any page any file.
- **`chat.sendFile`**: only after the page was opened from a chat, only to that chat, up to 50 MB, the name cut to 120
  characters and cleaned again by the server's upload route.
- **Found and fixed:** the plugin bridge read `image.upscale`, `speech.transcribe` (and the new `chat.sendFile`) with
  `fetch(whatever the page sent)`. A page could have passed an address of this app (`/api/…`), fetched with the app's
  rights. Now only `data:` URLs are read (`fromDataUrl`).
- **Desktop links out**: besides web addresses, only `stremio://` links leave the app (they open the Stremio app at a
  title, or add our add-on); `file:`, `smb:` and other schemes still never do.
- Tabs and the report's chapters: display only; the "all on one page" choice is in localStorage (per browser), nothing sent.
- Checked: lint, typecheck, 896 tests.

## Scan 146 (2026-11-18): the video editor (cut and transcript routes), phone tabs, crop
- **`POST /api/conversations/:id/files/cut`**: the path goes through `resolveInWorkspace` (the chat's folder only) and
  must be a video; the stretches are checked numbers (1–400, each ≥ 0.1 s, ≤ 12 h), so the FFmpeg filter graph is built
  from numbers only; FFmpeg runs by `execFile` with an argument list (no shell), a 60-minute limit and a 4 MB output
  buffer; the new name is cleaned and kept in `shared/`, never over an existing file. **Added:** one cut at a time
  (429 otherwise), so a page cannot fill the processor.
- **`POST …/files/transcript`**: the same path rules; whisper on the computer only (no cloud upload of the video here).
- **The bridge**: `video.cut` and `video.transcript` need the page's declared `video` use and a video it was opened with;
  **added:** `editor.input` refuses a file over 2 GB (it is copied into the page's memory).
- **Phone tabs**: touch listeners on the top bar are passive and removed on change; the long-press menu only navigates
  or closes tabs (localStorage). **Crop**: canvas work in the sandboxed plugin page only.
- Performance: the timeline redraws only on edits and the playhead moves by one style change per frame; the transcript
  list redraws on edits, not per frame.
- Checked: lint, typecheck, 898 tests; FFmpeg cut verified on a 12 s test clip with and without sound.

## Scan 147 (2026-11-18): instruments, voices, editors as parts, the 3D editor, the bridge's data URLs
- **Found and fixed (important):** a plugin page's own address carried the app's token (`/api/plugin-files/<token>/…`,
  so its relative links work in a sandbox). Any plugin page could read it from `location` and, with `allow-popups`,
  open a window to another site with the token in it. Now the address carries `PLUGIN_FILES_KEY`, random for each start,
  which opens only plugins' files (GET); the token is never in a plugin page. Test: "the plugin files key opens a
  plugin's files from another device, and nothing else".
- **`own.file`**: a path inside the plugin's folder only (`[\w-]` segments, no `..`), served by the same route that
  checks the plugin's own folder.
- **`sound.say`**: text cut to 2000 characters; a cloned voice's name is checked by the voice engine
  (`[\p{L}\p{N} _-]{1,40}` and the file must exist); Kokoro takes only a number.
- **`fromDataUrl`** decodes data URLs itself (the app's CSP rightly blocks fetching them); nothing else is fetched.
- **Microphone**: only for a plugin frame whose plugin declares `sound`; the browser still asks the person.
- **Parts**: turning on another editor asks the person first (`confirm`), with what it is and its size.
- **The 3D editor**: three.js runs inside the sandboxed page; GLTFLoader parses bytes only (no external URIs are
  fetched: the page's CSP has `connect-src 'none'`).
- Checked: lint, typecheck, 902 tests.

## Scan 148 (2026-11-18): the hand-off between editors, textures, modifiers, splitting and choosing parts
- **`editor.handoff`**: only from a page opened from a chat; `to` must be one of the four editors and not the page itself;
  the slot is short plain text (`[\p{L}\p{N}_:. -]{1,80}`); every file it carries (the file, the guide, the working copy)
  is decoded from a data URL by the app, checked for size (≤ 300 MB) and saved through the chat's own upload route, which
  cleans the name and keeps it in `shared/`. It opens the other editor through `offerPart` (asks before turning a part on).
- **`editor.handBack`**: only for a page opened by a hand-off; it goes back only to the editor and the file in its own
  validated address (`retp` is one of the editors, `ret` must be that editor's kind of file); `back` must be a picture.
- **`pageInput`**: the new `ret` / `retp` / `slot` / `back` / `g` are checked one by one (tests: a made-up editor, a
  `.env` to go back to, a slot with markup — all refused).
- **The image editor's guide layer** is drawn but left out of every export (`flatten` skips it), so a UV layout never
  ends up in a texture or in the chat.
- **3D editor**: modifiers, split and choose-by-click work on geometry in the sandboxed page only; neighbours are worked
  out once per geometry and kept; a texture is read from a data URL into an `Image`, never fetched.
- Checked: lint, typecheck, 902 tests; the texture round trip, split and choose-by-click checked in a browser.

## Scan 149 (2026-11-18): texture from words, the parts engine (P3-SAM), PBR slots, noise clean-up, shot changes
- **Parts engine (`/api/part-seg`)**: owner only (a guest key reaches only `/api/guest/`; plugin pages cannot fetch, and
  `model.parts.setup` asks before installing). Programs run with `spawn` and an argument list, never a shell; the mesh is
  checked to be a GLB (magic bytes, ≤ 200 MB) and written to a random folder under `engines/p3sam/work`, removed after.
  One job at a time (409 while busy); every run has a timeout. **Known risk, accepted by Roee:** the setup downloads and
  runs Tencent's Hunyuan3D-Part code from its Hugging Face Space (its latest version, not pinned) and the PyG / PyTorch
  wheels; it runs in its own venv, with the app's user rights. **Then fixed:** the first setup records the Space's and the
  weights' revisions (`paths.json`), and every later setup downloads exactly those, never newer code.
- **`video.scenes` / `POST …/files/scenes`**: the path goes through `resolveInWorkspace` and must be a video; the
  threshold is clamped to 0.05–0.9 and written with `toFixed`, so nothing else reaches FFmpeg's filter; `execFile`, no
  shell. **Fixed in this scan:** it decodes the whole video, so it is now one at a time (429), like cutting.
- **PBR slots**: the slot coming back from the image editor must match `^\d+:(map|roughnessMap|normalMap)$`, so a hand-off
  cannot set any other material property. Roughness / normal are made in the page from pixels only.
- **Noise clean-up**: in the page only (no bridge, no network); a minute of sound in about 0.3 s.
- **Performance:** the clean-up runs on the page's thread with a busy sign (a 10-minute recording takes a few seconds);
  moving it to a worker is on the list if it is felt.
- Checked: lint, typecheck, tests (video-cut: scene times), the scene finder on a real 3-shot video, the clean-up on a
  noisy tone (noise −9 dB, tone unchanged), the normal and roughness maps' directions in a browser.

## Scan 150 (2026-11-18): burned captions, reframe, painting, auto UVs, chords, full-card checks, stop, layer masks
- **Burned captions**: the captions go to FFmpeg only as a copy named `.kesher-burn-<uuid>.srt` (checked by
  `^[\w.-]+\.srt$` in `cutArgs`), and FFmpeg runs in that folder, so no path or text from the page reaches the filter
  string; the copy is removed in `finally`. **Reframe**: only the four listed shapes reach FFmpeg (tested: `3:2;drawtext`
  is refused).
- **Stop (`/api/part-seg/cancel`)**: owner only, like the rest of the engine; it only kills the running split, never the
  setup (so the venv is not left half-written).
- **Full card**: read-only use of the GPU guard's last reading; the engines answer 409 instead of starting.
- **Painting, auto UVs, layer masks, chords**: in the sandboxed pages only, no new bridge calls.
- **Performance**: a masked layer is composed into a temporary canvas on each redraw (fine at a few layers; a cache is on
  the list if painting over many masked layers feels slow); painting on the model updates one 1024² texture per move.
- Checked: lint, typecheck, tests (video-cut 7, part-seg 4), browser runs of every editor's new tools with a stub host.

## Scan 151 (2026-11-18): tap select (SAM), the 3D task bar, the Blender round trip, expand with AI, four views
- **Tap select**: the point reaches Python only when both numbers are whole and 0–99 999, and only through JSON in an
  argument (no shell); `sam` is one of the fixed models; the download of SAM is named in the setup's question.
- **3D task bar**: the chat model's answer is data: parsed as JSON, then only known keys are used, the colour must match
  `^#[0-9a-f]{6}$`, numbers are clamped to 0–1, the texture words are cut to 200 characters; nothing it says is run.
- **Blender round trip**: only Blender found where it installs (Program Files\Blender Foundation, /Applications, the
  PATH) is started, with a fixed script; the file goes in `KESHER_GLB`, never into the script; the file must be a .glb
  in the plugin's own folder (`okName`, now with .glb). The 3D editor asks for the plugin "filesystem" permission, which
  is only that folder. Blender gets the app's environment, as any program the user starts.
- **Expand with AI, four views**: in the pages only.
- Checked: lint, typecheck, tests (open-in-app, bg-remove, part-seg), the Blender script with Blender 5.0.1's bpy, the
  pages' new tools in a browser with stub hosts.

## Scan 152 (2026-11-18): a Godot scene without Godot (read, stand-in, write back)
- **`/api/godot/scenes`, `/api/godot/scene`**: the owner's (guests reach only `/api/guest/`); the folder must hold
  project.godot; the scene must be `res://….tscn` inside it, checked twice: by path (`..` refused) and, **fixed in this
  scan**, by the real path too, so a link inside the project cannot lead a read or a write outside it (test).
- **The write**: only the transform / position lines of the nodes that moved change (tscn.ts, tested byte for byte
  elsewhere); every number must be finite; at most 5000 changes; a copy of the file as it was is kept
  (`.tscn.kesher-bak`); refused while the Godot editor is connected, so Godot never reloads under her feet; a clash
  (it moved in Godot too) is answered as data and written only when she keeps hers.
- **The page**: `gp` / `gs` are checked in `godotSceneInput` (only `res://….tscn`, no `..`, only for a page that declared
  `model`), and the bridge sends only that scene's path; the stand-in page cannot name another file.
- Checked: lint, typecheck, tests (tscn 2, godot-scene 3, page-input), the stand-in in a browser with a stub.

## Scan 153 (2026-11-18): real shapes in the game-scene stand-ins (Godot and Unity)
- **`/api/godot/asset`, `/api/unity/asset`**: the owner's only; only model files (`.glb`/`.gltf`; Unity also `.fbx`/`.obj`)
  inside the project (`res://…` / `Assets/…`), checked by path (`..` refused) and by the real path (a link cannot lead
  outside); at most 150 MB; sent as bytes, never run or parsed on the server.
- **Nested Godot scenes**: an instanced `.tscn` is read through the same path checks, two levels deep at most (no loop),
  and its nodes are marked `inner`: the page never sends them back, so a save cannot touch another file.
- **Unity looks**: GUIDs are found by walking `Assets/**/*.meta` (links not followed, 200 000 files at most, stopping
  when all are found); a prefab is read for its first mesh only, and only when under 20 MB (**fixed in this scan**).
- **Placed prefabs' moves**: the id is two numbers (`<source id>:<instance id>`), checked by the route's pattern before it
  is queued; the package builds a GlobalObjectId from them and moves the object only if it resolves to a Transform in
  the open scene, with Undo.
- **The page**: models are parsed in the sandboxed plugin page (three.js loaders), never in KesherAI; `standin.asset` only
  serves the project the page was opened with.
- Checked: lint, typecheck, tests (tscn 3, godot-scene 4, unity-scene 3, unity-scene routes 2), the Unity package compiled
  (mcs, stubs), both stand-ins in a browser with stub hosts (shapes, models, a heavy model simplified to ~50 000 triangles).

## Scan 154 (2026-11-18): the Unreal level stand-in, the outliner's details, 2D sprites and 2D writes
- **`/api/unreal/levels`, `/api/unreal/level`, `/api/unreal/level/mesh`, `POST /api/unreal/level`**: the owner's only; a
  level must be `/Game/…` and a mesh `/Game/…` or `/Engine/…` (letters, digits, ` ./-_`, no `..`), checked here and
  again in the plugin (KesherLevel.cpp loads only those roots). The copies kept are under KesherAI's own data folder,
  named by a hash of the path (never by the path). Moves: at most 5000, ids `[\w.-]{1,200}`, every number finite; the
  plugin moves only actors of that level, with Undo, leaves those that moved in Unreal, and saves (headless only) just
  the packages it changed. A mesh's triangles: at most 30 000, else only its bounds.
- **Sprites' pictures**: `/api/godot/asset` and `/api/unity/asset` now also serve `.png/.jpg/.webp` (Godot also
  `.svg`) inside the project, with the same path and real-path checks; sent as `application/octet-stream` with
  `Content-Disposition: attachment`, so an .svg is never shown as a page by KesherAI (the sandboxed plugin page draws
  it as an image).
- **The outliner's details** (Godot scripts / textures / collision kinds, Unity components and script names, Unreal
  components and folders) are shown as text (`textContent`), never as HTML.
- **2D writes**: rotation and scale must be finite (route), and only the node's `position` / `rotation` / `scale` lines
  change (tscn test).
- Checked: lint, typecheck, tests (tscn 6, godot-scene 4, unity-scene 3 + routes 2, unreal-level 1, unreal-bridge),
  the plugin's C++ read for roots and limits, the three stand-ins in a browser (desktop and 390 px).

## Scan 155 (2026-11-18): music track, Godot moves while open, projects menu, chat report resume, idle model
- **Music track** (`/files/cut` with `music`): the file must be in the same chat's folder (`resolveInWorkspace`) and
  a sound file; every number is clamped in `musicGraph` (start, volume 0–1.5, fades ≤ half the length) and written as
  fixed decimals, so nothing from the page reaches FFmpeg's filter text but numbers. `video.addSound` takes only a
  sound file name and at most 200 MB, into the chat's `shared/`.
- **Godot open** (`standin_moves`): the addon changes only nodes of the scene it was asked for (a `res://….tscn`), in
  the open editor, as one undo action, and only `transform` / `position` / `rotation` / `scale`; a node that moved
  in Godot is left (clash).
- **Projects menu**: from the phone, the scene routes (`/api/godot/scene(s)`, `/api/godot/asset`, the Unity ones)
  answer only for a project found on this computer (**fixed in this scan**: a folder typed by path was accepted from
  the phone); the page hides the typed folder there too. The + menu's projects were already checked the same way.
- **Chat reports**: the parts read are kept beside the report (`notes.json`) and the imported text (`import.txt`),
  both in KesherAI's own data folder, removed with the report; resume runs only reports that were being written.
  The long read's quotes are checked against the chat like every other quote; the page shows them as text.
- **Idle model**: a model unloaded for being unused stays unloaded after a restart (no card filled by itself).
- **P3-SAM**: lighter settings (fewer points), and only flags its own script knows.
- Checked: lint, typecheck, tests (video-cut, godot-scene with the addon path, game-projects with Godot, chat-report 16,
  chat-report-text), a real FFmpeg run of the music track, the video editor in a browser (desktop and 390 px).

## Scan 156 (2026-11-18): the bank of everything made, the editors' Add, clips from other files in a cut
- **The bank** (`/api/bank…`, asset-bank.ts): guests cannot reach it (their key opens only `/api/guest/`). An item id
  is either `a.<uuid>` (the asset store) or `f.<chat uuid>.<path in base64url>`: the path must be a media file name,
  with no `..`, no empty part, no drive letter, inside that chat's folder (`relative` check), and code sessions'
  folders (projects) are never listed or served. `/api/bank/file` sends pictures, video and sound inline with
  `nosniff`, anything else (3D) as a download; SVG is not a bank kind. Delete is at most 500 ids, copy at most 50,
  into the target chat's `shared/` under a cleaned name that never overwrites. Tests: traversal ids, code chats,
  duplicates, copy, delete.
- **Duplicates**: only files of the same size are hashed (SHA-256, streamed), each once while its size and time stay;
  the look-alike check (dHash) runs in the page on at most 400 pictures.
- **The editors' Add** (`media.list` / `media.bytes` / `media.take` / `media.upload`): only plugins that declared
  `video`, `sound` or `model`; a chat file is read through the existing chat routes (inside the chat's folder), an
  upload is a media file name up to 300 MB into `shared/`. **`chat.ask`** (the 3D editor's "a model from words") shows
  the user the exact words and sends nothing unless she agrees, so a page cannot run the chat's tools on its own.
- **Clips in a cut** (`/files/cut` with `clips`): at most 20, each resolved inside the same chat's folder and a video
  or picture file; a segment may name only a clip that was sent (`checkSegments`). The frame size and rate come from
  FFmpeg's own report of the opened video (numbers only), so no page text reaches the filter graph.
- Checked: lint, typecheck, tests (asset-bank 4, video-cut +3, image-hash), a real FFmpeg cut of a video + another
  video without sound + a picture, cropped to 9:16; the three editors' Add in a browser (desktop and 390 px).

## Scan 157 (2026-11-18): dialogs, the fade, the bank's "edit in", the engine's reason, routines and the card
- **The app's own confirm** (`askConfirm`): built from DOM nodes with `textContent` (a chat's title is never HTML);
  Escape / outside / Cancel give no. The chat menu's Delete now asks first (it deleted at once).
- **Fade between clips**: the route clamps it to 0–1 s, `cutArgs` again to a third of each stretch, written as fixed
  decimals; no page text reaches the filter.
- **The bridge's `video.cut`** passes `clips` (checked by the route: inside the chat's folder, a video or picture, at
  most 20) and `fade` (a number).
- **Bank "edit in"**: a chat file's path comes back from the bank id and the editor page reads it through the chat's own
  routes (inside its folder); a generated file is copied first (`/api/bank/copy`, as scan 156).
- **Engine reason**: the chat titles named in the engine's log are the library's own, at most two.
- **Routines and the card**: a background or start-up routine also waits while the card is ≥ 60 % busy with none of
  our work running (no new access: the guard's own nvidia-smi reading).
- **Semgrep** (CI): the two `openExternal` calls now check the address where they are called (http(s) or Stremio's
  own links), as the rule asks; the rule was failing on every push.
- Checked: lint, typecheck, tests (video-cut 12, gpu-guard 7, chat-report 17, asset-bank 4), a real FFmpeg cut with a
  fade and an added clip.

## Scan 158 (2026-11-19): P3-SAM's runner, the full report again, sound tracks, 3D pictures, small tasks
- **P3-SAM**: the runner (our own fixed text) is written to the engine's own folder before each split; the mesh and
  its results stay in a per-run work folder that is removed after. `save_mid_res` writes more files there only.
  Checked on the PC: a chair in 16 s with the card at 3 GB (it had filled 24 GB and hung).
- **The full report again** (`/api/chat-reports/:id/full`): only for a finished report of this computer's own store;
  from its kept notes (`notes.json`, removed with the report), or read again from its own chat; one at a time per
  report (the running set). The chapters' quotes are checked against the chat as before. `storyChapters` parses only
  complete JSON objects (a cut-off one is left out), no eval.
- **Sound tracks**: in the page only (samples in memory); nothing new goes to the server.
- **3D pictures in the bank**: the model is loaded from the bank's own address; a .gltf's other addresses do not load
  (the same URL check as the viewer, scan 143); one hidden renderer; the model's memory is freed after its picture.
- **Small tasks** (M for music, Escape in the outliner, reading time, project count): text and numbers shown with
  React / `textContent`.
- **Self-work**: its branch was not merged (two items closed without changes, one too large); the four were done by
  hand and noted on the board.
- Checked: lint, typecheck, tests (chat-report 19, part-seg 4), the sound editor's tracks in a browser (desktop and
  390 px), P3-SAM and the bank on the PC.

## Scan 159 (2026-11-19): computer view on a phone, a script in your voice, text over the video, the bank's age
- **Computer view**: only the viewport meta and one attribute change; the choice is a word in localStorage; no data.
- **A script in your voice**: up to 10,000 characters; the arguments go to the Python through a JSON file in the
  engine's own folder (removed after), not the command line; the voice name is checked as before (letters, numbers,
  space, `_`, `-`); parts are our own cut of her text and reach the model as data. The recording kept in the bank is
  an `audio/wav` asset with her text (300 characters) as its description. Consent is unchanged.
- **Text over the video**: the words are drawn in the page (canvas) into a PNG uploaded to the chat's `shared/`; the
  route takes at most 30, each a `.png` resolved inside the chat's folder, with numeric start and end (start ≥ 0, end
  after it, at most 6 h); FFmpeg's graph gets only those numbers (fixed decimals) and input indexes — no text from the
  page reaches the filter.
- **Bank age filter**: in the page only.
- Performance: the text picture is cached per text and frame size; the voice model loads once per script.
- Checked: lint, typecheck, tests (video-cut 13, voice-clone 2), a real FFmpeg export with a clip, a fade, a text
  and a 9:16 shape; the editor's text in a browser (desktop and 390 px).

## Scan 160 (2026-11-19): clip speed and volume, words to picture / music in the editors, the image editor's place
- **Speed and volume**: checkSegments turns both into finite numbers in range (0.25–4, 0–2) and rounds them before
  they reach the filter graph; only `toFixed` digits go into it, so no text from the page enters ffmpeg's arguments.
- **Picture and music from words**: go through `chat.ask`, which asks the person first (confirm) and runs as a normal
  chat turn; the editor gets back only the path the chat made, read through `media.bytes` (inside the chat's folder).
- **Image editor**: `media.*` now also open to the `image` use. The same checks hold: ids are `chat:` paths resolved
  inside the chat's folder or bank ids (asset-bank.ts pathOf refuses `..`, absolute and drive paths, code sessions).
- No new routes, no new dependencies. Tests 951 pass; lint and typecheck clean. Nothing to fix.

## Scan 161 (2026-11-19): freeze frame, the clip's marks, rotate and flip pictures, reverse and speed in sound
- All five are in the editors' own pages: no new bridge methods, no new routes, no `innerHTML`, `eval` or `fetch`
  added (the diff has none). The freeze frame draws the editor's own video (a blob URL from bytes it already has) and
  uploads the PNG through the existing `media.upload` (the chat's folder only).
- Performance: rotate/flip allocate one canvas per layer (and mask) at the picture's size, as crop does; Undo keeps
  20 steps as before. Speed in sound is one linear pass over the selection per channel; Reverse is in place.
- The phone: the video editor's clip settings are reachable (⚙ Clip), and the sound editor's Speed and Reverse fit at
  390 px with no sideways scroll (checked in a headless browser).
- Nothing to fix.

## Scan 162 (2026-11-19): text and shapes in pictures, the video export's size and quality, echo, duplicate a clip
- **Export size and quality** (the one server change): `/files/cut` takes `size` only from EXPORT_HEIGHTS (480, 720,
  1080, 2160) and `quality` only from high / normal / small; anything else is dropped. Into FFmpeg go only those
  numbers (`scale=-2:'min(ih,720)'`, `-crf 17|20|27`); the bridge passes them only when they are a number / a string.
  A 4K export of a long video takes longer, but one cut runs at a time (scan 146) and a smaller size is never upscaled.
- **Text**: the words go to `fillText` on a canvas, never into the page as HTML; a project file's text is taken only
  when `value` is a string. **Shapes, echo, duplicate**: in the editors' pages, no new bridge methods.
- Performance: a text layer redraws only when changed; a shape's preview reuses one canvas per drag; echo is one pass.
- Tests: video-cut.test.ts gained the export's size and quality (16 pass). Nothing to fix.

## Scan 163 (2026-11-19): a picture and a turntable of a 3D view, save a video frame, picture size, a second of silence
- All in the editors' pages; the files they make go into the chat through the existing `media.upload` (the chat's
  folder, the server's own name checks), or download when there is no chat. No new bridge methods or routes.
- **Turntable**: MediaRecorder on the editor's own canvas (no camera or screen capture, no permission asked); 6 s at
  6 Mb/s is about 1–5 MB; it can run once at a time (`turning`), and the camera and helpers come back after.
- **Picture size**: clamped to 16–8192 px a side, as New; one canvas per layer and mask, as crop and rotate.
- **Silence**: one second per press, a copy of the channels (as cut). Nothing to fix.

## Scan 164 (2026-11-19): ✦ With AI in video and sound, transitions, turntable options, typing text on the picture
- **✦ With AI**: the editors ask the chat through `chat.ask`, which still shows the person the exact words and asks
  first; the prompt is cut to 600 characters in the page and 2000 at the bridge. The editors then only *read* the
  chat's file list every 10 s (for at most 20 minutes, one wait at a time per editor) and take a new file through
  `media.take` / `media.bytes` (inside the chat's folder). A picture comes from `image.generate` / `image.edit` as before.
- **Transitions** (the one server change): `/files/cut` takes `transition.kind` only from TRANSITIONS and its length
  only as a number clamped to 0.1–1.5 s; only those reach FFmpeg (`xfade=transition=<listed>:duration=<number>`). Each
  blend is at most half the clip it goes into; the dip is not added on top. Tests: video-cut.test.ts (17 pass).
- **Turntable at 1080p**: renders at 1920×1080 while recording, and gives back the view's size and pixel ratio after.
- **Text on the picture**: a textarea in the page; the words reach the picture only through `fillText`.
- Performance: the 10 s polls are one small list request each and stop when the file arrives or after 20 minutes.
  Nothing to fix.

## Scan 165 (2026-11-19): sound effects, animate a picture, a transition per cut, the bank in ✦ With AI's wait
- **make_sound** and **animate_picture** (new chat tools): both run ready flows whose files come only from the listed
  Hugging Face repos, and download nothing without the person's yes (`askFirst` as make_music and make_3d). The words
  are cut to 1000 characters; lengths are clamped (1–120 s; 1–5 s, 4n+1 frames). animate_picture reads its picture only
  inside the chat's folder (the same `relative(...).startsWith("..")` check as make_3d); `pictureSize` reads at most a
  JPEG's segment headers within the buffer (no loop past its end; unknown files give undefined).
- **A transition per cut**: `checkSegments` keeps a stretch's `into` only for "cut" or a listed kind, its length clamped
  to 0.1–1.5 s; nothing else from the page reaches FFmpeg. Tests: video-cut (18), comfy-flows, chat-tools-media pass.
- **✦ With AI's wait** now also lists the bank (`/api/bank`, the same route the editors' Add uses); still one wait at a
  time, every 10 s, for 20 minutes at most. Nothing to fix.

## Scan 166 (2026-11-19): a model from words, 3D with colours, painting a model, why a model loaded, a scene together
- **/files/model3d and /files/paint3d**: the picture or model must be inside the chat's folder (`relative(...)` check,
  and a .glb for painting); the words are cut (600); downloads only after `download: true` from a page that asked the
  person; one model at a time (shared lock); ComfyUI behind the same business-mode check as the chat's tools. The
  model goes to ComfyUI's input/3d through its own upload API (the subfolder is ours, "3d", never the page's).
- **TRELLIS.2 / paint flows**: files only from the listed Hugging Face repos (Comfy-Org, comfyanonymous); KesherAI's
  ComfyUI now reads clip_vision/ and background_removal/ inside the models folder (no other paths).
- **Why a model loaded**: a fixed set of kinds plus chat titles the server already holds; shown as text (React escapes).
- **Together** (/api/rooms/*): only keys that reach /api/ (this computer and paired devices; guests' keys open only
  /api/guest/); the room key is hashed from what KesherAI's page opened (the page cannot pick another place); the
  name is the device's; cameras are three finite numbers each, the field of view 1–179, at most 50 ids of 300
  characters; 12 people a room, 50 rooms, gone after 6 s of silence; a 32 KB body limit. In memory only.
- Performance: one small request a second per open scene; hidden tabs do not beat. Nothing to fix.

## Scan 167 (2026-11-20): Kesher Cloud hub, tasks through Google Drive, hub-report, prompt cache, PC Health, games
Scope: everything since scan 166 (54 commits): hub Worker routes and CSP, agent activity ring and catch-up, sync
pings, pairing of `claude-chat`; tasks sync (sealing, K, token handling, the app's token hand-off); hub-report; the
llama.cpp `id_slot` per kind; PC Health's project detection and drives; the Store-app game fix.
- **Fixed (medium): the token handed to the hub page was the app's full token.** cloud.html put the phone app's own
  Google access token (openid, email, profile, `drive.file` and `drive.appdata`) in the hub page's fragment. It now
  asks Google for a fresh token with `drive.appdata` alone (refresh with `scope`, added to the KesherGoogle plugin),
  and no longer overwrites the app's stored token with it. Test: apps/hub/src/app-token.test.ts. Needs a new APK;
  an older plugin ignores `scope` (same as before, no break).
- **Checked, fine:** fragment parsed then wiped at once with `replaceState` (before any other script; `location.replace`
  leaves no back entry); taken only with `?app=` = the app's localhost origin and an Android WebView user agent; kept in
  memory only, never logged or sent to the hub; CSP unchanged (self + accounts.google.com/gsi + googleapis). Sealing:
  AES-GCM per write (HKDF salt, random IV), AAD covers version, kid, id, kind, rev, deleted, done and writer; tombstones
  final; done runs never go back. PC state file 0600, write-then-rename; errors scrub Bearer/token text. Hub: `agents`
  frames ≤ `agentFrameEnvs`, per-run ring ≤ 50 events, 7-day prune, dropped on revoke and kill; `claude-chat` reports only
  (no relay, fixed opt-in); sync pings 1/5 s per device and not sent to `claude-chat`. hub-report: https only (or
  localhost), key file 600 in a 700 folder outside the repo. `id_slot` only with ≥ 3 slots. PC Health: deletes still only
  ids from the last scan; project files flagged and never kept-copy candidates. Store apps no longer count as games.
- **Left for the lead (low/medium, files another helper is editing):**
  - Medium (design): a task from Drive (`fromDrive`) is queued as `from: "roee"` and runs with the local/opus runners
    like a git inbox task; anyone with the Drive app-folder token (the hub page in a browser) can queue PC work. Same
    trust as the git inbox, but worth a "from another device" origin and, for risk ≥ medium, the PC's Run ask.
  - Low: tasks-sync.ts `saved.sent` / `saved.received` grow by one entry per inbox task forever (prune ids no longer in
    the inbox / older than KEEP_FINISHED_MS).
  - Low (perf): tasks-sync.ts `send()` runs `sync.records().some(...)` for every inbox task (O(tasks × records) each
    3 minutes); a Set of task ids built once per sync.
  - Low: `onPing` re-arms a 2 s timer on every ping, so steady pings < 2 s apart (several devices, or a bad hub) delay
    the pull; keep the earlier timer instead of replacing it.
  - Low: the hub keeps no total cap on agent-event rows (only per run and 7 days); a cap per sender would bound a
    misbehaving PC within the free plan's 100k writes a day.
- Performance otherwise: PC pulls every 3 min (backoff on errors), hub page every 60 s only while visible, Drive lists
  by changes feed after the first full list; agent snapshots at most every 5 min per run, 50 runs followed. Nothing else.

## Scan 168 (2026-11-20): hub Web Push, agent names and "who does it", games without the engine, Install button
Scope: everything since scan 167 (de70c8f..5c302ab, 0.6.406–0.6.410, 67 commits): hub Web Push (web-push.ts,
sw.js, subscriptions, VAPID), the sealed `agent-label` and `assign` commands, task-assign, Antigravity runs without
the busy gate (31dca4a), /api/games/* (Source view, checkpoints, inspector, search, sync), uasset.ts, Unity/Unreal
batch sync, offer_install and /api/installables, the tool router and per-chat tool switches, tasks-sync reconnect.
- **Fixed (medium): game checkpoints and the inspector followed links out of the project.** `insideProject` checked
  the path by its text only, so a link put in a project (a file, or a folder on the way) made a checkpoint restore
  write a kept file through it, a compare read (and show) a file outside up to 1 MB, a capture copy an outside file
  into the store, and the inspector read, queue and, at sync, write a `.prefab`/`.unity`/`.tscn`/`.tres` outside.
  New `realInside` (game-checkpoints.ts): the file is not a link and its nearest existing folder, links followed, is
  inside the project; used by capture (skips), restore (skips, counted), compare, the inspector routes and
  `ValueQueue.sync`. Blob ids from index.json must be sha256 hex. Tests: game-checkpoints.test.ts,
  routes/game-inspector.test.ts. (The Source view already used `projectPath`, which does the same.)
- **Fixed (low): a Source view save without `mtime` overwrote the file blindly.** The "changed since it was opened"
  check ran only when the page sent a time; an existing file now needs it (the page always sends it). Test:
  routes/game-source.test.ts.
- **Fixed (perf):** checkpoint pruning summed every kept content again for each dropped checkpoint (up to 2,000);
  now one pass with use counts. Searches typed while a big project's index is built share that one walk
  (game-index.ts). Tasks sync: state saves made while a write waits join it (Drive sync saves on every change); the
  file was already write-then-rename (0600), so "seen mid-write" was most likely its `.tmp` beside it. The Unity
  stand-in's `KesherAI/pending-moves.json` (read by the Unity package) is now written then renamed.
- **Checked, fine:** Web Push: endpoint https only, no port or user info, hosts limited to Google, Mozilla, Apple and
  Windows push services (subdomains), keys checked (65-byte uncompressed P-256, 16-byte auth); `redirect: "manual"`;
  payload is a count only, aes128gcm with a fresh ECDH key per message; VAPID private key a Worker secret, never in
  git (tools/hub-vapid.mjs prints it); one sub per paired phone-kind device, dropped on 404/410, on unpair and on
  revoke; ≤ 1 push per 30 s per device. sw.js opens only same-origin paths (`//host` refused), caches nothing.
  Commands `agent-label` and `assign`: sealed, opened with the sender's paired key, acted on only when the sender is a
  phone-kind device (the owner's app or hub page); targets parsed against a fixed list; PC answers are the truth.
  Scan 167's guard holds: a Drive task (`fromDrive`) is still queued only for Antigravity (waits for Run) or Opus; it
  reaches the local model only by an explicit `assign` from the owner's paired device or the PC app; a running or
  finished task changes hands only with `confirm`. 31dca4a: Antigravity still starts only from the user's Run (PC or
  phone answer), within the daily cap; only the busy gate was removed. Source view: `projectPath` (real path), code
  folders and code extensions only, hidden and engine-cache folders refused, 400 KB, old text kept in KesherAI's
  folder. uasset.ts: every count capped (names 500k, tables 200k, tags 2000×5000, strings 1 MB), every read bounded
  by the bytes read (≤ 16 MB, the index ≤ 2 MB), file handle closed in `finally`, never throws. Unity batch sync:
  commands through a JSON file in the data folder, `spawn` without a shell. Install button: ids from a fixed list,
  the app's own installers and folders, the chat-continue text is fixed by the page (not the model), at most 300
  characters, to an existing chat. Tool switches: `toolsOff` validated (≤ 64 short ids) and tools removed from the
  chat's list, not only from routing. Privacy: no email, Windows user name or user folder in the new commits
  (test paths use `C:\Users\u` and `/home/someone`); tools/design/out is gitignored and has no tracked files.
- **Open (left for the lead):**
  - Low (privacy wording): docs/WORK_LIST.md line 112 names a folder on Roee's PC (`E:\LMStudio\models`). No user name
    or email, but "the heavy-data drive" would say the same; the lead edits the work list.
  - Low (TOCTOU): the real-path checks run just before the write; a link swapped in between by a local process could
    still redirect one write. Same as the Unreal/Unity source routes; opening with `O_NOFOLLOW` is not portable to
    Windows.
  - Low: game-source backups (`game-backups/<engine>`) are never pruned (one copy per save).
  - Low (perf): the hub page is ~300 KB of unminified ES modules in ~30 files (a module import waterfall on a phone);
    a bundle/minify step in the hub build would cut it to well under 100 KB gzipped.
  - Low (perf): `withUnrealKinds` stats every .uasset on each index rebuild (every 15 s while searching); fine to
    ~50k packages, a folder-time cache would avoid it.
  - Carried from 167: the hub keeps no total cap on agent-event rows (per run and 7 days only). FIXED: `agentEventsTotal` (2000 rows), oldest evicted first (`capAgentEvents`).
- Performance otherwise: checkpoint copies stream (hash while copying, no buffering), ≤ 2 GB a file, store pruned
  after every capture; uasset reads 16 KB first and the rest only to the header's end.

## Scan 169 (2026-11-21): the hub as a Claude connector (OAuth 2.1), browser and computer control, vision models
Scope: everything since scan 168 (5c302ab..99a51d5, 0.6.411–0.6.414 and the hub connector 99a51d5, not pushed yet;
pushing `main` deploys the hub): oauth.ts, connector.ts, mcp.ts, /connect, the store's OAuth tables; cdp.ts, the
browser bridge and extension CDP, control policy/gate/reviewer, UIA worker and scripts, vision models (downloads,
service, llama.cpp slot), quick actions (`runDirect`), canvas/design rendering, resume.json, the draw-change
screenshot route, `tool_output`, Unreal level tools, GIF recording.
- **Fixed (medium): a full connector client table locked the owner out for a day.** Registering is open (5 a minute
  per IP); when the 50 slots are full, unused registrations older than 10 minutes are dropped first (0e492d0).
- **Fixed (medium): browser and computer control could drive KesherAI itself.** KesherAI's port is refused on any
  host name (`x.localhost` reached it as a local, token-free request), the extension also checks `pendingUrl`,
  `Page.navigate` and in-page actions; KesherAI's own window can be looked at, never clicked or typed in, so a model
  cannot press Approve on its own card (3d5f384).
- **Fixed (low): vision model files and Unreal level paths could leave their folders** (a repo name with `\` or
  `..`; a level path with `..`) (bc462b5).
- **Fixed (low): two refreshes with the same refresh token at once gave two live token pairs.** The hashing awaits
  between the read and the write; the grant is now checked again right before the write (one wins, the other gets
  `invalid_grant`). Test: connector.test.ts.
- **Fixed (low): `/mcp` had no limit before the token lookup** (a flood cost SQL reads); 120 a minute per caller IP.
- **Fixed (low, consent phishing): the approval page did not warn about shared links.** Someone can add the owner's
  hub as a connector in their own Claude and send the `/oauth/authorize` link; if Claude's callback accepted the code
  in another session, their Claude would reach the hub. /connect now says to approve only a Connect the owner just
  pressed (the loopback warning was already there).
- **Fixed (perf): GIF recording held every decoded frame** (120 × 800 × 800 RGBA, ~300 MB); frames are decoded one at
  a time and the output is joined in chunks (8a0c242). Test: gif.test.ts.
- **Checked, fine (connector):** PKCE S256 only (43–128 chars, verifier checked at the token endpoint), plain and
  missing refused; redirect URIs only Claude's two hosted callbacks or loopback `http://localhost|127.0.0.1:*/callback`
  (no query, user info or fragment), exact match except the loopback port (RFC 8252); unknown client or redirect shown
  on the hub, never redirected; `state` passed back unchanged (≤ 500); `iss` added; `resource` must be this hub's
  `/mcp` (RFC 8707), tokens are opaque and only `/mcp` accepts them. Codes: 32 random bytes, hashed, 1 minute, taken
  (deleted) before any check, bound to client, redirect and challenge. Refresh: rotates every use, the previous token
  coming back ends the connection, 30 days, 90 days per approval; access 1 hour; only hashes kept; at most 10
  connections (the oldest ends); revoke and "disconnect everything" end tokens at once (the kill switch too).
  Approval: `/api/oauth/check|decide` need the owner's session cookie (only the pinned `ALLOWED_EMAIL` account can
  sign in) and the same Origin; /connect has `frame-ancestors 'none'` and `X-Frame-Options: DENY`, no-referrer, a
  separate small script, and navigates only to https or loopback. `/mcp`: POST only, a foreign Origin refused (DNS
  rebinding), body ≤ 20 KB, protocol version checked, tools/call writes the tool name only to the log, paused hub
  refuses. Read tools give metadata only (device names, presence, agent labels, waiting counts, task ids);
  `send_task` text lives in memory for the call only, sealed with the hub's own key (the key the Claude cloud path
  already used: no new trust) to one PC that opted in to that kind of task, 30 an hour per connection; the PC still
  checks its own opt-in, Antigravity waits for Run. E2E for device-to-device messages is unchanged (the hub opens
  nothing new; PC answers to the hub are dropped unopened).
- **Checked, fine (rest):** UIA: requests go as JSON lines on stdin (no text in PowerShell commands), the release
  one-shot takes numbers only, the script file is random-named 0600 and deleted after parsing, an elevated worker
  exits. llama.cpp (and the vision slot) listens on 127.0.0.1 with a per-start key; the vision slot unloads when idle;
  downloads from Hugging Face through the download manager with sha256 when listed. Quick actions: an allow-list of
  tools and inputs (`quickActionProblem`), `runDirect` goes through the normal `execute` (approvals apply), refuses a
  busy chat. `tool_output` reads only the current chat's own messages, ≤ OPEN_CHARS a call. resume.json: items
  validated (`isResumeItem`, links `#/` only, ≤ 40), written then renamed. Draw-change screenshot: the whole screen
  only for a local request (`isLocalRequest`: loopback, no forwarding headers, own host name); from the phone only the
  engine's own view. No new HTML sinks (`innerHTML`, `srcDoc`) in the web or plugin changes; SVG is served only from
  plugins' own files. CDP: console and network kept to 300 each, response bodies only on request and redacted.
  Privacy: no email, Windows user name or personal path in the new commits (tests use `/home/u`).
- **Open (left for the lead):**
  - Low: registering a client stays open; a spread-out attacker can keep the 50 slots full (owner sees "try again in
    a few minutes"). The approval itself is safe; a per-IP cap on live registrations would narrow it.
  - Low: a code used twice does not end the tokens it gave (OAuth 2.1 SHOULD). Codes live 1 minute and are taken
    on first use, so a second use only fails.
  - Low: the hub's audit log is pruned by age only; connector tool calls (owner) and registrations (anyone, 5 a
    minute per IP) each add a row. A row cap like `agentEventsTotal` would bound it.
  - Low (perf): a browser recording keeps up to 300 PNG frames (800 px) in memory until it ends, tens of MB at worst;
    JPEG frames or thinning while recording would cut it.
  - Carried from 168: TOCTOU on real-path checks, game-source backups never pruned, hub page unbundled.
- Verdict: the connector is safe to deploy with these fixes (main pushes the hub).

## Threat note (2026-11-21): "Allow replies" in shared chats (pending for the next scan)

Guests of a shared project (their existing invite key, `project:<id>:edit`) can write in an owner's chat when its
share has replies on (`packages/core/src/shared-chat.ts`, `routes/shared-chat.ts`). What was built against each threat:
- **A guest steering the owner's tools.** A guest turn gets no tools; with "guests may use tools" every action is
  gated `ask` + `noAlways` (a tool's own gate can only deny), `delegate`/`offer_install` are left out, the smart
  reviewer never runs (it skips gated tools). The rule lives in `toolsFor`, so a model change mid-turn keeps it; a
  resumed turn that a guest started resumes with no tools. Guest messages never steer a running owner turn.
- **Header injection.** `[Attached: …]` would read a file from this computer, `[Unity/Unreal project: …]` opens a
  project, `[Guest: …]` would impersonate; any `[x:` in guest text becomes `(x:` and `@helper` loses its `@`.
- **Leaks to guests.** The live route sends only user/assistant text and the streaming answer, through
  `cleanForShare` (paths, keys); approval cards, questions, tool steps and notes never go out.
- **Abuse.** Per-guest messages a minute (2/6/12), the daily guest allowance, typing beats 1/s, 16 KB bodies, 4,000
  characters a message; mute, remove (key revoked) and delete-message for the owner; replies end with their own
  time, the share's expiry, "off" or revoking the share, checked on every request.
- **To review next scan:** (1) prompt injection through a guest's words is only softened by a system note: with
  tools on, the owner's approval card is the real guard; check the card shows "a guest asked" clearly. (2) The owner's
  memory and system prompt still go into a guest turn (the model is told not to share them); consider leaving memory
  out of guest turns. (3) `ChatLive` follows a session with one listener per server life; sessions closed and reopened
  get a new one (WeakSet), check nothing piles up. (4) Owner routes rely on the auth hook (guest keys reach only
  `/api/guest/*`); a route test covers the PUT. (5) The removed message's words stay in older saved branches/exports.
