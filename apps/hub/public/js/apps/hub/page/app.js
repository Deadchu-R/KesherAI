/**
 * Kesher Cloud hub page: sign in with Google (the one owner), then six tabs: dashboard, agents (agents.ts), devices,
 * tasks, pair, settings.
 * The page is also a paired device of its own (device.ts), so it can send sealed tasks and keep them here.
 *
 * Two kinds of access, as the hub's API has them:
 * - Signed in (session cookie): the full device list with fingerprints, approving pairing codes, revoking, kill
 *   switches and the activity log.
 * - Paired (this browser's device token): live presence and tasks. A phone can pair by code without signing in.
 *
 * Opened from the KesherAI phone app (`?app=http://localhost`), the page shows the app's Phone / Computer / ☁ Cloud
 * switch on top and the phone's bottom tabs. Layout: the design doc's Hub* and PhoneHub* boards.
 *
 * Inside an app's WebView (the KesherAI app, or any Android `; wv)` WebView) Google blocks its sign-in, so the page
 * offers pairing by code there instead, plus a button that opens the hub in the phone's own browser.
 */
import { keyFingerprint } from "../../../packages/shared/src/hub-crypto.js";
import { BUSY_RUN_TEXT } from "../../../packages/shared/src/task-inbox.js";
import { isSafeLink } from "../../../packages/shared/src/hub-protocol.js";
import { deviceIcon, getLocale, h, initLocale, L, setLocale, when } from "./dom.js";
import { HubDevice, post } from "./device.js";
import { RUN_ALL_KEY } from "../../../packages/shared/src/run-undo.js";
import { runAllButton, runWithUndo } from "./run-button.js";
import { pathLine, relayLine } from "./direct.js";
import { diagnoseConnection } from "../../../packages/shared/src/connect-why.js";
import { agentsSummary, agentsTab, runWaitActions, runWaitOf, runWaitTag } from "./agents.js";
import { assignBox } from "./assign.js";
import { assignOfExecutor } from "../../../packages/shared/src/task-assign.js";
import { boardGroup } from "./board.js";
import { quotasLink, quotasPage } from "./quotas.js";
import { failedBlock, doneLine, foldingRows, leavingRow, loadWorkFilters, nowNextSections, workState, workTabs } from "./work.js";
import { listOrder, passes, runToWorkTask, toWorkTask } from "../../../packages/shared/src/hub-work.js";
import { waitingEntries, waitingSection } from "./waiting.js";
import { dismissPc, reviewPcs } from "./pc-updated.js";
import { clearShown, notifySection, startPush } from "./push.js";
import { taskChatPanel } from "./task-chat.js";
import { connectorSection } from "./connector.js";
import { isGoing, shownState, sortedCards } from "../../../packages/shared/src/hub-agents.js";
import { PageDrive } from "./drive.js";
import { agentSnapshots, mergeTasks, parseAppToken, WORK_LIST_STATUS, workListView } from "./drive-view.js";
import { WORK_LIST_STATUSES } from "../../../packages/shared/src/work-list.js";
import { CURTAINS_KEY, isOpen as curtainOpen, parseCurtains, serializeCurtains, toggled } from "../../../packages/shared/src/curtains.js";
const TABS = ["dash", "agents", "devices", "tasks", "pair", "settings"];
const device = new HubDevice();
const app = {
    googleClientId: "",
    /** The hub's Web Push key ("" when the hub has no notifications set up). */
    vapidKey: "",
    signedIn: false,
    owner: undefined,
    /** The phone app's own origin, when opened from it (validated: only the app's localhost origins). */
    appOrigin: undefined,
    /** Running inside an app's WebView, where Google's sign-in is blocked (see {@link inWebView}). */
    inApp: false,
    /** A message under the top bar. */
    note: undefined,
    // Form state survives re-renders.
    draft: "",
    executor: "auto",
    ifOffline: "cloud",
    search: "",
    openTask: undefined,
    /** Claude's work list: the statuses shown (done is hidden at first) and the items opened to their full text. */
    wlShow: new Set(["doing", "next", "roee", "paused"]),
    wlOpen: new Set(),
    /** The agent card open in the agents tab (device/run, or cloud:<taskId>). */
    openAgent: undefined,
    pairCode: "",
    pairName: "",
    peek: undefined,
    selfName: "",
    busy: false,
};
const fingerprints = new Map();
/** Every device's tasks and agent snapshots from the owner's Google Drive (drive.ts). */
const drive = new PageDrive({
    get clientId() {
        return app.googleClientId;
    },
    gis: () => loadGis().then((g) => g?.accounts.oauth2),
    get appOrigin() {
        return app.appOrigin;
    },
    tasks: () => device.tasks,
    onChange: () => renderSoon(),
    // The other devices pull at once (a bare ping through the hub; it never sees Drive data).
    onWrote: () => device.pingSync(),
});
device.onSyncPing(() => drive.onPing());
/** The task list: this device's tasks and every task in Drive (drive-view.ts). */
function allTasks() {
    return mergeTasks(device.tasks, drive.records(), { me: drive.writer, pcNames: pcs().map((d) => d.name), deviceName: (id) => devices().find((d) => d.id === id)?.name });
}
/** The agents view's link to the page (agents.ts). */
const agentsView = {
    device,
    devices: () => devices(),
    get open() {
        return app.openAgent;
    },
    setOpen: (key) => {
        app.openAgent = key;
        if (location.hash !== "#agents")
            location.hash = "#agents";
        render();
        scrollTo(0, 0);
    },
    render: () => render(),
    snapshots: () => (pcOff() ? agentSnapshots(drive.records(), { me: drive.writer, pcNames: pcs().map((d) => d.name) }) : []),
};
/** The Quotas page (quotas.ts): each PC's providers and what is left of them. */
const quotasView = { device, devices: () => devices() };
/** Settings › Notifications (push.ts): this browser's Web Push for "N waiting for you". */
const pushView = { device, vapidKey: () => app.vapidKey, inApp: () => app.inApp, externalHref: () => externalHref(), render: () => render() };
/** The shared task board (board.ts): its actions go sealed to the PC, which applies them through the board's own rules. */
const boardParts = { device, render: () => render() };
/** "Waiting for you" (waiting.ts): answers go sealed to the PC; an agent card opens on the Agents tab. */
const waitingView = { device, render: () => render(), openAgent: (key) => agentsView.setOpen(key) };
// ---- helpers ----
/** The current tab, from the address (#devices…). Anything else, such as #waiting from a notification, is the dashboard, which opens with "Waiting for you". */
function tab() {
    const t = location.hash.slice(1);
    return t === "new" || t === "quotas" || TABS.includes(t) ? t : "dash";
}
/** How the hub last answered the page (direct.ts shows the Tailscale path when it is down). */
let hubProbe;
/** Reads the owner's state; a 401 means not signed in. */
async function loadOwner() {
    const r = await fetch("/api/state", { credentials: "same-origin", signal: AbortSignal.timeout(8000) }).catch(() => undefined);
    // How the hub answered, for the backup-path line (direct.ts): no answer, a 5xx or its storage limit.
    hubProbe = !r ? {} : r.status >= 500 ? { status: r.status, error: String((await r.clone().json().catch(() => ({}))).error ?? "") } : { status: r.status };
    if (r?.status === 200) {
        app.owner = (await r.json());
        app.signedIn = true;
    }
    else if (r?.status === 401) {
        app.owner = undefined;
        app.signedIn = false;
    }
    render();
}
/** Runs an owner action and reloads the state; shows the hub's error when it fails. */
async function act(path, body, done) {
    app.busy = true;
    render();
    const r = await post(path, body).catch(() => undefined);
    app.busy = false;
    if (!r || r.status !== 200) {
        app.note = { he: `לא הצליח: ${String(r?.data.error ?? "אין תשובה מהמרכז")}`, en: `Did not work: ${String(r?.data.error ?? "No answer from the hub")}`, bad: true };
        render();
        return undefined;
    }
    if (done)
        app.note = done;
    await loadOwner();
    return r.data;
}
/**
 * The devices to show: the owner's full list when signed in (plus any device the live presence knows that paired
 * after the list was loaded, e.g. approved in another tab), else the live presence.
 */
function devices() {
    const own = app.owner?.devices;
    return own ? [...own, ...device.presence.filter((d) => !own.some((o) => o.id === d.id))] : device.presence;
}
/** Whether the Claude cloud path can be used (known only when signed in; assumed otherwise, the hub refuses if not). */
function cloudAvailable() {
    return app.owner ? app.owner.cloudReady && !app.owner.cloudOff : true;
}
const pcs = () => devices().filter((d) => d.kind === "pc");
const pcOff = () => pcs().length > 0 && !pcs().some((d) => d.online);
const lastPcSeen = () => pcs().map((d) => d.lastSeen ?? "").sort().pop();
/**
 * While the hub cannot be reached: the devices shown are the last known ones kept on this phone, and a backup relay
 * holds nothing for a PC that is off (so a task may need sending again).
 */
function rememberedLine() {
    if (!device.remembered)
        return null;
    return h("div", { class: "note warn-note", role: "status" }, "📴 ", h("span", null, device.connected ? L("המרכז לא זמין: מוצגים המכשירים האחרונים שנשמרו בטלפון. משימה עוברת דרך ממסר הגיבוי ומגיעה רק למחשב דלוק.", "The hub is unavailable: showing the last devices kept on this phone. A task goes through the backup relay and reaches only a PC that is on.") : L("המרכז לא זמין ואין ממסר גיבוי: משימות מחכות בטלפון ונשלחות כשיהיה חיבור.", "The hub is unavailable and no backup relay is reachable: tasks wait on this phone and go once there is a connection.")));
}
/** A status dot. */
const dot = (state) => h("span", { class: `dot ${state}`, "aria-hidden": "true" });
/** The state of a device in words and as a dot. */
function stateOf(d) {
    // The last known list (the hub cannot be reached): whether it is on is not known.
    if ("remembered" in d)
        return d.online ? { dot: "busy", text: L("לא ידוע · דרך ממסר גיבוי", "Unknown · via a backup relay"), cls: "warn" } : { dot: "off", text: L("לא ידוע · אין חיבור", "Unknown · no connection"), cls: "mut" };
    if (!d.online)
        return { dot: "off", text: L("כבוי", "Off"), cls: "mut" };
    if (d.busy)
        return { dot: "busy", text: L("עסוק", "Busy"), cls: "warn" };
    return { dot: "on", text: L("מחובר", "Online"), cls: "ok" };
}
const AGENT = {
    "local-model": ["מודל מקומי", "Local model"],
    antigravity: ["✦ Antigravity", "✦ Antigravity"],
    "claude-remote-control": ["✷ Claude Remote Control", "✷ Claude Remote Control"],
    codex: ["Codex", "Codex"],
};
/** A status tag for a task. */
function statusTag(t) {
    if (HubDevice.expired(t))
        return h("span", { class: "tag t-off" }, L("פג תוקף", "Expired"));
    switch (t.status) {
        case "outbox":
            return h("span", { class: "tag t-wait" }, L("⇡ ממתין לשליחה", "⇡ Waiting to send"));
        case "waiting":
            // A local-model task waits on the board until the PC's local agent takes it.
            return h("span", { class: "tag t-wait" }, t.inbox?.executor === "local" ? L("ממתין לסוכן המקומי", "Waiting for the local agent") : t.inbox ? L("ממתין", "Waiting") : L("מחכה למחשב", "Waiting for the PC"));
        case "waiting-run":
            return h("span", { class: "tag t-ask" }, L("ממתין ל\"הפעל\"", "Waiting for Run"));
        case "deferred":
            // The free Gemini key's quota ran out: it tries once more by itself at the reset time.
            return h("span", { class: "tag t-ask" }, L("⏸ נדחה: מכסה", "⏸ Deferred: quota"), t.inbox?.retryAt ? ` · ${L("עד", "until")} ${when(t.inbox.retryAt)}` : "");
        case "partial":
            return h("span", { class: "tag t-ask" }, L("◐ חלקי", "◐ Partial"));
        case "sent":
            return h("span", { class: "tag t-run" }, L("נמסר", "Delivered"));
        case "running":
            return h("span", { class: "tag t-run" }, h("span", { class: "spin", "aria-hidden": "true" }), L(" רץ", " Running"));
        case "done":
            return h("span", { class: "tag t-ok" }, L("✓ הסתיים", "✓ Done"));
        case "blocked":
            return h("span", { class: "tag t-ask" }, L("נתקע", "Blocked"));
        case "cancelled":
            return h("span", { class: "tag t-off" }, L("בוטל", "Cancelled"));
        default:
            return h("span", { class: "tag t-bad" }, L("✕ נכשל", "✕ Failed"));
    }
}
/** The route chip of a task (who runs it). */
function routeChip(t) {
    if (t.inbox) {
        const ex = t.inbox.executor;
        // The executor only (the column is narrow); the PC's name is in the tooltip and the task's detail.
        if (ex === "claude")
            return h("span", { class: "ex ex-opus" }, "✷ Claude");
        if (ex === "gemini")
            return h("span", { class: "ex ex-gem", title: t.toName }, L("✧ Gemini (חינמי)", "✧ Gemini (free)"));
        // An executor this page does not know yet (a newer PC) is shown as written.
        const name = ex === "antigravity" ? "✦ Antigravity" : ex === "opencode" ? "◈ OpenCode Go" : ex === "ghostcli" ? "👻 GhostCLI" : ex === "local" ? L("מקומי", "Local") : ex;
        return h("span", { class: "ex ex-loc", title: t.toName }, `🖥 ${name}`);
    }
    return t.route === "claude-cloud" ? h("span", { class: "ex ex-opus" }, L("✷ Claude בענן", "✷ Claude cloud")) : h("span", { class: "ex ex-loc" }, `🖥 ${t.toName}`);
}
/**
 * The step line of an inbox task: "~N steps" from the estimate made when it was queued, and "step X of ~N" while it runs
 * (the count keeps going past the estimate: "step 14, estimate was ~11").
 */
