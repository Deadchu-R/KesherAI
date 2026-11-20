# Browser and computer control: how others do it, and the plan for KesherAI

Written 2026-11-20 (night) by a research helper. Replaces inbox task c-20261120-01. Roee's ask: the chat and its helper
agents control and DEBUG a web browser (his own Chrome through an extension, and KesherAI's built-in Electron browser)
and control the whole computer (Windows first) end to end, like Claude does, with an approval per action for helpers.
The short version is in [RESEARCH_LOG.md](../RESEARCH_LOG.md) ("Browser and computer control (2026-11-20 night)").
Sources are listed at the end; "(estimate)" or "(not verified)" marks what is not from a primary page.

## 1. What KesherAI already has (read from the code, 2026-11-20)

| Part | Where | What it does today | Gap |
| --- | --- | --- | --- |
| Browser bridge | `packages/core/src/browser-bridge.ts` | One `BrowserBridge`: the pane handler (preferred) or the extension WebSocket. Tools `browser_tabs/read/screenshot/open/click/type`. Site scope `site:host` for "always allow". 60 s command timeout, abort signal. | No console, network, JS, wait, scroll, keys, select, back, close tab, dialogs, element/full-page shots, coordinate click. No action log. Page text goes to the model as plain tool output (no "untrusted" marking). |
| Pane | `apps/desktop/src/browser-pane.ts` | Electron `WebContentsView` per tab, `persist:kesher-browser` partition, no preload, sandboxed; `paneAllows` refuses KesherAI's own port; downloads, camera, mic, location refused. Phone view: `/api/browser/pane`, `/pane/shot`, `/pane/page`, tap. | Reads the page by injecting `page.js` (`readPage` numbers up to N visible links/buttons/inputs with `data-kesher-ref`). No accessibility tree, no iframes/shadow DOM, refs die on re-render, no CDP at all. |
| Extension | `apps/browser-extension/` (MV3, v0.2.6) | WebSocket to `127.0.0.1:/api/browser/connect?key=`; permissions `tabs, scripting, storage, alarms, sidePanel, activeTab`, `optional_host_permissions: <all_urls>`; asks per site in a popup window (`ensureSite`); never types in password fields; screenshot = `captureVisibleTab` (brings the tab to front). | Same limited commands; no console/network; Chrome only for these (Firefox build shares code). |
| Computer control | `packages/core/src/computer.ts` (1191 lines) | Off until Settings switch. `computer_use_app` (approval, per app per chat), screenshot, click, type, key, scroll, open_app, zoom, drag, `computer_batch`. PowerShell + user32 on Windows. App kinds: browsers view-only, terminals/file managers click-only, sensitive window titles refuse typing (he/en words). Stop button and Ctrl+Alt+Esc, action log (`/api/computer/status`), `watch()` for the phone. | Coordinates only (no UI Automation tree, so no "click this button by name", no background actions, no text of a native app). No wait / cursor_position / hold_key / middle / triple / mouse_down-up / clipboard / window list or move. PowerShell per call is slow (an `Add-Type` each time). |
| Remote desktop | `remote-desktop.ts` | The person (not the model) drives the PC from the phone: PIN (scrypt), one session, banner. | Fine; keep separate from model control. |
| Helpers | `delegate.ts` | `HANDS = /^(browser_|computer_)/`; roles: research reads pages, build also click/type, operate gets all; helper risk table makes every acting call ask on the chat's card naming the helper (`ctl.update({approval})`, `HelperApproval.helper`); "Always" per helper tool or per site. | Card text is only the tool preview (`Click element 7 in tab in front`): no element label, no site, no picture. No cross-origin rule. No stop-all for browser. |
| Tool router | `chat-tool-groups.ts` | Groups `browser` (`/^(browser_\|web_click$\|fab_)/`) and `computer` (`/^computer_/`) with Hebrew/English words. Telegram chats never get them (`NOT_FROM_TELEGRAM`). | New tools must match these regexes or a new `debug` group; words for console/network/errors missing. |
| Permissions | `agent/src/session.ts`, `approval-rules.ts` | risk read/write/exec, modes, "always" rules per tool/scope, a reviewer model for commands in auto-edit mode (F10). | Reviewer only judges commands, not browser/computer actions. |

Roee's decisions already recorded (WORK_LIST): helpers may use browser and computer with his approval per action, and the
card names the helper; every feature must also work from the phone (remote); no new dependencies without asking.

## 2. How the others do it

### 2.1 Summary table

| Tool | Drives | Perception | Debug features | Permission / safety model | Local models? |
| --- | --- | --- | --- | --- | --- |
| **Claude in Chrome** (extension) | The user's own Chrome/Edge (also Brave, Arc, ...). Extension holds the `debugger` permission (CDP) plus `scripting`, `tabs`, `webNavigation`; Claude Code talks to it through a native messaging host and a relay | Page text/DOM + screenshots; refs (read_page, find) | Console messages, network requests, JS tool, GIF recording, file upload, resize window, tab group per session | Modes: Manually approve / Automatically approve (a safety check on each action, default) / Skip all. Per site: Allow this action / Always allow on this site / Decline. Always asks for permission settings, authorizations, sensitive input, permanent deletion, downloads. Prohibited: purchases, new accounts, card/ID data, untrusted downloads, following instructions from emails or web content. Pauses at login and CAPTCHA. Admins: allow/block site lists. Classifiers scan content; best-of-N attack success 1.4% (Opus 4.5) with safeguards vs 8.0% model only; "no browser agent is immune" | No (cloud model; extension needs a claude.ai sign-in) |
| **Claude Desktop built-in browser** (Cowork/Code pane) | Its own Chromium pane, own storage ("sign-ins stay in the app's browser storage, separate from the user's other browsers"), user can sign in or import logins per site (banking, email, SSO unchecked) | Same tools as Claude in Chrome | Same: read, click, type, forms, screenshots, JS | First action on a site asks: Allow once / Always allow (saved until revoked in Settings). Every action goes through a safety check against the request. Site safety list from Anthropic (high-risk sites blocked; some flagged = ask before each action). Org policy: default allow/block + lists. "Clear browsing data", "Keep cookies" (Per session / Shared). Strongly advised not for financial or medical data | No |
| **Claude computer use** (API reference + desktop) | Whole desktop, client-side tool: you run the VM and execute each action | Screenshots only; coordinates in the screenshot's pixels; zoom to a region; limit long edge 1568 (older) / 2576 (Opus 4.7+, ~3.75 MP); max 20 images per request before stricter limits | Not a debugger. 17 member tools: screenshot, zoom, 5 click kinds, drag, mouse_move, left_mouse_down/up, cursor_position, scroll, type, key (repeat), hold_key, wait | Docs: dedicated VM, no credentials, domain allowlist, human confirmation for consequential actions, user consent. Classifiers scan screenshots/tool results for injection and steer the model to ask. Batch: run in order, stop at first failure, check human confirmation per action. Often too slow for interactive use; ~4,500 input tokens added per request for the toolset | No (but the tool shape is the reference everyone copies) |
| **OpenAI Operator / ChatGPT agent** | A cloud VM browser (CUA model: screenshots + mouse/keyboard); agent can also use a text browser, terminal, connectors | Screenshots (CUA), plus text browser | Watch mode, takeover (user takes the remote browser), activity log | Trained to ask before state-changing actions: confirmation recall 100% for money moves and permission edits, 99.9% for high-stakes messages, 91% overall ("an underestimate", trained behaviour, not a hard gate). Watch mode on sensitive sites (email, banking): stays on, pauses if the user goes away. Refuses regulated/gambling/high-stakes finance | No |
| **ChatGPT Atlas** (agent mode; page says it has since been deprecated) | The user's browser (Chromium); logged-in or logged-out mode | Page content | Per-site "ChatGPT can see this site" toggle, clear history, incognito | Cannot run code in the browser, download files, install extensions, access other apps or the file system. Pauses on sensitive sites (banks). Logged-out mode limits the damage. Browser memories optional | No |
| **Codex Chrome extension** (May 2026) | The user's signed-in Chrome | (page not readable by this helper) | - | (not verified: official page could not be fetched; press coverage says it works in signed-in sessions) | No |
| **Gemini in Chrome auto browse** (successor of Project Mariner) | Chrome itself, in a tab that shows an agent icon | Chrome's page content; origin-gated | Work log of steps; history marks actions | Plan shown, "Start Task". Confirms before sends, data changes, form submits, scheduling, sensitive finance/health sites; the user takes over for payments, terms, account creation; asks before Password Manager sign-in (model never sees passwords). Architecture (Google, Dec 2025): a separate **User Alignment Critic** model vets every action seeing only metadata (not page content); **Agent Origin Sets** (read-only vs read-writable origins; data may flow only from readable to writable; new-origin navigation vetted); prompt-injection classifier runs in parallel; deterministic sensitive-site list; spotlighting | No (Gemini only; US, paid plan) |
| **Antigravity browser subagent** | The user's Chrome 144+ through the **Chrome DevTools MCP** server started by `npx`; remote debugging enabled at `chrome://inspect/#remote-debugging`, "Allow" within 60 s | Accessibility snapshot + screenshots | Console, network, performance traces, Lighthouse, screenshots, optional WebM recording | "Browser Actuation Rules": allow/deny list for opening URLs and downloads; JavaScript execution policy: request review (default) / always / disabled; one session at a time | Model is Gemini/Claude/etc. via the IDE |
| **Perplexity Comet** | A Chromium browser with an assistant sidebar that acts with the user's signed-in privileges | Page text and screenshots (OCR) | - | Weak: Brave and Trail of Bits showed indirect injection (hidden text on a page, near-invisible text in screenshots, fake CAPTCHAs/"validators", fake system and user messages) that leaked Gmail content. Their advice: isolate agentic browsing from normal browsing, require explicit user initiation, separate trust levels for system / user / external content, least privilege, red-team | Cloud |
| **Browser Use** (MIT, Python) | A real Chrome through raw CDP (own browser, user's Chrome with a profile, or cloud) | The model writes Python in a REPL over CDP helpers; accessibility-tree element ids in a fast mode; screenshots for the judge | Orange highlights on clicked elements; run judge | `sensitive_data` is not a sandbox; domain restrictions are "a guard for an aligned model, not a sandbox"; opens an unauthenticated debug port on 127.0.0.1 (other local users can attach) | Yes: any OpenAI-compatible server (Ollama) |
| **Playwright MCP** (Microsoft) | Playwright over CDP or its own browsers; **extension mode** attaches to the user's existing tabs/profile | **Accessibility snapshot with refs (`e5`)**, "not pixels"; optional `--caps=vision` adds coordinate tools | `browser_console_messages`, `browser_network_requests`, request detail, `browser_evaluate`, route mocking, storage, traces (caps) | Few built-in guards; persistent profile by default; tools that run arbitrary code are flagged | Yes (snapshot mode works with text-only models) |
| **Chrome DevTools MCP** (Google) | CDP: launches Chrome, or `--browserUrl`, or `--autoConnect` to a running Chrome 144+ (opt-in toggle + a permission prompt each time + banner "controlled by automated test software") | `take_snapshot` (a11y tree with uids), `take_screenshot` | 57 tools: input (10), navigation (6), emulation, performance traces + insights, network list/detail, console list/detail, evaluate_script, Lighthouse, heap snapshots (flag), screencast (flag), `--slim` mode = 3 tools; `--redactNetworkHeaders`; usage statistics on by default | Docs: connecting to a live session gives access to logged-in accounts and cookies: "only with agents you trust" | Yes (any MCP client) |
| **Stagehand** (Browserbase) | One CDP connection (local Chrome or cloud) | Hybrid accessibility tree (merges semantics with interactive DOM, pierces shadow DOM) | act / extract / observe / agent; action cache replayed with no LLM call, self-heals by diffing trees | "The AI never directly controls the browser": deterministic layer in between | Yes (any provider; license not verified) |
| **Skyvern** (AGPL-3.0 core) | Browser tasks and workflows; vision LLMs rather than selectors | Screenshots + (DOM not described) | Workflow runs with UI | Anti-bot only in cloud | Ollama / OpenAI-compatible |
| **Microsoft UFO2** (Desktop AgentOS, Windows) | Windows apps: HostAgent splits tasks and launches apps; AppAgent per app | **UIA tree + OmniParser-v2 vision**, merged (visual boxes overlapping a UIA control by IoU > 10% are dropped); **Puppeteer**: native/COM APIs (12 for Word/Excel/PowerPoint) with GUI as fallback; speculative multi-action (one call predicts several steps, each checked against UIA state; up to 51.5% less inference cost) | Markdown logs with replay, LLM judge | PENDING state before risky actions (deleting files, closing unsaved apps), prompt-defined criteria; runs in an isolated Picture-in-Picture desktop (RDP loopback). 62% of failures of the base variant: controls it could not detect (weak accessibility, e.g. LibreOffice) | Any |
| **UI-TARS-1.5-7B** (ByteDance, Apache-2.0) | Pure screenshot agent (desktop/web/mobile), "UI-TARS-desktop" app | Screenshot only; outputs actions with coordinates | - | none built in | **Yes**: 8B weights, vLLM / SGLang / quantised GGUF for Ollama and LM Studio; OSWorld 27.5 (7B) vs 42.5 for the full model (research access only); ScreenSpot-Pro 49.6 |
| **Fara-7B / Fara1.5** (Microsoft, MIT) | Browser agent, screenshots only (no a11y tree); runs through Playwright / Magentic-UI | Screenshots | Auditable action logging via Magentic-UI | Trained to stop at "critical points" (personal data, purchases, sending email, sign-in); sandbox recommended; English only; research preview | **Yes**: 7B (community GGUFs); Fara1.5 4B / 9B / 27B; WebVoyager 73.5 |
| **OmniParser v2** (Microsoft) | Not an agent: turns a screenshot into a list of interactable boxes + captions so any LLM can pick one | Screenshot -> structured elements; 60% lower caption latency than v1 | - | none | **Yes**. Licences per folder: icon_detect (YOLOv8) AGPL-3.0, icon_caption (Florence-2) MIT, icon_detect_v3 MIT, so v3 + caption is all MIT |
| **Qwen3-VL** (Alibaba) | A general vision-language model with GUI/agent training (OSWorld "top performance" per Ollama page) | Screenshots, tool calling | - | none | **Yes**: Ollama tags 2b 1.9 GB, 4b 3.3 GB, 8b 6.1 GB, 30b 20 GB, 32b 21 GB (disk); needs Ollama 0.12.7+ |

### 2.2 The five architectures, and what each costs

1. **CDP through an extension (`chrome.debugger`)**: Claude in Chrome. Full DevTools (DOM, a11y, Network, Runtime, Page, Input) inside the user's real, signed-in browser with the browser enforcing per-site host permissions. Costs: the `debugger` permission is scary and Chrome shows a "started debugging this browser" bar; one debugger per tab and opening DevTools on that tab detaches (`onDetach: canceled_by_user`); only listed CDP domains are allowed; MV3 service workers sleep (Claude's docs list "connection drops during long sessions"). Needs an install and a store review.
2. **CDP to a browser you launch or the app embeds**: Playwright, Browser Use, Stagehand, DevTools MCP, and KesherAI's pane (Electron `webContents.debugger` is "an alternate transport for Chrome's remote debugging protocol": `attach`, `sendCommand`, `message` events). Same commands as 1, no banner, no extension, own profile (safe by isolation). Costs: it is not the user's browser; sign-ins must be done once in the pane.
3. **CDP to the user's running Chrome without an extension**: DevTools MCP `--autoConnect`, Antigravity. Chrome 144+: user turns on `chrome://inspect/#remote-debugging`, then approves each connection in a prompt; a banner shows. Whole-browser access (all tabs, cookies), so per-site limits must be KesherAI's own. Since Chrome 136 `--remote-debugging-port` is ignored on the default profile (a separate user-data-dir is needed), which pushes everyone to this prompt flow or to extensions (Chrome blog, "Changes to remote debugging switches").
4. **Screenshots + coordinates**: computer use, Operator, UI-TARS, Fara. Works on anything (games, Unity, Unreal, canvas), needs a vision model, slow, error-prone ("can misplace coordinates or hallucinate"), most exposed to injection through the picture itself (Brave's near-invisible text in screenshots).
5. **Accessibility tree + refs (text)**: Playwright MCP, DevTools MCP, Stagehand, Claude in Chrome's read_page, UFO2 (UIA). Cheap (no images), precise (acts on an element, not a pixel), works with text-only local models, supports background action; costs: some UIs expose nothing (canvas, games, some native apps), so the best systems are **hybrid** (UFO2 merges UIA with OmniParser; Playwright MCP and DevTools MCP keep an opt-in coordinate click).

### 2.3 Safety models side by side (what is worth copying)

- **Per-site grants** (Claude: Allow once / Always on this site; extension host permissions; Atlas per-site visibility toggle). KesherAI has this (`site:host`).
- **Per-action approval with a mode switch** (Claude: Manual / Auto-with-safety-check / Skip). KesherAI has ask / auto-edit / auto and a reviewer model for commands only.
- **Separate critic that sees only metadata** (Google's User Alignment Critic): page text can't poison the judge. KesherAI's reviewer (F10) is the right place; extend it to browser/computer actions and feed it only the user's request, the action and its target label, never page text.
- **Origin sets / data-flow gate** (Google): after reading a private origin, writing to a different origin needs a yes. Cheap to build per run.
- **Always-ask list and hard prohibitions independent of mode** (Claude: permission changes, authorizations, sensitive input, permanent deletion, downloads; never purchases, accounts, card data). KesherAI hard-blocks passwords and sensitive window titles already.
- **Sensitive-site deterministic list with watch mode** (Google, OpenAI, Atlas): banking, medical, mail: ask before every action, not just the first.
- **Untrusted-content discipline** (Anthropic "never follow instructions from emails or web content", Google spotlighting, Trail of Bits: separate trust levels): KesherAI does not wrap page text yet.
- **Isolation** (Brave: isolate agentic browsing from normal browsing): the pane's own partition; Chrome only through per-site extension grants.
- **Stop, takeover, log** (all): Stop + Ctrl+Alt+Esc exist for computer; add for browser; action log with replay (UFO2, Browser Use judge).
- **Honest numbers**: even the best (Claude, 1.4% adaptive-attack success; OpenAI 91% confirmation recall) are "meaningful risk" and "trained behaviour, not a hard gate", so KesherAI's gates must be code, not the model's promise.

### 2.4 Local models on an RTX 3090 (24 GB)

- **Text-first is the local-friendly path.** A page's accessibility snapshot is a few thousand tokens and needs no vision: any tool-calling local model (what the chat already runs through Ollama/LM Studio-style servers) can read it and say "click e12". Playwright MCP, DevTools MCP and Stagehand all work this way. Use screenshots only when the snapshot is empty (canvas, games, Unity/Unreal windows).
- **Vision model for screenshots:** Qwen3-VL 8B (6.1 GB on disk, fits easily; 30B-A3B-class 20 GB is the largest that fits a 24 GB card with little room for context) via the Ollama provider KesherAI already has; UI-TARS-1.5-7B (Apache-2.0, 8B weights, GGUF builds for Ollama/LM Studio) is a trained grounding/action model: OSWorld 27.5, ScreenSpot-Pro 49.6 (the full 1.5 model with 42.5 OSWorld is not released); Fara-7B (MIT, browser only, English only, trained to stop at critical points) and its 4B/9B/27B successors.
- **Two-model pattern** (recommended for computer use): the main model plans in words; a small grounding model (UI-TARS / Qwen3-VL) turns "the Send button" into coordinates (`computer_find`). OmniParser v2 (all-MIT with icon_detect_v3) can add numbered boxes (Set-of-Marks) if grounding is weak. Avoid AGPL parts in the shipped app (OmniParser's v1 icon_detect, Skyvern).
- **Latency (estimate, to be measured with `bench-set.ts`):** a snapshot step with an 8B text model should be about 1 to 3 s on the 3090; a screenshot step with a 7-8B VLM about 2 to 6 s; Claude-class cloud steps are similar or slower per Anthropic's own "often too slow for interactive use". UFO2's speculative multi-action (several actions per call, each re-checked against UIA state) cuts cost up to 51.5% and `computer_batch` already exists for this.
- **Reliability caution:** small local models follow injected text more readily and misplace clicks more; the policy must be stricter for them (approval per action on any signed-in site, no "Always" for local models on sites with sign-ins).

### 2.5 Windows: UI Automation facts that matter

- UIA is the framework Narrator uses; Chromium has had native UIA (no MSAA translation layer) by default since Chrome 138, so Chrome, Edge and Electron apps expose a usable tree faster than before.
- Real apps (Win32, WPF, WinUI, Office, Explorer) give names, control types, automation ids, rectangles and patterns (Invoke, Value, Toggle, ExpandCollapse, Scroll), so a model can say "invoke control 14" and the action works even when the window is behind another; no mouse movement.
- Games, Unity/Unreal editors (custom-drawn UI), LibreOffice and canvas apps expose little: UFO2's biggest failure class (62%). Fall back to screenshot + grounding.
- UIA from PowerShell (`System.Windows.Automation`) needs no extra software but costs a cold start; a persistent helper process speaking JSON lines avoids paying it per call (AGENTS.md: no new dependencies without asking, so PowerShell first; a tiny signed .NET helper would be a separate decision).

## 3. Decision

**One browser driver, two CDP transports, one safety layer, and a UIA-first computer layer with screenshot fallback.**

1. **Browser = CDP everywhere it can be.** Define `CdpTransport { send(method, params, sessionId?), on(event, fn) }` with two implementations: the pane's `webContents.debugger` and the extension's `chrome.debugger`. Put the recipes (accessibility snapshot, click by backend node id, type, wait, console and network ring buffers, screenshot, evaluate, emulate) in ONE shared module that both run (the extension already shares `page.js` with the pane the same way). Replace the injected `data-kesher-ref` reader by AX-tree refs (`Accessibility.getFullAXTree` + `DOM.resolveNode`, or `DOMSnapshot`); keep the old reader as the fallback for Firefox, which has no `chrome.debugger`.
2. **The user's Chrome: the extension stays the way in** (the user asked for it; per-site host permission is enforced by Chrome itself; no 60-second dev-toggle prompts). Add `debugger` as an **optional permission** requested at the first debug/snapshot use from a button in the popup (optional-permission support for `debugger` is believed to exist but is not verified here: check before building; otherwise ship it as a normal permission in a minor version and say why on the store page). Group the tabs it opens in a "KesherAI" tab group, attach lazily and detach after about 30 s idle, handle `canceled_by_user`. Chrome 144+ `autoConnect` is NOT built now (whole-browser access, prompt each time); keep it as a later "advanced" option.
3. **Built-in browser: the pane is the default target** (isolated profile, the user watches, works on the phone as pictures). New: a **Debug drawer** in the pane (Console, Network, Elements) driven by the same buffers the model reads, so the user and the model debug the same page; "Try my change" loop for web projects (open the dev server, read console errors, screenshot at 390 px and desktop).
4. **Debugging tools (model-facing, English descriptions; Hebrew/English UI):** `browser_snapshot` (replaces `browser_read`, kept as an alias), `browser_console` (filter by level/text, since navigation, max N), `browser_network` (list with filters, status >= 400) and `browser_network_request` (headers/body, cookies and authorization redacted by default, like DevTools MCP's `--redactNetworkHeaders`), `browser_eval` (JS: asks every time on non-local sites; policy setting request-review / always / off, like Antigravity), `browser_inspect` (element: computed styles, box, trimmed outerHTML), `browser_emulate` (viewport 390 px, mobile UA, offline, slow 3G), `browser_wait`, `browser_press_key`, `browser_scroll`, `browser_select`, `browser_back/forward/reload`, `browser_close_tab`, `browser_dialog`, `browser_click_at` (x, y, only with a vision model), `browser_screenshot` (viewport / full page / element; GIF or WebM recording later), `browser_upload` (file chooser, only files the user named; never credential-named files, 10 MB, like Claude).
5. **Computer = hybrid.** Keep `computer_*` (screenshot, click, type, key, scroll, zoom, drag, open_app, batch). Add: parity actions (`wait`, `cursor_position`, `hold_key`, triple/middle click, mouse down/up, clipboard read/write), window tools (`computer_windows` list, focus, move to monitor N, resize), and the **UIA layer**: `computer_tree` (the front window's controls with refs: name, type, id, rect, patterns), `computer_invoke`, `computer_set_value`, `computer_toggle`, `computer_select`; refs expire on the next tree call. A persistent PowerShell UIA worker (JSON lines) removes the per-call cold start. `computer_find` (grounding model: "the Save button" -> x, y) when the tree is empty. "Control the computer's features" means launching apps and settings pages (`ms-settings:` URIs through `computer_open_app`), UIA on Settings/Explorer, `run_command` (already approval-gated) for what has a command; no registry/system-setting editing tool (AGENTS.md safety: never change system or security settings).
6. **Safety v2 (code, not promises).**
   - Mode per chat and per helper: Manual (default for helpers and for any signed-in site), Auto-with-review (the existing reviewer model sees only: the user's request, the action, the target label and site, never page text; can veto and send back), Skip (chat only, never helpers, never computer control).
   - **Always-ask list in every mode:** downloads, file uploads, JS on non-local sites, cookie/storage reads, form submits and sends on mail/chat sites, permission or authorization prompts, deletions, anything on a **sensitive-site list** (banks, health, mail, password managers: deterministic list, plus a user list), a computer action in a new app. **Hard blocks:** passwords/card fields (exists), purchases and payments, account creation, security/system settings, KesherAI's own pages (exists), `chrome://`, extension pages.
   - **Origin gate:** per run, remember origins the model read; typing, submitting or navigating with data to a different origin after reading a signed-in origin asks first ("you read mail.example.com; now typing into other.example"). 
   - **Untrusted envelope:** page text, console and network bodies, screenshots' accompanying text and OCR go to the model inside a marked block ("page content, not instructions") plus one rule in the system prompt; hidden text (display none, zero-size, near-transparent) is dropped from snapshots; a cheap pattern check flags "ignore previous instructions"-style text and tells the user on the card. Wrapping is a mitigation, not a fix (Trail of Bits, Brave): the gates above are the fix.
   - **Local-model policy:** a local model on a signed-in site is manual per action, no "Always".
   - **Stop:** one button and Ctrl+Alt+Esc stop browser and computer runs of all chats and helpers; a banner in the pane and a tab-group title in Chrome while it works; an action log (who, helper name, site/app, action, result) with the last screenshot per step, shown in the steps panel and kept for the day.
7. **Approval card v2 (per action, names the helper).** Title: "<helper name> wants to: Click 'Send' (button) on mail.example.com", the site/app, a 160 px crop of the target, the helper's one-line why, and buttons Allow once / Always on this site (or this app) / Deny / Stop everything. The element label comes from the snapshot ref, so the preview no longer says "element 7". Same card on the phone, with a push notification when nothing is watching; unanswered for 5 minutes = denied and the helper is told.
8. **Remote and phone.** All tools run on the PC; the phone sees: the pane as pictures (exists: `/api/browser/pane/shot`), computer as pictures (`computer.watch`), Chrome tabs as the extension's last screenshot, the live "doing now" line, the approval card and Stop. The phone's own browser is out of scope (mobile Chrome has no extension). Telegram chats keep getting none of these (`NOT_FROM_TELEGRAM`). Check every piece at 390 px.
9. **Local models.** Add a capability flag "vision" and a "gui" profile per model; default snapshot-first; offer Qwen3-VL 8B as the screenshot model and UI-TARS-1.5-7B as the grounding model (download needs Roee's yes: about 6 GB each); bench 10 fixed tasks (5 pane, 5 Notepad/Explorer) in `bench-set` on the 3090 to replace the estimates above.

### What to leave out
Cloud browsers and CAPTCHA solving, anti-bot stealth (Skyvern cloud, Browser Use cloud), purchases and account creation, password-manager integration, browsing memory (Atlas), an agent sidebar in every page (Comet), Firefox CDP (BiDi later), mobile Chrome control, unattended background runs on the user's signed-in Chrome, "Skip all approvals" for helpers, Lighthouse and heap-snapshot tools (later if asked), DevTools MCP's extension-management and PWA tools, shipping AGPL parts (Skyvern, OmniParser v1 detector), a Python sidecar (Browser Use/Playwright Python), full-desktop continuous recording, running the agent in a hidden desktop (UFO2's PiP) for now.

## 4. Build plan (each phase one Opus task, checked in remote; tests only for what changed)

| Phase | Size | What | Checked by |
| --- | --- | --- | --- |
| 0. Quick safety wins on what exists | S | Untrusted envelope + system-prompt rule for browser results; element label in `preview` (from the last read); always-ask for upload/download/JS; browser action log and Stop covering the pane; "doing now" chip. | unit tests (browser-bridge.test.ts), Playwright check of the card text |
| 1. CDP core for the pane | M | `CdpTransport`, shared recipes, AX snapshot refs, console/network/error buffers, tools `browser_snapshot/console/network/network_request/eval/wait/press_key/scroll/select/back/forward/close_tab/dialog/click_at/screenshot(full,element)`. Keep `browser_read` alias. | Recipes tested against Playwright's Chromium CDP session (same send/on shape); pane wiring checked in the desktop build |
| 2. Extension CDP backend | M | `chrome.debugger` transport, optional permission flow in the popup, tab group, idle detach, reconnect, new version (0.3.0), Firefox stays on the old reader. | Chromium with the extension loaded in Playwright (persistent context), text/DOM checks |
| 3. Debug experience | M | Pane Debug drawer (Console / Network / Elements), `browser_inspect`, `browser_emulate`, "Try my change" loop (dev server -> console errors -> screenshots at 390 px and desktop), GIF/WebM recording into assets. | Playwright against a demo page with seeded errors |
| 4. Safety v2 | M | Modes, reviewer for browser/computer actions (metadata only), origin gate, sensitive-site list, JS policy, domain allow/deny lists in Settings, local-model policy, card v2 with crop, push when unwatched, 5-minute timeout = deny. | node:test for gates (pure functions), card checked at 390 px |
| 5. Windows UIA + computer parity | L | Persistent PowerShell UIA worker, `computer_tree/invoke/set_value/toggle/select/windows/find`, parity actions, clipboard, window move between monitors; hybrid fallback to screenshot. | `computer.test.ts` with a fake backend; one real run on the PC through KesherAI (Notepad, Settings) |
| 6. Local models | M | Vision/gui flags, Qwen3-VL 8B default screenshot model, UI-TARS grounder behind `computer_find`, bench 10 tasks, record latency in this log. | `bench-set` run on the 3090 |
| 7. Phone and polish | S | Chrome tab thumbnails, Stop and approvals on the phone, router words (below), docs. | 390 px Playwright, remote check |

Router words to add (`chat-tool-groups.ts`, browser group; a new `debug` group could hold console/network/inspect/emulate): Hebrew stems "קונסול", "שגיאות", "רשת", "בקשות", "דבג", "בדוק", "נסה", "עיצוב רספונסיבי", "סרגל", "צילום מסך", "הקלט"; English "console", "error", "network", "request", "debug", "inspect", "emulate", "mobile view", "record", "gif", "try my change". Computer group: "חלון", "הזז", "מסך שני", "הגדרות", "מקלדת", "לוח", "window", "move", "second monitor", "settings", "clipboard", "notepad".

## 5. Design boards needed (design doc first; each also at 390 px)
1. Browser pane with the Debug drawer (Console / Network / Elements), desktop and phone.
2. Approval card v2 for browser (site, element, crop, helper name) and for computer (app, window, crop), with Stop everything.
3. Settings > Browser and computer: mode, sites (allow/deny/always), sensitive-site list, JS policy, Chrome extension status and debugger permission, computer control switch and app list.
4. Controlling banner / activity bar ("Helper X is using mail.example.com" + Stop) in the pane, in the Chrome tab group title and on the phone.
5. Extension popup states (not connected, connected, needs debug permission, site not allowed).
6. Computer: "what the model sees" panel (UIA tree and the last screenshot) and window/monitor picker.
7. Action log / replay in the steps panel.

## 5b. Decisions taken by Claude overnight (2026-11-20): recommended, reversible
Roee was asleep; these were taken so Phases 0 and 1 could be built, and each can be changed later.
1. **Helpers on web sites ask per action.** A helper asks before every browser action on every site, whatever sites
   the chat allowed. "Always on this site" for helpers exists as a switch in Settings → Browser (`browserHelperAlways`),
   **off by default**; while it is off the helper's card shows no "Always" button and an "always" answer counts as once.
   (We cannot yet tell reliably which sites are signed in, so "every site" is the safe reading.)
2. **The reviewer / auto mode uses only the local model** (Phase 4): page-adjacent decisions never go to a cloud model.
3. **Windows UI Automation later through a persistent PowerShell worker** (Phase 5), no new software.
4. **The Chrome extension's `debugger` permission will be optional**, asked the first time a CDP tool needs it.
   Extension work is Phase 2, not now: the new CDP tools (snapshot refs, console, network, eval…) run in KesherAI's
   own pane only; with `browser: chrome` they say so and the extension keeps its six old commands.

### Built (2026-11-20 night)
- **Phase 0:** `browser-safety.ts` (untrusted envelope + pattern hint, action log, upload and header/body redaction
  rules), `UNTRUSTED_RULE` in the chat's and helpers' prompts, approval previews with the element label and site
  (`Click button "Send" (ref 3) on mail.example.com`), always-ask for `browser_eval` / `browser_upload` /
  `browser_download` in every mode, one Stop (`POST /api/browser/stop`, the pane's strip, Ctrl+Alt+Esc) that ends every
  browser command of the chat and its helpers and refuses new ones for 10 s, the pane's "doing now" strip and log
  (`GET /api/browser/activity`, desktop and phone). Downloads stay refused in the pane (stricter than asking).
- **Phase 1:** `cdp.ts` (`CdpTransport` + `CdpPage`: accessibility snapshot with refs `e1…` that die on the next
  snapshot or a navigation, click/hover/type/select/scroll/upload by ref, keys, click at a screenshot point, wait for
  text, back/forward/reload, pop-up answers, JS, console and network ring buffers of 300 with headers, secret body
  fields and secret address parameters hidden, screenshots of the view / whole page / one element in CSS pixels).
  The pane gives each tab's `webContents.debugger` to the bridge from the tab's first page (`PaneCdp` in
  `browser-pane.ts`); a tab whose DevTools the user opens loses it until they close. Tools (`browser-cdp-tools.ts`):
  `browser_snapshot/hover/select/scroll/press_key/click_at/wait/navigate/close_tab/console/network/network_request/
  dialog/eval/upload`; `browser_click/type/screenshot` take `e` refs and `full`/`ref`. The six old tools and
  `browser_read` stay (the Chrome extension keeps them until Phase 2). Checked with a fake CDP (`cdp.test.ts`,
  `browser-bridge.test.ts`) and against headless Chromium on a local fixture page (snapshot, type, password refusal,
  select, click, wait, console, network, eval, screenshots, scroll, confirm pop-up, upload). Not checked here: the
  Electron debugger inside the desktop app (needs the PC), and whether Electron also draws its own pop-up when CDP
  handles `Page.javascriptDialogOpening`.
- **Phase 2 (extension 0.3.0):** the same recipes drive the user's Chrome. The extension forwards raw CDP for one tab
  (`cdp-send`, `cdp-attach`, `cdp-detach-all`, `front`, `close`) and sends its events back (`cdp-event`,
  `cdp-detached`); `browser-ext-cdp.ts` turns that into a `CdpTransport`, and the bridge picks pane or Chrome per call
  (`cdpTarget`, `canCdp`, `cdpTabId`), so every CDP tool takes `browser: chrome`. `debugger` is an optional permission
  asked from a small window (`debug.html`) that explains Chrome's "started debugging" bar; Cancel on that bar is the
  app's Stop; Stop detaches every tab; idle tabs detach after 5 minutes; tabs go into a "KesherAI" tab group. The
  extension sends only Page/Runtime/Log/Network/DOM/Accessibility/Input/Emulation/Overlay, only on http(s) pages of
  allowed sites (re-checked when the tab changes site), never KesherAI's own port. Firefox (no `chrome.debugger`)
  keeps the page reader; its package drops `debugger` and `tabGroups`. Checked with a fake extension socket
  (`browser-bridge.test.ts`, `browser-ext-cdp.test.ts`) and the packed manifests; not checked here: a real Chrome with
  the extension loaded (needs the PC or a store build).
- **Phase 3 (debugging in the pane):** a 🐞 Debug drawer under the pane (`BrowserDebug.tsx`, routes in
  `routes/browser-debug.ts`, one poll every 2 s): Console (errors only, clear), Network (sign-in headers and secret
  fields hidden; tap a request for its detail), Elements (the accessibility tree with the drawer's own refs, so the
  user's looking never breaks the model's; tap a line, or "Pick on the page" — Overlay inspect mode on the computer,
  the next tap on the picture on the phone — to inspect: tag, attributes with secret values hidden, box, the styles
  that matter, "content is cut" warning, HTML; the page highlights it). View: 📱 390 / 🖥 1280 / 🌙 dark
  (`CdpPage.emulate`). "Try my change" (`tryChange`): reload, new console errors and failed requests, pictures at
  390 px and 1280 px with how far each is wider than the screen. Recording (`startRecording`/`stopRecording`, the
  screencast's PNG frames, at most 300 / 60 s) → a looping GIF made in `gif.ts` with no new dependencies (fflate
  decodes the PNGs; fixed 252-color palette with ordered dithering; frames of another shape are fitted, not
  stretched), or a WebM through FFmpeg when it is already on the computer (`findFfmpeg`, never downloaded; otherwise
  a GIF with a note). Model tools: `browser_inspect`, `browser_emulate`, `browser_try_change` (pictures to the model
  and to the chat), `browser_record`; they work in the user's Chrome too (Phase 2). Checked: fake-CDP tests, a GIF
  LZW round trip, and headless Chromium (inspect with cut text and a hidden token, 390 + dark, try with a 218 px
  overflow, an 8-frame GIF read back by Pillow); the drawer rendered with mock data at 390 and 1280 px in Hebrew and
  English (no page overflow, no cut text). Not checked here: the WebM path (no FFmpeg in this box), Overlay pick mode
  inside the Electron pane.

## 6. Open questions for Roee
1. The extension needs Chrome's `debugger` permission (Chrome shows a yellow "started debugging this browser" bar while it works; Claude in Chrome has the same). OK?
2. Default for helpers on a signed-in site: approve every action (recommended), or allow "Always on this site" after the first approval?
3. Reviewer-model mode ("auto with review") for the chat: wanted, and may it use a cloud model or only the local one?
4. UIA through a persistent PowerShell worker (no new software) is the plan; a small bundled .NET helper would be faster but is a new build step. Which?
5. Download about 6 GB for Qwen3-VL 8B and about 6 GB for UI-TARS-1.5-7B on the PC (drive E:)?

## Stopped at
All primary pages above read except the Codex Chrome extension page (not on the fetch allowlist) and OpenAI's Atlas help page (fetch failed). Not done: measuring latency on the 3090 (estimates marked), checking whether `debugger` can be an optional permission, UFO2 sections after the first 100k characters (not needed), Playwright MCP extension internals (page silent), Stagehand and UFO2 licences.

## Sources
- Claude in Chrome with Claude Code: code.claude.com/docs/en/chrome
- Built-in browser and Claude in Chrome (Desktop 3P): claude.com/docs/third-party/claude-desktop/browser
- Use the built-in browser in Cowork: support.claude.com/en/articles/16607400
- Claude in Chrome permissions guide and safety: support.claude.com/en/articles/12902446, .../12012173-using-claude-in-chrome-safely
- Prompt injection defenses (attack success rates): anthropic.com/research/prompt-injection-defenses
- Computer use tool: platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- OpenAI ChatGPT agent user confirmations: deploymentsafety.openai.com/chatgpt-agent/user-confirmations; Operator system card: openai.com/index/operator-system-card; Atlas: openai.com/index/introducing-chatgpt-atlas
- Google: blog.google/security/architecting-security-for-agentic; Auto browse: support.google.com/chrome/answer/16821166
- Antigravity browser: antigravity.google/docs/ide/browser.md
- Chrome DevTools MCP tool reference and configuration: github.com/ChromeDevTools/chrome-devtools-mcp (docs/tool-reference.md); developer.chrome.com/docs/devtools/agents/get-started/configuration; developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session; developer.chrome.com/blog/remote-debugging-port
- Playwright MCP: playwright.dev/mcp/introduction, playwright.dev/mcp/configuration/browser-extension
- Browser Use README: github.com/browser-use/browser-use; Stagehand: mintlify.com/browserbase/stagehand (how it works); Skyvern README: github.com/Skyvern-AI/skyvern
- Chrome extension debugger API: developer.chrome.com/docs/extensions/reference/api/debugger; Electron Debugger: electronjs.org/docs/latest/api/debugger
- Comet: brave.com/blog/unseeable-prompt-injections; blog.trailofbits.com/2026/02/20/using-threat-modeling-and-prompt-injection-to-audit-comet
- UFO2: arxiv.org/abs/2504.14603; Chromium native UIA: developer.chrome.com/blog/windows-uia-support-update
- UI-TARS-1.5-7B: huggingface.co/ByteDance-Seed/UI-TARS-1.5-7B; OmniParser v2: huggingface.co/microsoft/omniparser-v2.0 and microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent; Fara-7B: huggingface.co/microsoft/Fara-7B, github.com/microsoft/fara; Qwen3-VL on Ollama: registry.ollama.ai/library/qwen3-vl
- KesherAI code: `packages/core/src/browser-bridge.ts`, `computer.ts`, `delegate.ts`, `chat-tool-groups.ts`, `remote-desktop.ts`, `routes/browser.ts`, `apps/desktop/src/browser-pane.ts`, `apps/browser-extension/*`; docs/CLAUDE_PARITY_PLAN.md (Browser stage), docs/WORK_LIST.md.