function stepsLine(t) {
    const est = t.inbox?.estSteps;
    if (!est)
        return null;
    const done = t.inbox?.steps ?? 0;
    if (t.status === "running" && done > 0)
        return done > est ? L(`צעד ${done} (הערכה ~${est})`, `step ${done} (estimate ~${est})`) : L(`צעד ${done} מתוך ~${est}`, `step ${done} of ~${est}`);
    return L(`~${est} צעדים`, `~${est} steps`);
}
const isOpen = (t) => !HubDevice.expired(t) && ["outbox", "waiting", "waiting-run", "sent", "running"].includes(t.status);
/** Where a task came from, as a chip: "from Claude" for Claude's task-inbox tasks. */
function sourceChip(t) {
    if (!t.inbox)
        return null;
    const [he, en] = t.inbox.from === "claude" ? ["✷ מ-Claude", "✷ from Claude"] : t.inbox.from === "roee" ? ["📥 מהטלפון", "📥 from the phone"] : ["🔁 מעבודה עצמית", "🔁 from self-work"];
    return h("span", { class: "chip src" }, L(he, en));
}
/** Which device wrote a task that came from Google Drive (none for this device's own). */
function deviceChip(t) {
    if (!t.drive || t.drive.writer === drive.writer || t.inbox)
        return null;
    return h("span", { class: "chip src dev" }, `${t.drive.writer.startsWith("pc-") ? "🖥" : "📱"} ${L(t.drive.device.he, t.drive.device.en)}`);
}
/** The live agent card of an inbox task, while its run is on the Agents tab. */
function liveCard(t) {
    const key = t.inbox?.runId ? `${t.inbox.deviceId}/${t.inbox.runId}` : undefined;
    return key && device.agents.has(key) ? key : undefined;
}
// ---- the frame: top bar, app switch, banner, tabs ----
const TAB_LABEL = {
    dash: ["לוח", "Dashboard", "◉"],
    agents: ["סוכנים", "Agents", "🤖"],
    devices: ["מכשירים", "Devices", "🖥"],
    tasks: ["משימות", "Tasks", "📋"],
    new: ["משימה חדשה", "New task", "＋"],
    quotas: ["מכסות", "Quotas", "📊"],
    pair: ["חיבור", "Pair", "🔗"],
    settings: ["הגדרות", "Settings", "⚙️"],
};
/** The tab links (top on a computer, bottom on a phone). */
function tabs(cls) {
    // A sub-page lights its tab: a new task is under Tasks, the quotas under Agents.
    const cur = tab() === "new" ? "tasks" : tab() === "quotas" ? "agents" : tab();
    const waiting = device.paired ? waitingEntries(device).filter((e) => !e.sent).length : 0;
    return h("nav", { class: cls, "aria-label": L("לשוניות המרכז", "Hub tabs") }, TABS.map((t) => {
        // What waits for the owner is counted on the dashboard and the Tasks tab (both show it on top).
        const n = t === "dash" || t === "tasks" ? waiting : 0;
        return h("a", { href: `#${t}`, class: `nt${cur === t ? " on" : ""}`, "aria-current": cur === t ? "page" : undefined }, h("span", { class: "ni", "aria-hidden": "true" }, TAB_LABEL[t][2]), h("span", null, L(TAB_LABEL[t][0], TAB_LABEL[t][1])), n ? h("span", { class: "nbadge", "aria-label": L(`${n} מחכים לך`, `${n} waiting for you`) }, String(n)) : null);
    }));
}
/** The phone app's Phone / Computer / ☁ Cloud switch (only when opened from the app). */
function whereBar() {
    if (!app.appOrigin)
        return null;
    const off = pcOff();
    return h("div", { class: "where-bar" }, h("div", { class: "where", role: "tablist", "aria-label": L("איפה זה רץ", "Where it runs") }, h("a", { role: "tab", href: `${app.appOrigin}/local.html` }, L("טלפון", "Phone")), off
        ? h("span", { role: "tab", class: "gone", "aria-disabled": "true", title: L("המחשב כבוי", "The PC is off") }, dot("off"), L("מחשב", "Computer"))
        : h("a", { role: "tab", href: `${app.appOrigin}/index.html` }, L("מחשב", "Computer")), h("span", { role: "tab", class: "on", "aria-selected": "true" }, L("☁ ענן", "☁ Cloud"))));
}
/** The amber line when no PC is on. */
function pcOffBanner() {
    if (!pcOff() || device.remembered)
        return null;
    // The PC that was seen last says why it is away: restarting for an update, asleep, or simply off (connect-why.ts).
    const last = [...pcs()].sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))[0];
    const pcOnHub = last?.away?.note?.update ? "restarting" : last?.away ? "asleep" : "offline";
    const why = diagnoseConnection({ internet: true, hub: true, pcOnHub, ...(last?.away?.note?.update ? { pcUpdate: last.away.note.update } : {}) });
    // In the phone app, "Why?" opens its connection sheet with what the hub knows (index.html reads these).
    const whyHref = app.appOrigin ? `${app.appOrigin}/index.html?why=1&pc=${pcOnHub}${last?.away?.note?.update ? `&ver=${encodeURIComponent(last.away.note.update)}` : ""}${lastPcSeen() ? `&seen=${encodeURIComponent(lastPcSeen())}` : ""}` : undefined;
    return h("div", { class: "off-banner", role: "status", title: L(why.fix.he, why.fix.en) }, dot("off"), h("span", null, L(`${why.title.he} · עבודה דרך הענן`, `${why.title.en} · working through the cloud`)), h("span", { class: "grow" }), lastPcSeen() ? h("span", { class: "mut xs" }, L("נראה לאחרונה ", "Last seen ") + when(lastPcSeen())) : null, whyHref ? h("a", { class: "acc xs", href: whyHref }, L("למה?", "Why?")) : null, app.appOrigin ? h("a", { class: "acc xs", href: `${app.appOrigin}/index.html` }, L("נסה שוב", "Try again")) : null);
}
/** The top bar on a computer. */
function topBar() {
    return h("header", { class: "hubnav" }, h("b", { class: "brand" }, "☁ Kesher Cloud"), tabs("top-tabs"), h("span", { class: "grow" }), h("span", { class: "chip hide-sm" }, app.signedIn ? L("🔒 פרטי · מחובר", "🔒 Private · signed in") : L("🔒 פרטי", "🔒 Private")), app.signedIn && app.owner
        ? h("button", { type: "button", class: "btn hide-sm", disabled: app.busy, onclick: () => void act("/api/kill", { what: app.owner.paused ? "resume" : "pause" }) }, app.owner.paused ? L("▶ המשך", "▶ Resume") : L("⏸ השהה את המרכז", "⏸ Pause the hub"))
        : null, h("button", { type: "button", class: "btn", "aria-label": L("English", "עברית"), onclick: () => { setLocale(getLocale() === "he" ? "en" : "he"); render(); } }, getLocale() === "he" ? "EN" : "עב"));
}
/** A note line (errors and confirmations). */
function noteLine() {
    if (!app.note)
        return null;
    return h("div", { class: `note${app.note.bad ? " bad-note" : ""}`, role: app.note.bad ? "alert" : "status" }, h("span", { class: "grow" }, L(app.note.he, app.note.en)), h("button", { type: "button", class: "x", "aria-label": L("סגור", "Close"), onclick: () => { app.note = undefined; render(); } }, "✕"));
}
const relay = (short = false) => h("div", { class: "relay" }, "🔐 ", h("span", null, short ? L("ההיסטוריה שמורה במכשיר הזה וב-Google Drive שלך. המרכז רק מעביר.", "The history is kept on this device and in your Google Drive. The hub only relays.") : L("המרכז רק מעביר הודעות נעולות ומוחק כל אחת ברגע שהתקבלה. המשימות וההיסטוריה שמורות במכשיר הזה, קבצי הפרויקט נשארים במחשב.", "The hub only relays sealed messages and deletes each one once it arrives. Tasks and history are kept on this device; project files stay on the PC.")));
/**
 * The Google Drive line of the Tasks tab (HubTasks): connect, reconnect when the token ended (about hourly in a
 * browser), syncing, when it last synced and how many writes wait. `data-drive` holds the state (for checks).
 */
function driveLine() {
    const st = drive.status;
    if (!app.googleClientId && !app.inApp)
        return null;
    const button = (he, en) => h("button", { type: "button", class: "btn sm-btn", onclick: () => void drive.connect() }, L(he, en));
    const pending = drive.pending ? h("span", { class: "tag t-wait" }, L(`⇡ ${drive.pending} ממתינים לשליחה`, `⇡ ${drive.pending} waiting to send`)) : null;
    const line = (cls, icon, text, ...rest) => h("div", { class: `${cls} drive-line`, "data-drive": st, role: "status" }, h("span", { "aria-hidden": "true" }, icon), h("span", { class: "grow sm" }, text), ...rest);
    switch (st) {
        case "off":
            return line("kill soft", "📁", L("המשימות של כל המכשירים שלך נשמרות ב-Google Drive שלך (בתיקייה נסתרת, נעולות). חבר כדי לראות אותן כאן.", "The tasks of all your devices are kept in your Google Drive (a hidden folder, sealed). Connect to see them here."), button("חבר את Drive", "Connect Drive"));
        case "reconnect":
            return line("kill amber", "📁", app.inApp ? L("החיבור ל-Google Drive הסתיים. מתחבר מחדש דרך האפליקציה.", "The Google Drive connection ended. Reconnect through the app.") : L("החיבור ל-Google Drive הסתיים (אחרי כשעה). מוצגות המשימות שנשמרו כאן.", "The Google Drive connection ended (after about an hour). Showing the tasks kept here."), pending, button("חבר מחדש", "Reconnect Drive"));
        case "connecting":
        case "syncing":
            return line("relay", "📁", st === "connecting" ? L("מתחבר ל-Google Drive…", "Connecting to Google Drive…") : L("מסנכרן עם Google Drive…", "Syncing with Google Drive…"), h("span", { class: "spin", "aria-hidden": "true" }));
        case "offline":
            return line("kill soft", "📁", L("אין חיבור ל-Google Drive. מוצגות המשימות שנשמרו כאן; ינסה שוב.", "No connection to Google Drive. Showing the tasks kept here; it tries again."), pending);
        case "error":
            return line("kill amber", "📁", drive.error ? L(drive.error.he, drive.error.en) : L("הסנכרון נכשל", "The sync failed"), pending, h("button", { type: "button", class: "btn sm-btn", onclick: () => void drive.syncNow() }, L("נסה שוב", "Try again")));
        default:
            return line("relay", "📁", L(`מ-Google Drive · עודכן ${when(drive.lastSync)}`, `From Google Drive · updated ${when(drive.lastSync)}`), pending);
    }
}
/** "Sign in to manage" for the owner-only parts, when this is a paired device that is not signed in. */
function signInCard(what) {
    return h("div", { class: "card pad stack" }, h("b", null, L("צריך להתחבר עם Google", "Sign in with Google first")), h("span", { class: "mut sm" }, what), app.inApp ? inAppNote() : h("div", { class: "gis" }));
}
/**
 * The hub's own address with a marker that the KesherAI app opens in the phone's browser (NotifyPlugin.java); in a
 * plain browser the page drops the marker again ({@link dropExternalMarker}).
 */
function externalHref() {
    return `${location.origin}/?${EXTERNAL}=1${location.hash}`;
}
/** Why there is no Google button inside the app, and a way out to the phone's browser (PhoneHubInApp). */
function inAppNote() {
    return h("div", { class: "card pad stack start in-app-note", role: "note" }, h("span", { class: "sm" }, L("ההתחברות עם Google לא עובדת בתוך האפליקציה. חברו עם קוד ואשרו אותו בדפדפן.", "Google sign-in doesn't work inside the app; pair with a code and approve it in your browser.")), h("a", { class: "btn", href: externalHref(), rel: "noopener" }, L("פתח בדפדפן של הטלפון ↗", "Open in the phone's browser ↗")), h("span", { class: "mut xs", dir: "ltr" }, location.origin));
}
// ---- screens ----
/** The sign-in screen (PhoneHubSignIn), also the first screen on a computer. */
function signInScreen() {
    const pairing = device.pending;
    return h("main", { class: "signin" }, h("div", { class: "logo", "aria-hidden": "true" }, "☁"), h("h1", null, "Kesher Cloud"), h("p", { class: "mut" }, L("המרכז הפרטי שלך: מחבר את הטלפון, המחשבים והסוכנים בענן, ושולח כל משימה למי שפנוי.", "Your private hub: it links your phone, your PCs and the cloud agents, and sends each task to whoever is free.")), ...(app.inApp
        ? // In the app: pairing by code is the main action (Google refuses to sign in inside a WebView).
            [pairing ? selfPairing() : h("button", { type: "button", class: "btn pri big", onclick: () => void startSelfPair() }, L("לחבר את המכשיר הזה עם קוד", "Pair this device with a code")), inAppNote()]
        : [app.googleClientId ? h("div", { class: "gis" }) : h("p", { class: "warn sm" }, L("ההתחברות עם Google לא הוגדרה במרכז הזה (GOOGLE_CLIENT_ID).", "Google sign-in is not set up on this hub (GOOGLE_CLIENT_ID)."))]), h("div", { class: "card pad stack start" }, h("b", { class: "sm" }, L("🔒 המרכז הזה פרטי", "🔒 This hub is private")), h("span", { class: "mut sm" }, L("רק חשבון אחד יכול להיכנס. כל השאר מקבלים \"אין גישה\". ההתחברות רק מאשרת חיבור מכשירים; את התוכן פותח רק המפתח שבמכשיר.", "Only one account can get in; everyone else gets \"no access\". Signing in only approves devices; the content is opened only by the key on each device."))), app.inApp ? null : pairing ? selfPairing() : h("button", { type: "button", class: "link", onclick: () => void startSelfPair() }, L("או: לחבר את המכשיר הזה עם קוד (מאשרים ממסך מחובר)", "Or: pair this device with a code (approve it on a signed-in screen)")));
}
/** Starts pairing this browser as a device; when signed in, approves it right away (same screen). */
async function startSelfPair() {
    const name = app.selfName.trim() || (app.appOrigin ? L("הטלפון", "Phone") : L("דפדפן", "Browser"));
    const r = await device.startPairing(name);
    if ("error" in r) {
        app.note = { he: r.error, en: r.error, bad: true };
        return render();
    }
    if (app.signedIn) {
        // The owner is signed in on this very page: no second screen to compare with.
        await act("/api/pair/approve", { code: r.code, name }, { he: "הדפדפן הזה חובר כמכשיר", en: "This browser is now a paired device" });
    }
    render();
}
/** The code and fingerprint this device shows while it waits for approval. */
function selfPairing() {
    const p = device.pending;
    return h("div", { class: "card pad stack center" }, h("span", { class: "mut sm" }, L("אשרו את הקוד הזה במרכז, במסך שמחובר עם Google (לשונית חיבור):", "Approve this code at the hub on a screen signed in with Google (Pair tab):")), h("div", { class: "code6", dir: "ltr" }, p.code), h("span", { class: "mut sm" }, L("טביעת אצבע: ", "Fingerprint: "), h("b", { class: "mono" }, p.fingerprint)), h("span", { class: "mut xs" }, L("ממתין לאישור… הקוד תקף 5 דקות", "Waiting for approval… the code is valid for 5 minutes")), h("button", { type: "button", class: "btn", onclick: () => device.cancelPairing() }, L("בטל", "Cancel")));
}
/** The devices card (dashboard and phone): devices, then Claude cloud. */
function deviceRows(full) {
    const rows = devices().map((d) => {
        const s = stateOf(d);
        const me = d.id === device.id;
        const fp = d.fingerprint ?? fingerprints.get(d.id);
        // What this PC takes (its own opt-in), as one chip beside its agents.
        const takes = [d.optIn.acceptLocal && L("מקומי", "local"), d.optIn.acceptAntigravity && "Antigravity"].filter(Boolean).join(", ");
        const optIn = d.kind === "pc" ? [d.optIn.acceptTasks ? L("📥 מקבל משימות", "📥 Takes tasks") + (takes ? `: ${takes}` : "") : L("📥 לא מקבל משימות", "📥 Takes no tasks")] : [];
        const sub = [d.kind === "pc" ? (d.version ? `KesherAI ${d.version}` : "") : d.kind === "claude-chat" ? L("מדווח על הסוכנים של צ׳אט Claude", "Reports the Claude chat's agents") : me ? L("הדף הזה פתוח בו עכשיו", "This page is open on it now") : "", !d.online && d.lastSeen ? L("נראה לאחרונה ", "last seen ") + when(d.lastSeen) : "", full && fp ? L("טביעת אצבע ", "fingerprint ") + fp : ""].filter(Boolean).join(" · ");
        const why = offReason(d);
        return h("div", { class: "dev" }, h("span", { class: "dev-ic", "aria-hidden": "true" }, deviceIcon(d.kind)), h("div", { class: "grow min0" }, h("div", { class: "row wrap" }, h("b", null, d.name, me ? L(" (זה)", " (this)") : ""), dot(s.dot), h("span", { class: `sm ${s.cls}` }, s.text)), sub ? h("div", { class: "mut sm" }, sub) : null, why ? h("div", { class: "sm why" }, why) : null, d.agents.length || optIn.length ? h("div", { class: "row wrap chips" }, d.agents.map((a) => h("span", { class: "chip" }, dot(a.state === "busy" ? "busy" : a.state === "on" && d.online ? "on" : "off"), a.label ? `${AGENT[a.kind]?.[getLocale() === "he" ? 0 : 1] ?? a.kind} ${a.label}` : (AGENT[a.kind]?.[getLocale() === "he" ? 0 : 1] ?? a.kind), a.link && isSafeLink(a.link) && d.optIn.reportLinks ? h("a", { href: a.link, target: "_blank", rel: "noopener noreferrer" }, " ↗") : null)), optIn.map((o) => h("span", { class: "chip" }, o))) : null), full && app.signedIn && !me
            ? h("button", { type: "button", class: "btn sm-btn bad", disabled: app.busy, onclick: () => confirm(L(`לנתק את ${d.name}? הוא יצטרך להתחבר מחדש עם קוד.`, `Disconnect ${d.name}? It will need a new code to pair again.`)) && void act(`/api/devices/${encodeURIComponent(d.id)}/revoke`, {}, { he: "המכשיר נותק", en: "The device was disconnected" }) }, L("נתק", "Disconnect"))
            : null);
    });
    if (!rows.length)
        rows.push(h("div", { class: "dev mut sm" }, L("אין עדיין מכשירים מחוברים. לשונית חיבור ›", "No devices paired yet. Pair tab ›")));
    return rows;
}
/**
 * Why a PC shows Off, when the hub can tell: it never connected since it was paired, or since when it is gone and
 * what to check on the PC (Settings › Kesher Cloud shows the PC's own reason).
 */
function offReason(d) {
    // The last known list (the hub cannot be reached): the line above the list already says why.
    if (d.online || d.kind !== "pc" || "remembered" in d)
        return undefined;
    if (!d.lastSeen)
        return L("לא התחבר מאז שחובר. במחשב: הגדרות › ענן Kesher, סמן \"פעיל\".", "Has not connected since it was paired. On the PC: Settings › Kesher Cloud, tick \"On\".");
    const min = (Date.now() - Date.parse(d.lastSeen)) / 60_000;
    if (min < 3)
        return L("הקישור נקטע עכשיו. המחשב מתחבר שוב לבד.", "The link just dropped. The PC reconnects by itself.");
    return L("אם KesherAI פתוח במחשב: הגדרות › ענן Kesher מראה למה הוא לא מחובר.", "If KesherAI is open on the PC: Settings › Kesher Cloud shows why it is not connected.");
}
/** Claude cloud as an agent row. */
function cloudRow() {
    const known = !!app.owner;
    const on = known ? app.owner.cloudReady && !app.owner.cloudOff : false;
    return h("div", { class: "dev" }, h("span", { class: "dev-ic", "aria-hidden": "true" }, "✷"), h("div", { class: "grow min0" }, h("div", { class: "row wrap" }, h("b", null, L("Claude בענן", "Claude cloud")), known ? dot(on ? "on" : "off") : null, known ? h("span", { class: `sm ${on ? "ok" : "mut"}` }, on ? L("זמין", "Available") : app.owner.cloudOff ? L("כבוי", "Off") : L("לא מוגדר", "Not set up")) : null), h("div", { class: "mut sm" }, L("משימה מתוזמנת בחשבון Claude שלך · בלי מפתח API · עד 30 הפעלות בשעה", "A scheduled task on your Claude account · no API key · up to 30 runs an hour"))));
}
/** The route line for the current form choice. */
function routeBox(compact) {
    if (!device.paired)
        return h("div", { class: "route" }, "🧭 ", h("span", { class: "grow" }, L("כדי לשלוח משימות מכאן, חברו את המכשיר הזה (לשונית חיבור).", "To send tasks from here, pair this device (Pair tab).")));
    const r = device.route(app.executor, app.ifOffline, cloudAvailable());
    const target = r.route === "claude-cloud" ? L("Claude בענן", "Claude cloud") : r.route === "none" ? L("אין לאן", "Nowhere") : (devices().find((d) => d.id === r.to)?.name ?? "PC");
    return h("div", { class: `route${compact ? "" : " col"}` }, h("div", { class: "row" }, h("span", { "aria-hidden": "true" }, "🧭"), h("span", { class: "grow" }, h("b", null, L("מסלול: ", "Route: "), target), " · ", L(r.reason.he, r.reason.en))), compact ? null : h("div", { class: "row wrap sm route-path" }, h("span", { class: "chip" }, L("📱 המכשיר הזה", "📱 This device")), "→", h("span", { class: "chip" }, L("☁ המרכז (מעביר בלבד)", "☁ The hub (relays only)")), "→", h("span", { class: `chip${r.route === "claude-cloud" ? " opus" : ""}` }, r.route === "claude-cloud" ? "✷ Claude" : `🖥 ${target}`)), h("span", { class: "sm cost" }, "💰 ", L(r.cost.he, r.cost.en)));
}
/** The cloud-path warning (the hub opens that one message to start the task). */
function cloudWarning() {
    if (!device.paired || device.route(app.executor, app.ifOffline, cloudAvailable()).route !== "claude-cloud")
        return null;
    return h("div", { class: "kill amber" }, h("span", { "aria-hidden": "true" }, "👁"), h("span", { class: "sm grow" }, L("המסלול הזה מראה את המשימה לענן של Claude. המרכז פותח אותה רק לרגע כדי לשלוח, ולא שומר אותה.", "This route shows the task to Claude's cloud. The hub opens it only for a moment to send it, and keeps nothing of it.")));
}
/** Sends the draft. */
async function sendDraft() {
    const r = await device.send(app.draft, app.executor, app.ifOffline, cloudAvailable());
    if ("error" in r) {
        app.note = { ...r.error, bad: true };
    }
    else {
        app.draft = "";
        app.note = { he: "המשימה נשלחה", en: "The task was sent" };
        void drive.taskSent();
        app.openTask = r.taskId;
        location.hash = "#tasks";
    }
    render();
}
/** The task text box. */
const draftBox = (rows) => h("textarea", { class: "inp area", rows, maxlength: 8000, "aria-label": L("מה לעשות", "What to do"), placeholder: L("מה לעשות? למשל: \"תבדוק למה הבנייה של אנדרואיד נכשלה\"", "What to do? For example: \"Find out why the Android build failed\""), value: app.draft, oninput: (e) => { app.draft = e.target.value; } });
/** The version each PC had when this browser last looked (local to this browser; per device). */
function readSeen() {
    try {
        const v = JSON.parse(localStorage.getItem("kh-pc-seen") ?? "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
/** One-time cards "The PC was updated to X", for a PC that reports a newer version than this browser saw. */
function updatedCards() {
    const seen = readSeen();
    const r = reviewPcs(devices(), seen);
    if (JSON.stringify(r.seen) !== JSON.stringify(seen)) {
        try {
            localStorage.setItem("kh-pc-seen", JSON.stringify(r.seen));
        }
        catch { /* storage off: no memory, no card */ }
    }
    return r.updated.map((pc) => h("section", { class: "card pad stack", role: "status" }, h("div", { class: "row" }, h("b", { class: "grow" }, L(`המחשב ${pc.name} עודכן ל-${pc.version}`, `${pc.name} was updated to ${pc.version}`)), h("button", { type: "button", class: "btn sm-btn", "aria-label": L("סגירה", "Close"), onclick: () => { try {
            localStorage.setItem("kh-pc-seen", JSON.stringify(dismissPc(readSeen(), pc)));
        }
        catch { /* none */ } render(); } }, "✕")), h("span", { class: "mut sm" }, L(`היה ${pc.from}. מה חדש: באפליקציה שמחוברת למחשב, בעמוד העדכונים.`, `It was ${pc.from}. What's new: in the app connected to that PC, on its Updates page.`))));
}
/** The dashboard (HubDashboard / PhoneHubDashboard). */
function dashboard() {
    const on = devices().filter((d) => d.online).length;
    const off = devices().length - on;
    const open = allTasks().filter(isOpen);
    return h("main", { class: "page" }, h("div", { class: "row wrap" }, h("h1", null, L("שלום", "Hello")), h("span", { class: "mut" }, L(`· ${on} מחוברים, ${off} כבויים · ${open.length} משימות פתוחות`, `· ${on} online, ${off} off · ${open.length} open tasks`)), h("span", { class: "grow" }), h("a", { class: "btn pri big hide-sm", href: "#new" }, L("＋ שלח משימה", "＋ Send a task"))), relay(), ...updatedCards(), waitingSection(waitingView), ...nowNextSections(workView).slice(0, 1), h("div", { class: "grid2" }, h("section", { class: "card clip" }, h("div", { class: "row head" }, h("b", null, L("מכשירים וסוכנים", "Devices and agents")), h("span", { class: "grow" }), h("a", { class: "mut sm", href: "#devices" }, L("הכול ›", "All ›"))), deviceRows(false), cloudRow()), h("div", { class: "stack" }, agentsSummary(agentsView), h("section", { class: "card pad stack" }, h("b", null, L("שליחה מהירה", "Quick send")), draftBox(2), routeBox(true), h("div", { class: "row" }, h("span", { class: "mut sm grow" }, cloudWarning() ? L("המסלול הזה מראה את המשימה לענן של Claude.", "This route shows the task to Claude's cloud.") : ""), h("button", { type: "button", class: "btn pri", disabled: !device.paired || !app.draft.trim(), onclick: () => void sendDraft() }, L("שלח", "Send")))), h("section", { class: "card clip" }, h("div", { class: "row head" }, h("b", null, L("משימות פתוחות", "Open tasks")), h("span", { class: "tag t-run" }, String(open.length)), h("span", { class: "grow" }), h("a", { class: "mut sm", href: "#tasks" }, L("הכול ›", "All ›"))), open.length ? open.slice(0, 5).map((t) => h("a", { class: "trow sm", href: "#tasks", onclick: () => { app.openTask = t.taskId; } }, statusTag(t), h("span", { class: "grow ell" }, t.title), routeChip(t))) : h("div", { class: "trow mut sm" }, L("אין משימות פתוחות.", "No open tasks."))))));
}
/** The devices tab (HubDevices). */
function devicesTab() {
    return h("main", { class: "page" }, h("div", { class: "row" }, h("h1", null, L("מכשירים וסוכנים", "Devices and agents")), h("span", { class: "grow" }), h("a", { class: "btn pri", href: "#pair" }, L("＋ חבר מכשיר", "＋ Pair a device"))), h("section", { class: "card clip" }, h("div", { class: "row head wrap" }, h("b", null, L("המכשירים שלי", "My devices")), h("span", { class: "mut sm" }, L("כל מכשיר מחזיק מפתח משלו. \"נתק\" סוגר אותו מיד.", "Each device holds its own key. \"Disconnect\" closes it at once."))), deviceRows(true)), h("section", { class: "card clip" }, h("div", { class: "row head wrap" }, h("b", null, L("סוכנים בענן", "Cloud agents")), h("span", { class: "mut sm" }, L("משמשים רק כשאין מחשב פנוי, או כשבחרת בהם", "Used only when no PC is free, or when you chose them"))), cloudRow()), h("p", { class: "mut sm" }, L("כל מחשב מחליט בעצמו אם לקבל משימות: במחשב, הגדרות › ענן Kesher. מה המרכז יודע על מכשיר: שם, מפתח ציבורי, מתי נראה לאחרונה, ואילו סוכנים פועלים בו. לא קבצים, לא משימות, לא היסטוריה.", "Each PC decides for itself whether it takes tasks: on the PC, Settings › Kesher Cloud. What the hub knows about a device: its name, public key, when it was last seen and which agents run on it. No files, no tasks, no history.")));
}
/** The new-task form (HubSendTask / PhoneHubSendTask). */
function newTask() {
    const opt = (group, value, cur, set, title, sub) => h("label", { class: `opt${cur === value ? " sel2" : ""}` }, h("input", { type: "radio", name: group, value, checked: cur === value, onchange: () => { set(value); render(); } }), h("span", { class: "grow" }, title, sub ? h("div", { class: "mut xs" }, sub) : null));
    return h("main", { class: "page" }, h("h1", null, L("משימה חדשה", "New task")), h("div", { class: "grid2 wide-first" }, h("div", { class: "stack" }, h("section", { class: "sec" }, h("span", { class: "mut sm" }, L("מה לעשות", "What to do")), draftBox(5)), h("section", { class: "sec" }, h("h3", null, L("מי יבצע", "Who does it")), h("div", { class: "opts", role: "radiogroup" }, opt("ex", "auto", app.executor, (v) => (app.executor = v), L("אוטומטי", "Automatic"), L("לפי המשימה ומי מחובר", "By the task and who is on")), opt("ex", "pc-any", app.executor, (v) => (app.executor = v), L("🖥 מחשב", "🖥 A PC"), L("מודל מקומי או Antigravity", "Local model or Antigravity")), opt("ex", "claude-cloud", app.executor, (v) => (app.executor = v), L("✷ Claude בענן", "✷ Claude cloud"), L("מהמנוי שלך", "From your subscription")))), h("section", { class: "sec" }, h("h3", null, L("אם המחשב כבוי", "If the PC is off")), h("div", { class: "opts", role: "radiogroup" }, opt("off", "wait", app.ifOffline, (v) => (app.ifOffline = v), L("לחכות לו", "Wait for it")), opt("off", "cloud", app.ifOffline, (v) => (app.ifOffline = v), L("לשלוח לענן", "Send to the cloud"))), h("span", { class: "mut sm" }, L("משימה שמחכה נמחקת מהמרכז אחרי 24 שעות אם לא נמסרה.", "A waiting task is deleted from the hub after 24 hours if it was not delivered.")))), h("div", { class: "stack" }, routeBox(false), cloudWarning(), h("section", { class: "sec" }, h("h3", { class: "sm" }, L("מה נשמר איפה", "What is kept where")), h("div", { class: "sm lines" }, L("📱 המשימה והתשובה: במכשיר הזה וב-Google Drive שלך (נעולות)", "📱 The task and the answer: on this device and in your Google Drive (sealed)"), h("br"), L("☁ המרכז: רק מזהה, יעד ושעה, עד שהמשימה נמסרה", "☁ The hub: only an id, a recipient and a time, until delivered"), h("br"), L("🔀 הקוד: בענף ב-GitHub, כמו תמיד", "🔀 The code: in a branch on GitHub, as always"))), h("div", { class: "row end" }, h("span", { class: "grow" }), h("a", { class: "btn", href: "#tasks" }, L("ביטול", "Cancel")), h("button", { type: "button", class: "btn pri big", disabled: !device.paired || !app.draft.trim(), onclick: () => void sendDraft() }, L("שלח משימה", "Send the task"))))));
}
/** Every page task as a work task (with the PCs' board priorities filled in), for the work views. */
function workTasks() {
    const board = new Map();
    for (const snap of device.boards.values())
        for (const i of snap.items)
            board.set(i.id, i);
    return allTasks().map((task) => ({ task, work: toWorkTask(task, !task.inbox && HubDevice.expired(task), board) }));
}
/** What the work views need from the page (work.ts). */
const workView = { device, render: () => render(), openAgent: (key) => agentsView.setOpen(key), tasks: workTasks };
/** The tasks tab (HubTasks / PhoneHubTasks and the HubNowNext / HubWorkTabs boards). */
function tasksTab() {
    loadWorkFilters(render);
    drive.preload();
    const pairs = workTasks();
    const byId = new Map(pairs.map((p) => [p.task.taskId, p]));
    const now = Date.now();
    const runs = sortedCards(device.agents.values(), now);
    // Everything the tabs count: the page's tasks and the PCs' live runs, each as a work task.
    const items = [...pairs.map((p) => p.work), ...runs.map(runToWorkTask)];
    const q = app.search.trim().toLowerCase();
    const phase = workState.phase;
    const f = workState.filters;
    const list = pairs.filter((p) => p.work.phase === phase && passes(p.work, f) && (!q || `${p.task.title}\n${p.task.spec}`.toLowerCase().includes(q))).sort((a, b) => listOrder(phase)(a.work, b.work)).map((p) => p.task);
    const open = app.openTask ? byId.get(app.openTask)?.task : undefined;
    return h("main", { class: "page" }, h("div", { class: "row wrap" }, h("h1", null, L("משימות", "Tasks")), h("span", { class: "mut sm" }, L("מכל המכשירים שלך (המרכז לא שומר משימות)", "From all your devices (the hub keeps no tasks)")), h("span", { class: "grow" }), quotasLink(), h("a", { class: "btn pri", href: "#new" }, L("＋ משימה", "＋ Task"))), driveLine(), !device.paired ? pairThisCard() : null, waitingSection(waitingView), device.paired ? taskChatPanel({ device, render: () => render() }) : null, ...nowNextSections(workView), workTabs(workView, items), h("div", { class: "row wrap filters" }, h("span", { class: "grow" }), h("input", { class: "inp search", type: "search", placeholder: L("🔍 חיפוש", "🔍 Search"), "aria-label": L("חיפוש", "Search"), value: app.search, oninput: (e) => { app.search = e.target.value; renderSoon(); } })), h("section", { class: "card clip", role: "tabpanel", "aria-live": phase === "active" ? "polite" : undefined }, h("div", { class: "trow thead mut xs hide-sm" }, h("span", { class: "c-st" }, L("מצב", "Status")), h("span", { class: "grow" }, L("משימה ותוצאה", "Task and result")), h("span", { class: "c-rt" }, L("מסלול", "Route")), h("span", { class: "c-when" }, L("מתי", "When")), h("span", { class: "c-act" })), ...taskGroups(list, q, byId), list.length || agentRows(q).length ? null : h("div", { class: "trow mut sm" }, items.length ? L("אין משימות כאלה.", "No such tasks.") : L("עוד אין משימות.", "No tasks yet."))), open ? taskDetail(open) : null, boardGroup(boardParts, q), workListGroup(q));
}
/**
 * Claude's work list (HubWorkList / PhoneHubWorkList): the items the PC copies from docs/WORK_LIST.md to Drive,
 * by section, with a colour-coded status, filter chips by status (done hidden at first) and each item's full text
 * a tap away. Nothing when Drive has no list (Settings on the PC: "Show Claude's work list").
 *
 * @param q - The search text (lower case), shared with the task list.
 */
function workListGroup(q) {
    const view = workListView(drive.records(), app.wlShow);
    if (!view.total)
        return null;
    const chip = (st) => {
        const w = WORK_LIST_STATUS[st];
        const on = app.wlShow.has(st);
        return h("button", { type: "button", class: `chip wl-chip ${w.cls}${on ? " chip-on" : ""}`, "aria-pressed": String(on), onclick: () => { if (on)
                app.wlShow.delete(st);
            else
                app.wlShow.add(st); render(); } }, `${w.icon} ${L(w.he, w.en)} ${view.counts[st]}`);
    };
    const sections = view.sections
        .map((s) => ({ ...s, items: s.items.filter((i) => !q || `${i.title}\n${i.text}\n${s.section}`.toLowerCase().includes(q)) }))
        .filter((s) => s.items.length);
    const wlOpen = (s) => curtainOpen(curtains, `wl:${s.section}`, s.items.length, !!q);
    return h("section", { class: "card clip wl", "aria-label": L("רשימת העבודה של Claude", "Claude's work list") }, h("div", { class: "row wrap head" }, h("b", null, L("📋 רשימת העבודה של Claude", "📋 Claude's work list")), h("span", { class: "mut xs" }, L("מהמחשב, מתעדכנת כל 15 דקות", "From the PC, updated every 15 minutes"))), h("div", { class: "row wrap filters wl-filters" }, WORK_LIST_STATUSES.map(chip)), sections.length
        ? sections.map((s) => h("div", { class: "wl-sec" }, h("h3", { class: "wl-h", dir: "auto" }, curtainButton(`wl:${s.section}`, wlOpen(s), s.items.length, s.items.length, h("span", { class: "grow ell1" }, s.section), "wl-curtain")), (wlOpen(s) ? s.items : []).map((i) => {
            const w = WORK_LIST_STATUS[i.status];
            const open = app.wlOpen.has(i.id);
            const more = i.text.length > i.title.length + 1;
            const pcs = device.onlinePcs();
            return h("div", { class: `wl-item ${w.cls}` }, h("button", { type: "button", class: "trow wl-row", "aria-expanded": String(open), onclick: () => { if (open)
                    app.wlOpen.delete(i.id);
                else
                    app.wlOpen.add(i.id); render(); } }, h("span", { class: `tag ${w.cls}`, title: L(w.he, w.en) }, w.icon, h("span", { class: "hide-sm" }, ` ${L(w.he, w.en)}`)), h("span", { class: "grow wl-title", dir: "auto" }, i.title), h("span", { class: "mut xs", "aria-hidden": "true" }, open ? "▴" : "▾")), open && more ? h("div", { class: "wl-text sm", dir: "auto" }, i.text) : null, open && i.status !== "done" ? h("div", { class: "wl-assign" }, assignBox({ device, render, taskId: i.id, pcs, onePc: true, label: { he: "שלח לסוכן", en: "Send to an agent" } })) : null);
        })))
        : h("div", { class: "trow mut sm" }, L("אין פריטים כאלה. אפשר לבחור מצבים נוספים למעלה.", "No such items. Pick more statuses above.")));
}
/**
 * Run / Cancel for a task that waits for Run on a PC (an Antigravity task from the inbox or from another device),
 * then the PC's answer ("Sent to the PC…", "Started on the PC.", or why not).
 */
function runButtons(t) {
    const a = device.taskActions.get(t.taskId);
    if (device.runStarting(t))
        return h("span", { class: "tag t-run runbtn" }, L("מתחיל…", "Starting…"));
    if (a && !a.result)
        return h("span", { class: "tag t-run runbtn" }, L("נשלח למחשב…", "Sent to the PC…"));
    // Another Antigravity task runs: the PC refuses (409). Say it in the user's language and offer the queue instead.
    const busy = a?.result?.ok === false && a.result.text === BUSY_RUN_TEXT.he;
    const note = a?.result ? h("span", { class: `xs ${a.result.ok ? "mut" : "warn"} wrapl`, dir: "auto" }, busy ? L(BUSY_RUN_TEXT.he, BUSY_RUN_TEXT.en) : a.result.text) : null;
    if (busy && device.canRun(t))
        return h("span", { class: "row wrap runacts" }, note, h("button", { type: "button", class: "btn sm-btn pri", onclick: (e) => { e.stopPropagation(); void device.inboxCommand(t, "inbox-queue"); } }, L("＋ הוסף לתור", "＋ Add to queue")));
    if (!device.canRun(t))
        return note;
    // A tap on Run counts 5 seconds first ("Starting in 5… Undo"); the command is sent only after that.
    const counting = device.runCountdown(t.taskId) !== undefined;
    const allLeft = device.runCountdown(RUN_ALL_KEY);
    if (allLeft !== undefined)
        return h("span", { class: "tag t-run runbtn" }, L(`מתחיל בעוד ${allLeft}…`, `Starting in ${allLeft}…`));
    const cancel = (e) => {
        e.stopPropagation();
        if (confirm(L(`לבטל את "${t.title}"?`, `Cancel "${t.title}"?`)))
            void device.inboxCommand(t, "inbox-cancel");
    };
    return h("span", { class: "row runacts" }, runWithUndo(device, t.taskId, L("▶ הרץ", "▶ Run"), () => void device.inboxCommand(t, "inbox-run")), counting ? null : h("button", { type: "button", class: "btn sm-btn runbtn", onclick: cancel }, L("בטל", "Cancel")), note);
}
/** The curtains this device changed (read once; storage may be off, then they simply are not remembered). */
let curtains = (() => {
    try {
        return parseCurtains(localStorage.getItem(CURTAINS_KEY));
    }
    catch {
        return {};
    }
})();
/**
 * One curtain's head: a button (ArrowDown/Enter/Space work as on any button) with aria-expanded that opens or closes
 * what is under it; the count stays visible when it is closed.
 *
 * @param key - The curtain's key (see curtains.ts).
 * @param open - Whether it is open now.
 * @param count - The number shown on the head.
 * @param count0 - The count the default state depends on (work-list sections).
 * @param label - The head's label.
 * @param cls - The button's class.
 */
function curtainButton(key, open, count, count0, label, cls) {
    return h("button", {
        type: "button",
        class: `curtain ${cls}`,
        "aria-expanded": String(open),
        onclick: () => {
            curtains = toggled(curtains, key, count0);
            try {
                localStorage.setItem(CURTAINS_KEY, serializeCurtains(curtains));
            }
            catch { /* storage off: not remembered */ }
            render();
        },
    }, h("span", { class: "mut xs", "aria-hidden": "true" }, open ? "▾" : "▸"), label, h("span", { class: "tag cnt" }, String(count)));
}
const GROUPS = [
    // Running now first (every task that runs), then Antigravity: its running task first, then the ones that wait for Roee's own Run.
    ["now", "▶", "רצות עכשיו", "Running now"],
    ["agy", "✦", "Antigravity", "Antigravity"],
    ["agents", "🤖", "סוכנים", "Agents"],
    ["gemini", "✧", "Gemini (חינמי)", "Gemini (free)"],
    ["local", "◆", "מקומי", "Local"],
    ["pc", "🖥", "מחשב", "PC"],
    ["claude", "✷", "Claude", "Claude"],
];
/** Which group a task is in: who runs it (Antigravity, the PC's local model or any PC, Claude in the cloud). */
function groupOf(t) {
    const ex = t.inbox?.executor;
    if (ex === "antigravity" || (!ex && t.executor === "pc-antigravity"))
        return "agy";
    if (ex === "gemini")
        return "gemini";
    // The PC's local agent (self-work): its own group, so the task is found by who runs it.
    if (ex === "local")
        return "local";
    if (ex === "claude" || (!ex && t.route === "claude-cloud"))
        return "claude";
    return "pc";
}
/** The agent runs of the PCs that fit the tab, the filters and the search (the Agents group), newest state first. */
function agentRows(q) {
    const now = Date.now();
    return sortedCards(device.agents.values(), now)
        .filter((c) => {
        const w = runToWorkTask(c);
        return w.phase === workState.phase && passes(w, workState.filters) && (!q || c.state.title.toLowerCase().includes(q));
    })
        .slice(0, 10);
}
/** One agent run in the Tasks list: its state, title and PC; it opens the run's card on the Agents tab. */
function agentRow(c) {
    const st = shownState(c, Date.now());
    const rw = runWaitOf(device, c, Date.now());
    const pc = devices().find((d) => d.id === c.deviceId);
    const tag = rw ? runWaitTag() : st === "waiting" ? h("span", { class: "tag t-ask" }, L("מחכה לך", "Waiting for you")) : st === "running" ? h("span", { class: "tag t-run" }, h("span", { class: "spin", "aria-hidden": "true" }), L(" רץ", " Running")) : st === "done" ? h("span", { class: "tag t-ok" }, L("✓ הסתיים", "✓ Done")) : st === "failed" ? h("span", { class: "tag t-bad" }, L("✕ נכשל", "✕ Failed")) : h("span", { class: "tag t-off" }, st === "stale" ? L("לא עונה", "Not answering") : st === "queued" ? L("בתור", "Queued") : L("נעצר", "Stopped"));
    const key = `${c.deviceId}/${c.runId}`;
    return h("div", { class: "trow", role: "button", tabindex: 0, onclick: () => agentsView.setOpen(key), onkeydown: (e) => { if (e.key === "Enter")
            agentsView.setOpen(key); } }, h("span", { class: "c-st" }, tag), h("div", { class: "grow min0" }, h("b", { class: "w5 ell1", dir: "auto" }, c.state.title), c.state.label && isGoing(c) ? h("div", { class: "sm sub wrapl", dir: "auto" }, L(`עכשיו: ${c.state.label}`, `Now: ${c.state.label}`)) : c.state.summary ? h("div", { class: "sm sub wrapl", dir: "auto" }, c.state.summary) : null), h("span", { class: "c-rt" }, h("span", { class: "ex ex-loc" }, `🖥 ${pc?.name ?? "PC"}`)), h("span", { class: "c-when mut sm" }, when(c.state.startedAt || c.at)), h("span", { class: "c-act" }, rw ? runWaitActions(device, c, rw) ?? h("span", { class: "mut sm" }, L("כרטיס ›", "Card ›")) : h("span", { class: "mut sm" }, L("כרטיס ›", "Card ›"))));
}
/**
 * The task list in groups: Agents (the PCs' agent runs), Antigravity, Gemini, Local, PC and Claude, each with a head and a count;
 * an empty group is left out. In the Active tab a task that ended while it was shown stays a moment, then folds away in place.
 *
 * @param list - The tasks that fit the tab, the filters and the search.
 * @param q - The search text (lower case).
 * @param byId - The page's tasks with their work view, by id.
 */
function taskGroups(list, q, byId) {
    const agents = agentRows(q);
    const out = [];
    const entry = (g, t) => ({ id: t.taskId, group: g, build: () => taskRow(t, byId.get(t.taskId)?.work) });
    // Antigravity: the running task first, then the ones that wait for the owner's own Run (marked in their row), then the rest.
    // The available ones are ordered by creation, oldest on top (that is their priority); the standing "what to research next" task is last.
    const agyRank = (t) => (t.inbox?.standing ? 3 : t.status === "running" ? 0 : t.status === "waiting-run" || t.status === "waiting" ? 1 : 2);
    const all = GROUPS.flatMap(([g]) => g === "agents"
        ? agents.map((c) => ({ id: `${c.deviceId}/${c.runId}`, group: g, build: () => agentRow(c) }))
        : g === "now"
            ? list.filter((t) => t.status === "running").map((t) => ({ ...entry(g, t), id: `now:${t.taskId}` }))
            : g === "agy"
                ? list.filter((t) => groupOf(t) === g).sort((a, b) => agyRank(a) - agyRank(b) || (agyRank(a) === 1 ? a.createdAt - b.createdAt : 0)).map((t) => entry(g, t))
                : list.filter((t) => groupOf(t) === g).map((t) => entry(g, t)));
    const folding = workState.phase === "active" ? foldingRows(`${workState.phase}|${JSON.stringify(workState.filters)}|${q}`, all, render) : [];
    for (const [g, icon, he, en] of GROUPS) {
        const rows = all.filter((r) => r.group === g).map((r) => r.build());
        for (const l of folding.filter((x) => x.group === g).sort((x, y) => x.index - y.index))
            rows.splice(Math.min(l.index, rows.length), 0, leavingRow(l.build()));
        if (!rows.length)
            continue;
        const key = `t:${workState.phase}:${g}`;
        const open = curtainOpen(curtains, key, 0, !!q);
        out.push(h("div", { class: "trow ghead", role: "heading", "aria-level": 3 }, curtainButton(key, open, rows.length, 0, h("span", { class: "grow row" }, h("span", { "aria-hidden": "true" }, icon), h("b", null, L(he, en))), "ghead-btn"), g === "agy" || g === "local" ? askNextToggle(g, list) : null, g === "agy" ? runAllButton(device) : null), ...(open ? rows : []));
    }
    return out;
}
/** A creation time as "22.11 08:41" (day.month hour:minute, this device's clock). */
function stamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** The statuses where "Who does it" and "Add to queue" are shown on the row. */
const CHOOSABLE = new Set(["waiting", "waiting-run", "failed", "partial", "deferred"]);
/**
 * "Ask before the next task" for an executor's queue, as a switch in the group's head (the PC keeps it and reports it
 * with each task): on, the PC asks "Next in line - Start?" when a task ends; off, the next queued task starts by itself.
 *
 * @param g - The group (Antigravity or Local).
 * @param list - The shown tasks (the switch's state comes from the PC's report on any task of that executor).
 */
function askNextToggle(g, list) {
    const ex = g === "agy" ? "antigravity" : "local";
    const mine = [...list, ...allTasks()].find((t) => t.inbox && t.inbox.executor === ex && t.inbox.askNext !== undefined);
    if (!mine || !device.connected)
        return null;
    const on = mine.inbox.askNext === true;
    return h("button", { type: "button", class: `chip${on ? " chip-on" : ""}`, role: "switch", "aria-checked": String(on), title: L("כשמשימה מסתיימת: לשאול לפני שהבאה בתור מתחילה", "When a task ends: ask before the next queued one starts"), onclick: (e) => { e.stopPropagation(); void device.setAskNext(ex, !on); } }, on ? L("שאל לפני הבאה", "Ask before next") : L("הבאה מתחילה לבד", "Next starts by itself"));
}
/**
 * The line under a task that can still be given to someone or queued: its executor ("Who does it", with Gemini,
 * Antigravity, Local and Claude) and, for Antigravity and Local, "Add to queue" / its place in the line with "Take out".
 *
 * @param t - A task of a PC's inbox that waits, failed, ended partly or was deferred.
 */
/** The model picker's part of "Who does it" for an Antigravity task that has not started (its PC sent the models). */
function inboxModel(t) {
    return t.inbox?.executor === "antigravity" && t.inbox.models?.length ? { model: { list: t.inbox.models, pick: t.inbox.model ?? "" } } : {};
}
function taskControls(t) {
    if (!t.inbox || !CHOOSABLE.has(t.status))
        return null;
    const ex = t.inbox.executor;
    const pcs = device.assignTargets(t);
    const a = device.taskActions.get(t.taskId);
    const queueable = (ex === "antigravity" || ex === "local") && device.connected && device.assignTargets(t).length > 0;
    const place = t.inbox.lineAt;
    const stop = (e) => e.stopPropagation();
    return h("div", { class: "row wrap tctl", onclick: stop }, assignBox({ device, render, taskId: t.taskId, pcs, current: assignOfExecutor(ex === "claude" ? "opus" : ex), ...inboxModel(t) }), queueable ? (place ? h("span", { class: "row" }, h("span", { class: "tag t-run" }, L(`בתור #${place}`, `Queued #${place}`)), h("button", { type: "button", class: "btn sm-btn", onclick: () => void device.inboxCommand(t, "inbox-unqueue") }, L("הסר מהתור", "Take out"))) : h("button", { type: "button", class: "btn sm-btn", onclick: () => void device.inboxCommand(t, "inbox-queue") }, L("＋ הוסף לתור", "＋ Add to queue"))) : null, a && (a.action === "inbox-queue" || a.action === "inbox-unqueue") && a.result && !a.result.ok ? h("span", { class: "xs warn wrapl", dir: "auto" }, a.result.text) : null);
}
/** One row of the task list. */
function taskRow(t, work) {
    const expired = !t.inbox && HubDevice.expired(t);
    const live = liveCard(t);
    const run = runButtons(t);
    const action = run
        ? run
        : t.drive?.only
            ? t.link && isSafeLink(t.link)
                ? h("a", { class: "btn sm-btn", href: t.link, target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, L("פתח", "Open"))
                : null
            : t.inbox
                ? live
                    ? h("button", { type: "button", class: "btn sm-btn", onclick: (e) => { e.stopPropagation(); agentsView.setOpen(live); } }, L("● חי ›", "● Live ›"))
                    : null
                : t.status === "outbox" || expired
                    ? h("button", { type: "button", class: "btn sm-btn", onclick: (e) => { e.stopPropagation(); void (expired ? device.resend(t, cloudAvailable()).then(() => device.remove(t.taskId)) : device.remove(t.taskId)); } }, expired ? L("שלח שוב", "Send again") : L("בטל", "Cancel"))
                    : t.status === "waiting" && cloudAvailable()
                        ? h("button", { type: "button", class: "btn sm-btn", onclick: (e) => { e.stopPropagation(); void device.resend(t, true, "claude-cloud"); } }, L("שלח לענן במקום", "Send to the cloud instead"))
                        : t.status === "failed"
                            ? h("button", { type: "button", class: "btn sm-btn", onclick: (e) => { e.stopPropagation(); void device.resend(t, cloudAvailable()); } }, L("נתב מחדש", "Route again"))
                            : t.link && isSafeLink(t.link)
                                ? h("a", { class: "btn sm-btn", href: t.link, target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, t.route === "claude-cloud" ? L("פתח ב-Claude", "Open in Claude") : L("פתח", "Open"))
                                : null;
    return h("div", { class: `trow${app.openTask === t.taskId ? " sel" : ""}${t.status === "waiting-run" ? " needsrun-row" : ""}`, role: "button", tabindex: 0, onclick: () => { app.openTask = app.openTask === t.taskId ? undefined : t.taskId; render(); }, onkeydown: (e) => { if (e.key === "Enter") {
            app.openTask = t.taskId;
            render();
        } } }, h("span", { class: "c-st" }, statusTag(t)), h("div", { class: "grow min0" }, h("div", { class: "row wrap tline" }, h("b", { class: "w5 ell1" }, t.title), sourceChip(t), deviceChip(t), t.status === "waiting-run" ? h("span", { class: "tag t-ask needsrun" }, L("✋ דורש הפעלה ידנית", "✋ Needs your Run")) : null, t.inbox?.standing ? h("span", { class: "tag t-off" }, L("🔎 מה לחקור הלאה", "🔎 What to research next")) : null, t.inbox && CHOOSABLE.has(t.status) ? h("span", { class: "xs mut", dir: "ltr", title: L("נוצרה", "Created") }, stamp(t.createdAt)) : null), taskControls(t), t.branch && t.inbox ? h("div", { class: "xs mono mut ell" }, t.branch) : null, stepsLine(t) ? h("div", { class: "xs mut" }, stepsLine(t)) : null, work?.phase === "failed" ? failedBlock(workView, t, work) : work?.phase === "done" ? doneLine(t) : t.line ? h("div", { class: "sm sub wrapl", dir: "auto" }, t.line) : t.status === "waiting" && !t.inbox && !t.drive?.only ? h("div", { class: "sm sub wrapl" }, L(`${t.toName} כבוי. יימסר כשיידלק`, `${t.toName} is off. It is delivered when it comes on`)) : null), h("span", { class: "c-rt" }, routeChip(t)), h("span", { class: "c-when mut sm" }, when(t.createdAt)), h("span", { class: "c-act" }, action));
}
/** The open task, with its answer and timeline. */
function taskDetail(t) {
    return h("section", { class: `card pad stack${t.status === "done" ? " done-card" : ""}` }, h("div", { class: "row wrap" }, statusTag(t), h("b", { class: "grow" }, t.title), sourceChip(t), deviceChip(t), routeChip(t), t.inbox ? h("span", { class: "mut sm" }, `${L("במחשב", "on")} ${t.toName}`) : null, stepsLine(t) ? h("span", { class: "chip steps" }, stepsLine(t)) : null, liveCard(t) ? h("button", { type: "button", class: "btn", onclick: () => agentsView.setOpen(liveCard(t)) }, L("● כרטיס הסוכן החי ›", "● Live agent card ›")) : null, t.link && isSafeLink(t.link) ? h("a", { class: "btn", href: t.link, target: "_blank", rel: "noopener noreferrer" }, t.route === "claude-cloud" ? L("פתח ב-Claude ↗", "Open in Claude ↗") : L("פתח ↗", "Open ↗")) : null, h("button", { type: "button", class: "btn", onclick: () => void navigator.clipboard?.writeText(t.line ?? t.spec) }, L("העתק", "Copy"))), t.line || t.spec ? h("div", { class: "sm answer" }, t.line ?? t.spec) : h("div", { class: "sm mut" }, t.inbox ? L("משימה מתיבת המשימות במחשב (ענף kesher-inbox). התוכן שלה נשאר במחשב.", "A task from the PC's task inbox (the kesher-inbox branch). Its text stays on the PC.") : ""), t.branch ? h("div", { class: "sm" }, L("ענף ", "Branch "), h("span", { class: "mono" }, t.branch)) : null, t.inbox || t.drive ? assignBox({ device, render, taskId: t.taskId, pcs: device.assignTargets(t), current: t.inbox ? assignOfExecutor(t.inbox.executor === "claude" ? "opus" : t.inbox.executor) : undefined, ...inboxModel(t) }) : null, h("div", { class: "pl" }, t.history.map((x) => `${when(x.t)} ${L(x.he, x.en)}`).join(" · ")));
}
/** "Pair this device" (the page itself), for sending tasks. */
function pairThisCard() {
    if (device.pending)
        return selfPairing();
    return h("section", { class: "card pad stack" }, h("b", null, L("לחבר את המכשיר הזה", "Pair this device")), h("span", { class: "mut sm" }, L("כדי לשלוח משימות מכאן ולשמור אותן, הדף צריך מפתח משלו. המפתח נשאר בדפדפן הזה ולא יוצא ממנו.", "To send tasks from here and keep them, this page needs a key of its own. The key stays in this browser and never leaves it.")), h("div", { class: "row wrap" }, h("input", { class: "inp grow", maxlength: 60, placeholder: L("שם המכשיר (למשל: הטלפון)", "Device name (e.g. Phone)"), "aria-label": L("שם המכשיר", "Device name"), value: app.selfName, oninput: (e) => { app.selfName = e.target.value; } }), h("button", { type: "button", class: "btn pri", onclick: () => void startSelfPair() }, L("חבר", "Pair"))));
}
/** The pair tab (HubPair): approve another device's code after comparing the fingerprint; or pair this one. */
function pairTab() {
    const code = app.pairCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const boxes = Array.from({ length: 8 }, (_, i) => h("span", { class: `cbox${i < code.length ? " full" : ""}` }, code[i] ?? ""));
    boxes.splice(4, 0, h("span", { class: "mut dash" }, "-"));
    const approve = app.signedIn
        ? h("section", { class: "sec" }, h("h3", null, L("1. הקוד מהמכשיר החדש", "1. The code from the new device")), h("span", { class: "mut sm" }, L("במחשב: הגדרות › ענן Kesher › \"חבר למרכז שלי\". בטלפון: לשונית ענן › \"לחבר את המכשיר הזה\".", "On a PC: Settings › Kesher Cloud › \"Connect to my hub\". On a phone: the Cloud tab › \"Pair this device\".")), h("label", { class: "codewrap" }, h("span", { class: "row center gap6", dir: "ltr", "aria-hidden": "true" }, boxes), h("input", { class: "code-input", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: 9, "aria-label": L("הקוד בן 8 התווים", "The 8-character code"), value: app.pairCode, oninput: (e) => { app.pairCode = e.target.value; app.peek = undefined; renderSoon(); } })), h("span", { class: "mut sm center" }, L("הקוד תקף 5 דקות, לשימוש אחד", "The code is valid for 5 minutes, for one use")), h("label", { class: "stack0" }, h("span", { class: "mut sm" }, L("שם המכשיר", "Device name")), h("input", { class: "inp", maxlength: 60, value: app.pairName, placeholder: L("למשל: הלפטופ", "e.g. Laptop"), oninput: (e) => { app.pairName = e.target.value; } })), h("span", { class: "mut sm" }, L("מה הוא יוכל: לקבל משימות, לדווח מצב. לא לשנות הגדרות.", "What it can do: take tasks and report status. Not change settings.")), !app.peek ? h("button", { type: "button", class: "btn pri", disabled: code.length !== 8 || app.busy, onclick: () => void peekCode(code) }, L("המשך להשוואה", "Continue to compare")) : null)
        : signInCard(L("רק מי שמחובר עם Google יכול לאשר מכשיר חדש.", "Only a screen signed in with Google can approve a new device."));
    const compare = app.peek
        ? h("section", { class: "sec accent" }, h("h3", null, L("2. השוו טביעת אצבע", "2. Compare the fingerprint")), h("span", { class: "sm lines" }, L("אותם 6 מספרים צריכים להופיע עכשיו גם על המסך של המכשיר החדש. כך המרכז לא יכול להחליף מפתח בלי שתשים לב.", "The same 6 digits must show on the new device's screen now. That way the hub cannot swap a key without you noticing.")), h("div", { class: "code6", dir: "ltr" }, app.peek.fingerprint), h("div", { class: "row center mut sm" }, `${deviceIcon(app.peek.kind)} ${app.peek.name}`), h("div", { class: "row" }, h("button", { type: "button", class: "btn grow bad", onclick: () => { app.peek = undefined; app.pairCode = ""; render(); } }, L("לא תואם, בטל", "Does not match, cancel")), h("button", { type: "button", class: "btn pri grow", disabled: app.busy, onclick: () => void approveCode(code) }, L("תואם, חבר", "Matches, pair"))))
        : null;
    return h("main", { class: "page" }, h("h1", null, L("חיבור מכשיר", "Pair a device")), h("div", { class: "grid2" }, approve, compare ?? (device.paired ? h("section", { class: "sec" }, h("h3", null, L("המכשיר הזה", "This device")), h("span", { class: "sm" }, L(`מחובר בשם "${device.name ?? ""}".`, `Paired as "${device.name ?? ""}".`)), h("span", { class: "mut sm" }, L("כדי לחבר מחשב: במחשב, הגדרות › ענן Kesher, הקלידו את כתובת המרכז ולחצו \"חבר למרכז שלי\".", "To pair a PC: on the PC, Settings › Kesher Cloud, type the hub's address and press \"Connect to my hub\"."))) : pairThisCard())), relay());
}
/** Looks a code up (fingerprint first, approve after). */
async function peekCode(code) {
    const r = await post("/api/pair/check", { code }).catch(() => undefined);
    if (r?.status === 200 && typeof r.data.fingerprint === "string")
        app.peek = { kind: String(r.data.kind), name: String(r.data.name), fingerprint: r.data.fingerprint };
    else
        app.note = { he: `לא הצליח: ${String(r?.data.error ?? "אין תשובה")}`, en: `Did not work: ${String(r?.data.error ?? "No answer")}`, bad: true };
    render();
}
/** Approves the code after the fingerprint matched. */
async function approveCode(code) {
    const r = await act("/api/pair/approve", { code, name: app.pairName.trim() || undefined }, { he: "המכשיר חובר. הוא יופיע ברשימה בעוד רגע.", en: "The device is paired. It shows in the list in a moment." });
    if (r) {
        app.peek = undefined;
        app.pairCode = "";
        app.pairName = "";
        render();
    }
}
const AUDIT = {
    signin: ["התחברות", "Signed in"],
    "signin-refused": ["ניסיון התחברות נדחה", "Sign-in refused"],
    "owner-pinned": ["החשבון ננעל לבעלים", "Owner account pinned"],
    "pair-start": ["מכשיר ביקש חיבור", "A device asked to pair"],
    "pair-approve": ["קוד אושר", "Code approved"],
    "push-on": ["התראות הופעלו במכשיר", "Notifications turned on for a device"],
    "push-off": ["התראות כובו במכשיר", "Notifications turned off for a device"],
    "push-gone": ["שירות ההתראות הודיע שהמכשיר הוסר", "The push service said the device's subscription is gone"],
    "push-failed": ["התראה לא נשלחה", "A notification was not sent"],
    "pair-done": ["מכשיר חובר", "Device paired"],
    "token-rotated": ["מפתח הגישה הוחלף", "Token rotated"],
    revoke: ["מכשיר נותק", "Device disconnected"],
    pause: ["המרכז הושהה", "Hub paused"],
    resume: ["המרכז חזר לעבוד", "Hub resumed"],
    "cloud-off": ["Claude בענן כובה", "Claude cloud off"],
    "cloud-on": ["Claude בענן הופעל", "Claude cloud on"],
    "kill-all": ["כל המכשירים נותקו", "All devices revoked"],
    "queue-dropped": ["התור נמחק", "Queue dropped"],
    "agents-dropped": ["פעילות הסוכנים נמחקה", "Agent activity deleted"],
    connect: ["מכשיר התחבר", "Device connected"],
    "cloud-fired": ["משימה נשלחה ל-Claude בענן", "Task sent to Claude cloud"],
    "cloud-failed": ["Claude בענן לא התחיל משימה", "Claude cloud failed to start"],
    "relay-approval_answer": ["תשובה לאישור נשלחה למחשב", "Approval answer sent to a PC"],
    "relay-command": ["הרצה או ביטול של משימה נשלחו למחשב", "Run or Cancel of a task sent to a PC"],
    "mcp-client-registered": ["Claude נרשם כאפליקציה", "Claude registered as an app"],
    "mcp-approved": ["אישרת חיבור של Claude", "You approved a Claude connection"],
    "mcp-denied": ["סירבת לחיבור של Claude", "You refused a Claude connection"],
    "mcp-connected": ["Claude התחבר", "Claude connected"],
    "mcp-revoked": ["חיבור של Claude נותק", "A Claude connection was revoked"],
    "mcp-refresh-reused": ["מפתח רענון ישן חזר: החיבור נותק", "An old refresh token came back: the connection was ended"],
    "mcp-list_devices": ["Claude: רשימת מכשירים", "Claude: list devices"],
    "mcp-get_agent_status": ["Claude: מצב הסוכנים", "Claude: agent status"],
    "mcp-waiting_for_approval": ["Claude: כמה מחכה לאישור", "Claude: waiting for approval"],
    "mcp-list_tasks": ["Claude: רשימת משימות", "Claude: list tasks"],
    "mcp-send_task": ["Claude שלח משימה למחשב", "Claude sent a task to a PC"],
};
/** The settings tab (HubSettings): kill switches, what the hub holds, this device, the activity log. */
function settingsTab() {
    const o = app.owner;
    const name = (id) => (id ? (devices().find((d) => d.id === id)?.name ?? o?.connections?.find((c) => c.id === id)?.name ?? id.slice(0, 6)) : "");
    const owner = o
        ? [
            h("section", { class: "sec" }, h("h3", null, L("מתגי עצירה", "Kill switches")), h("div", { class: "kill" }, h("span", { class: "ki", "aria-hidden": "true" }, "⏸"), h("span", { class: "grow" }, h("b", null, L("השהה את המרכז", "Pause the hub")), h("div", { class: "mut sm" }, L("לא מעביר כלום וסוגר את החיבורים; הנתונים נשמרים", "Relays nothing and closes the connections; data is kept"))), h("button", { type: "button", role: "switch", class: `tog${o.paused ? "" : " off"}`, "aria-checked": o.paused, "aria-label": L("השהה את המרכז", "Pause the hub"), disabled: app.busy, onclick: () => void act("/api/kill", { what: o.paused ? "resume" : "pause" }) })), h("div", { class: "kill" }, h("span", { class: "ki", "aria-hidden": "true" }, "✷"), h("span", { class: "grow" }, h("b", null, o.cloudOff ? L("Claude בענן כבוי", "Claude cloud is off") : L("כבה את Claude בענן", "Turn Claude cloud off")), h("div", { class: "mut sm" }, L("משימות לא יישלחו לענן. למחיקת הטוקן: בהגדרות המשימה המתוזמנת ב-claude.ai", "No task goes to the cloud. To delete the token: in the scheduled task's settings at claude.ai"))), h("button", { type: "button", class: `btn${o.cloudOff ? "" : " bad"}`, disabled: app.busy, onclick: () => void act("/api/kill", { what: o.cloudOff ? "cloud-on" : "cloud-off" }) }, o.cloudOff ? L("הפעל", "Turn on") : L("כבה", "Turn off"))), h("div", { class: "kill" }, h("span", { class: "ki", "aria-hidden": "true" }, "⛔"), h("span", { class: "grow" }, h("b", null, L("נתק את כל המכשירים", "Disconnect every device")), h("div", { class: "mut sm" }, L("גם מתנתק מכל הדפדפנים. כל מכשיר יצטרך להתחבר מחדש עם קוד", "Also signs out every browser. Each device must pair again with a code"))), h("button", { type: "button", class: "btn bad", disabled: app.busy, onclick: () => confirm(L("לנתק את כל המכשירים ולהתנתק מכל הדפדפנים?", "Disconnect every device and sign out of every browser?")) && void act("/api/kill", { what: "everything" }).then(() => device.forget()) }, L("נתק הכול", "Disconnect all"))), h("div", { class: "kill soft" }, h("span", { class: "ki", "aria-hidden": "true" }, "🚪"), h("span", { class: "grow" }, h("b", null, L("התנתק בדפדפן הזה", "Sign out in this browser")), h("div", { class: "mut sm" }, L("התחברות מחדש עם Google", "Sign in again with Google"))), h("button", { type: "button", class: "btn", disabled: app.busy, onclick: () => void act("/api/signout", {}) }, L("התנתק", "Sign out")))),
            h("section", { class: "sec" }, h("h3", null, L("מה המרכז מחזיק עכשיו", "What the hub holds now")), h("div", { class: "grid3" }, h("div", { class: "card stat" }, h("b", null, String(o.queued)), h("div", { class: "mut sm" }, L("הודעות נעולות בתור", "Sealed messages queued"))), h("div", { class: "card stat" }, h("b", null, String(o.devices.length)), h("div", { class: "mut sm" }, L("מכשירים", "Devices"))), h("div", { class: "card stat" }, h("b", null, String(o.audit.length)), h("div", { class: "mut sm" }, L("שורות פעילות אחרונות", "Recent activity lines")))), h("span", { class: "sm lines" }, L("ההודעות נעולות במפתח של המכשיר שמקבל אותן; המרכז לא יכול לקרוא אותן. כל הודעה נמחקת כשהתקבלה, או אחרי 24 שעות.", "Messages are sealed to the receiving device's key; the hub cannot read them. Each is deleted once received, or after 24 hours.")), h("div", null, h("button", { type: "button", class: "btn bad", disabled: app.busy || !o.queued, onclick: () => confirm(L("למחוק את כל ההודעות שבתור?", "Delete every queued message?")) && void act("/api/kill", { what: "drop-queue" }) }, L("מחק את כל התור עכשיו", "Delete the whole queue now"))), o.agents
                ? h("div", { class: "kill soft" }, h("span", { class: "ki", "aria-hidden": "true" }, "🤖"), h("span", { class: "grow" }, h("b", null, L(`פעילות סוכנים: ${o.agents.kept} חבילות נעולות`, `Agent activity: ${o.agents.kept} sealed batches`)), h("div", { class: "mut sm" }, L(`נכתבו היום ${o.agents.writtenToday.toLocaleString()} שורות מתוך ${o.agents.freeWrites.toLocaleString()} בתוכנית החינמית. 50 אירועים לכל סוכן, 7 ימים.`, `Written today: ${o.agents.writtenToday.toLocaleString()} of ${o.agents.freeWrites.toLocaleString()} rows on the free plan. 50 events per agent, 7 days.`))), h("button", { type: "button", class: "btn bad", disabled: app.busy || !o.agents.kept, onclick: () => confirm(L("למחוק את כל פעילות הסוכנים שהמרכז שומר?", "Delete all the agent activity the hub keeps?")) && void act("/api/kill", { what: "drop-agents" }) }, L("מחק", "Delete")))
                : null),
            o.connections ? connectorSection(o.connections, app.busy, (c) => void act(`/api/connections/${encodeURIComponent(c.id)}/revoke`, {}, { he: `"${c.name}" נותק`, en: `"${c.name}" was revoked` })) : null,
            h("section", { class: "sec" }, h("h3", null, L("חשבון", "Account")), h("div", { class: "row" }, h("span", { class: "grow" }, L("מחובר עם Google · רק החשבון הזה נכנס", "Signed in with Google · only this account gets in")), h("span", { class: "tag t-ok" }, L("נעול לחשבון אחד", "Locked to one account")))),
        ]
        : [signInCard(L("מתגי העצירה ויומן הפעילות זמינים רק אחרי התחברות.", "The kill switches and the activity log are available only after signing in."))];
    return h("main", { class: "page" }, h("h1", null, L("הגדרות המרכז", "Hub settings")), h("div", { class: "grid2" }, h("div", { class: "stack" }, owner.slice(0, 1), owner.slice(2)), h("div", { class: "stack" }, owner.slice(1, 2), h("section", { class: "sec" }, h("h3", null, L("המכשיר הזה", "This device")), device.paired ? h("div", { class: "row" }, h("span", { class: "grow" }, L(`מחובר בשם "${device.name ?? ""}" · המשימות נשמרות כאן`, `Paired as "${device.name ?? ""}" · tasks are kept here`)), h("span", { class: `tag ${device.connected ? "t-ok" : "t-off"}` }, device.connected ? L("מחובר", "Connected") : L("לא מחובר", "Not connected"))) : h("span", { class: "mut sm" }, L("לא מחובר כמכשיר (אפשר לחבר בלשונית חיבור).", "Not paired as a device (pair it in the Pair tab).")), device.paired ? h("div", null, h("button", { type: "button", class: "btn bad", onclick: () => confirm(L("לשכוח את המכשיר הזה? המפתח והמשימות שנשמרו כאן יימחקו.", "Forget this device? Its key and the tasks kept here are deleted.")) && void device.forget().then(() => drive.forget()) }, L("שכח את המכשיר הזה", "Forget this device"))) : null, h("div", { class: "row" }, h("span", { class: "grow" }, L("שפה", "Language")), h("button", { type: "button", class: "btn", onclick: () => { setLocale(getLocale() === "he" ? "en" : "he"); render(); } }, getLocale() === "he" ? "English" : "עברית"))), notifySection(pushView), o
        ? h("section", { class: "sec" }, h("h3", null, L("יומן פעילות", "Activity log")), h("span", { class: "mut xs" }, L("רק סוג האירוע, המכשיר והשעה (30 יום). בלי תוכן.", "Only the event type, the device and the time (30 days). No content.")), h("ul", { class: "audit" }, o.audit.length ? o.audit.slice(0, 60).map((a) => h("li", null, h("span", { class: "mut xs" }, when(a.ts)), " ", AUDIT[a.action] ? L(...AUDIT[a.action]) : a.action.startsWith("relay-") ? L(`הועבר: ${a.action.slice(6)}`, `Relayed: ${a.action.slice(6)}`) : a.action, a.deviceId ? h("span", { class: "mut" }, ` · ${name(a.deviceId)}`) : null)) : h("li", { class: "mut" }, L("ריק", "Empty"))))
        : null)));
}
// ---- rendering ----
let renderTimer;
/** Re-renders soon (typing in a search box). */
function renderSoon() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 150);
}
/** Draws the page. Text being typed is kept (the form values live in `app`), and the focused field is restored. */
function render() {
    const root = document.getElementById("app");
    const focus = document.activeElement;
    const focusKey = focus && root.contains(focus) && (focus.tagName === "INPUT" || focus.tagName === "TEXTAREA") ? (focus.getAttribute("aria-label") ?? "") : "";
    const caret = focusKey ? focus.selectionStart : null;
    const scroller = document.scrollingElement;
    const y = scroller?.scrollTop ?? 0;
    const showSignIn = !app.signedIn && !device.paired;
    const body = showSignIn ? signInScreen() : { dash: dashboard, agents: () => agentsTab(agentsView), devices: devicesTab, tasks: tasksTab, new: newTask, quotas: () => quotasPage(quotasView), pair: pairTab, settings: settingsTab }[tab()]();
    root.replaceChildren(...[whereBar(), showSignIn ? null : topBar(), showSignIn ? null : pcOffBanner(), (device.hasRelays && device.relayPath !== "hub" ? relayLine(device.relayPath) : pathLine(hubProbe, app.appOrigin)), rememberedLine(), noteLine(), device.error ? h("div", { class: "note bad-note", role: "alert" }, L(device.error.he, device.error.en)) : null, body, showSignIn ? null : tabs("bottom-tabs")].filter((x) => !!x));
    root.classList.toggle("in-app", !!app.appOrigin);
    if (scroller)
        scroller.scrollTop = y;
    if (focusKey) {
        const again = [...root.querySelectorAll("input, textarea")].find((el) => el.getAttribute("aria-label") === focusKey);
        if (again) {
            again.focus();
            if (caret !== null)
                again.setSelectionRange(caret, caret);
        }
    }
    mountGis();
}
let gisLoading;
/** Loads Google's script once (sign-in button and the Drive token client); undefined when it cannot load. */
function loadGis() {
    if (!app.googleClientId || app.inApp)
        return Promise.resolve(undefined);
    gisLoading ??= new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "https://accounts.google.com/gsi/client";
        s.async = true;
        s.onload = () => {
            const g = window.google;
            g?.accounts.id.initialize({ client_id: app.googleClientId, ux_mode: "popup", callback: (r) => void signIn(r.credential ?? "") });
            resolve(g);
        };
        s.onerror = () => resolve(undefined);
        document.head.append(s);
    });
    return gisLoading;
}
/** Draws Google's sign-in button wherever the page has a `.gis` box. */
function mountGis() {
    const boxes = [...document.querySelectorAll(".gis")];
    if (!boxes.length || !app.googleClientId || app.inApp)
        return;
    void loadGis().then((g) => {
        for (const b of boxes)
            if (g && b.isConnected && !b.childElementCount)
                g.accounts.id.renderButton(b, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: Math.min(340, b.clientWidth || 320), locale: getLocale() });
    });
}
/** Sends Google's ID token to the hub, which checks it is the owner and sets the session cookie. */
async function signIn(credential) {
    const r = await post("/api/signin", { credential }).catch(() => undefined);
    if (r?.status === 200) {
        app.note = undefined;
        await loadOwner();
    }
    else {
        app.note = { he: r?.status === 403 ? "אין גישה: המרכז הזה פרטי" : "ההתחברות נכשלה", en: r?.status === 403 ? "No access: this hub is private" : "Sign-in failed", bad: true };
        render();
    }
}
/** The phone app's origin, when the page was opened from it. Only the app's own local origins are accepted. */
function appOriginFrom() {
    const asked = new URLSearchParams(location.search).get("app");
    const ok = (x) => (x === "http://localhost" || x === "https://localhost" ? x : undefined);
    try {
        if (asked !== null) {
            const v = ok(asked);
            if (v)
                sessionStorage.setItem("kh-app", v);
            history.replaceState(null, "", location.pathname + location.hash);
            return v;
        }
        return ok(sessionStorage.getItem("kh-app"));
    }
    catch {
        return ok(asked);
    }
}
/** The query marker that asks the KesherAI app to open an address in the phone's browser. */
const EXTERNAL = "kesher-external";
/** Removes the "open in the browser" marker from the address once the page is open (it has done its job). */
function dropExternalMarker() {
    const q = new URLSearchParams(location.search);
    if (!q.has(EXTERNAL))
        return;
    q.delete(EXTERNAL);
    const rest = q.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
}
/**
 * Whether the page runs inside an app's WebView, where Google blocks its sign-in (`disallowed_useragent`) and its
 * popup has nowhere to go: opened from the KesherAI app (`?app=`), or an Android WebView (`; wv)` in the user agent).
 * @param appOrigin - The KesherAI app's origin, when the page was opened from it.
 * @param ua - The browser's user agent.
 */
function inWebView(appOrigin, ua) {
    return !!appOrigin || /; wv\)/.test(ua);
}
/** Starts the page. */
async function main() {
    initLocale();
    dropExternalMarker();
    // A Drive token the KesherAI app handed over in the fragment: taken into memory and wiped from the address at once.
    const handed = parseAppToken(location.hash, Date.now());
    if (location.hash.startsWith("#kdt="))
        history.replaceState(null, "", location.pathname + location.search + "#tasks");
    app.appOrigin = appOriginFrom();
    app.inApp = inWebView(app.appOrigin, navigator.userAgent);
    device.onChange(() => {
        // This browser just paired while signed in: the owner's list should show it.
        if (app.signedIn && device.id && app.owner && !app.owner.devices.some((d) => d.id === device.id))
            void loadOwner();
        // Fingerprints for the presence list (the signed-in state has them already).
        for (const d of device.presence)
            if (!fingerprints.has(d.id))
                void keyFingerprint(d.publicKey).then((f) => { fingerprints.set(d.id, f); renderSoon(); });
        // Not while typing: a presence update must not take the cursor away (the next change or blur draws it).
        const a = document.activeElement;
        if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT"))
            return void a.addEventListener("blur", () => renderSoon(), { once: true });
        render();
    });
    addEventListener("hashchange", () => {
        app.note = undefined;
        if (location.hash !== "#agents")
            app.openAgent = undefined;
        render();
        scrollTo(0, 0);
    });
    // A hung connection (Cloudflare down, the page from the service worker's copy) must not hold the page: 5 seconds.
    const cfg = await fetch("/api/config", { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({}));
    app.googleClientId = typeof cfg.googleClientId === "string" ? cfg.googleClientId : "";
    app.vapidKey = typeof cfg.vapidPublicKey === "string" && /^[\w-]{80,100}$/.test(cfg.vapidPublicKey) ? cfg.vapidPublicKey : "";
    await device.load();
    // The service worker (notifications, installing the hub as an app); a shown "waiting" notification closes when the page is seen.
    void startPush(pushView);
    addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible")
            clearShown();
    });
    // The app's token is taken only inside an Android WebView opened from the app (a link elsewhere cannot plant one).
    await drive.load(handed && app.appOrigin && /; wv\)/.test(navigator.userAgent) ? handed : undefined);
    await loadOwner();
    // The signed-in state (who is on, the log) every 20 seconds while the page is visible.
    setInterval(() => {
        if (app.signedIn && document.visibilityState === "visible")
            void loadOwner();
    }, 20_000);
    // Elapsed times and "not answering" move on their own while an agent runs (not while typing).
    setInterval(() => {
        const a = document.activeElement;
        const typing = a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT");
        if (!typing && document.visibilityState === "visible" && (tab() === "agents" || tab() === "dash") && [...device.agents.values()].some(isGoing))
            render();
    }, 5000);
}
/** The page could not start (a network or script error): a short message with a retry, never a blank page. */
function showFatal(err) {
    console.error(err);
    const root = document.getElementById("app");
    if (!root)
        return;
    root.replaceChildren(h("main", { class: "signin", role: "alert" }, h("div", { class: "logo", "aria-hidden": "true" }, "☁"), h("h1", null, "Kesher Cloud"), h("p", { class: "warn sm" }, L("הדף לא נטען. בדקו את החיבור לאינטרנט ונסו שוב.", "The page did not load. Check the internet connection and try again.")), h("button", { type: "button", class: "btn pri", onclick: () => location.reload() }, L("נסה שוב", "Try again"))));
}
main().then(() => document.documentElement.setAttribute("data-ready", ""), showFatal);
