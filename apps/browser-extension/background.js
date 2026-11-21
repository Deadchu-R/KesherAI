/* global readPage, clickRef, typeRef */
// KesherAI browser extension: connects to the KesherAI app on this computer and carries out
// the agent's browser commands (list tabs, open, read, click, type, screenshot).
// The app asks you before each action unless you chose otherwise. It never types into password fields.
// From 0.3.0 (Chrome, Edge, Brave): the app's exact tools (page snapshot, console, network, keys…) run over
// chrome.debugger, with the optional "debugger" permission asked the first time a task needs it (debug.html).

// The page helpers (readPage, clickRef, typeRef) are in page.js, shared with the KesherAI app's own browser.
if (typeof readPage === "undefined" && typeof importScripts === "function") importScripts("page.js");

let ws;
let state = "off"; // off | connecting | on | wrong-key | no-app

async function settings() {
  const s = await chrome.storage.local.get({ key: "", port: 7420, enabled: true });
  return s;
}

function setState(s) {
  state = s;
  chrome.action.setBadgeText({ text: s === "on" ? "" : s === "connecting" ? "…" : "!" });
  chrome.action.setBadgeBackgroundColor({ color: s === "wrong-key" ? "#c0392b" : "#777" });
}

async function connect() {
  const { key, port, enabled } = await settings();
  if (!enabled || !key) return setState("off");
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setState("connecting");
  const browser = /Firefox\//.test(navigator.userAgent) ? "Firefox" : /Edg\//.test(navigator.userAgent) ? "Edge" : /Brave/.test(navigator.userAgent) ? "Brave" : "Chrome";
  // "cdp": this browser can have chrome.debugger (Firefox cannot), so the app may use its CDP tools here.
  // (chrome.debugger itself only shows up once the user allowed the optional permission.)
  const features = browser === "Firefox" ? "" : "cdp";
  const sock = new WebSocket(`ws://127.0.0.1:${port}/api/browser/connect?key=${encodeURIComponent(key)}&browser=${browser}&version=${chrome.runtime.getManifest().version}&features=${features}`);
  ws = sock;
  sock.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "ready") return setState("on");
    if (msg.type === "error") return setState(msg.error === "wrong-key" ? "wrong-key" : "off");
    if (msg.type === "pong") return;
    if (!msg.id) return;
    try {
      const result = await run(msg.action, msg.args || {});
      sock.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      sock.send(JSON.stringify({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err) }));
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = undefined;
    // Without the app nobody needs the debugger: let go of every tab (Chrome's bar goes away).
    void detachAll();
    if (state !== "wrong-key") setState("no-app");
  };
  sock.onerror = () => undefined;
}

// Keep the connection (and this worker) alive, and reconnect when the app starts.
chrome.alarms.create("kesher-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  else void connect();
  detachIdle();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.storage.onChanged.addListener(() => { ws?.close(); ws = undefined; void connect(); });
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m === "state") reply({ state });
  if (m === "reconnect") { ws?.close(); ws = undefined; void connect().then(() => reply({ state })); return true; }
});
void connect();

async function tabOf(tabId) {
  if (typeof tabId === "number") return chrome.tabs.get(tabId);
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("No tab is open.");
  return t;
}

function waitLoaded(tabId, ms = 20000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(timer); setTimeout(resolve, 400); };
    const on = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done()).catch(done);
  });
}

/**
 * Makes sure KesherAI may use the tab's site. The extension asks for sites only when a task needs one (not all sites
 * at install): a small window asks her, and the task waits for her answer (up to two minutes).
 */
async function ensureSite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || tab.pendingUrl || "";
  if (!/^https?:/.test(url)) return;
  const origin = new URL(url).origin;
  const granted = { origins: [`${origin}/*`] };
  if (await chrome.permissions.contains(granted)) return;
  if (!(await askInWindow(`allow.html?origin=${encodeURIComponent(origin)}`, granted, 300)))
    throw new Error(`KesherAI is not allowed on ${new URL(origin).host} ("Not now", or no answer).`);
}

/**
 * Opens one of the extension's small windows that asks for a permission (only a click there may ask the browser),
 * and waits up to two minutes for the permission or for the window to close.
 */
async function askInWindow(page, granted, height) {
  let win;
  const answered = new Promise((resolve) => {
    const done = (ok) => { chrome.permissions.onAdded.removeListener(added); chrome.windows.onRemoved.removeListener(closed); clearTimeout(timer); resolve(ok); };
    const added = () => void chrome.permissions.contains(granted).then((ok) => ok && done(true));
    const closed = (id) => id === win?.id && setTimeout(() => void chrome.permissions.contains(granted).then(done), 300);
    const timer = setTimeout(() => done(false), 120000);
    chrome.permissions.onAdded.addListener(added);
    chrome.windows.onRemoved.addListener(closed);
  });
  win = await chrome.windows.create({ url: chrome.runtime.getURL(page), type: "popup", width: 400, height, focused: true });
  return answered;
}

async function inPage(tabId, func, args = []) {
  await ensureSite(tabId);
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch((err) => {
    if (/permission|host/i.test(String(err?.message))) throw new Error("The browser has not allowed KesherAI on this site. Click KesherAI's button in the browser and allow the site.");
    throw err;
  });
  // Errors inside the page come back as { error } (the browser does not pass thrown errors on).
  const out = r?.result;
  if (out && typeof out === "object" && "error" in out && Object.keys(out).length === 1) throw new Error(String(out.error));
  return out;
}

async function run(action, a) {
  if (action === "tabs") {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => t.id !== undefined).map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", active: !!t.active }));
  }
  if (action === "open") {
    if (!/^https?:/i.test(String(a.url || "")) || (await isAppAddress(String(a.url)))) throw new Error("KesherAI's extension opens web pages only, not KesherAI itself.");
    const tab = typeof a.tabId === "number" ? await chrome.tabs.update(a.tabId, { url: a.url }) : await chrome.tabs.create({ url: a.url, active: false });
    await groupTab(tab.id);
    await waitLoaded(tab.id);
    return inPage(tab.id, readPage);
  }
  if (action === "cdp-send") return cdpSend(a.tabId, String(a.method || ""), a.params || {});
  if (action === "cdp-attach") return cdpAttach(a.tabId);
  if (action === "cdp-detach-all") return detachAll();
  const tab = await tabOf(a.tabId);
  if (action === "front") {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 300));
    return null;
  }
  if (action === "close") {
    await chrome.tabs.remove(tab.id);
    return null;
  }
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) throw new Error("The browser does not let extensions use its own pages.");
  if (await isAppAddress(tab.url || "")) throw new Error("KesherAI never works in its own pages.");
  if (action === "read") return inPage(tab.id, readPage);
  if (action === "click") {
    await inPage(tab.id, clickRef, [a.ref]);
    await new Promise((r) => setTimeout(r, 800));
    await waitLoaded(tab.id, 8000);
    return inPage(tab.id, readPage);
  }
  if (action === "type") {
    await inPage(tab.id, typeRef, [a.ref, String(a.text || ""), !!a.submit]);
    await new Promise((r) => setTimeout(r, a.submit ? 1200 : 300));
    if (a.submit) await waitLoaded(tab.id, 8000);
    return inPage(tab.id, readPage);
  }
  if (action === "screenshot") {
    await ensureSite(tab.id);
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 400));
    return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
  }
  throw new Error(`Unknown action ${action}`);
}

// ---- The app's CDP tools over chrome.debugger (0.3.0) ----
// The app sends raw CDP commands for one tab (cdp-send) and gets the tab's events back (cdp-event); the recipes
// themselves live in the app (packages/core/src/cdp.ts), the same ones that drive KesherAI's own browser pane.
// Limits kept here, whatever the app asks: only the CDP domains those recipes use, only web pages on sites the
// user allowed (never the browser's own pages or the KesherAI app's), and the debugger only after the user said yes.

/** The CDP domains the app's recipes use. Browser, Target, Storage, Fetch and the rest are refused. */
const CDP_DOMAINS = /^(Page|Runtime|Log|Network|DOM|Accessibility|Input|Emulation|Overlay)\./;
/** Tabs with the debugger attached: tab id → { last: last use, origin: the site last checked }. */
const attached = new Map();
/** After this long without a command the debugger lets go of a tab (and Chrome's bar goes away). */
const IDLE_MS = 5 * 60 * 1000;

/** Sends a message to the app, if it is connected. */
function toApp(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Whether an address is the KesherAI app itself: its port on any host name (`*.localhost` reaches this computer and
 * the app counts it as local; with remote on it also answers on the computer's other addresses; security scan 169).
 */
async function isAppAddress(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const { port } = await settings();
  return /^https?:$/.test(u.protocol) && Number(u.port || (u.protocol === "https:" ? 443 : 80)) === Number(port);
}

/** Refuses the browser's own pages and the KesherAI app's own address; checks where the tab is going too. */
async function checkPage(tab) {
  const url = tab.url || tab.pendingUrl || "";
  if (!/^https?:/.test(url)) throw new Error("KesherAI uses the debugger on web pages only (not the browser's own pages).");
  if ((await isAppAddress(url)) || (tab.pendingUrl && (await isAppAddress(tab.pendingUrl)))) throw new Error("KesherAI never debugs its own pages.");
  return new URL(url).origin;
}

/** Asks for the optional "debugger" permission the first time (debug.html explains Chrome's bar). */
async function ensureDebugger() {
  if (/Firefox\//.test(navigator.userAgent)) throw new Error("This browser has no debugger for extensions.");
  const granted = { permissions: ["debugger"] };
  if (!(await chrome.permissions.contains(granted)) && !(await askInWindow("debug.html", granted, 440)))
    throw new Error("The user did not allow KesherAI to debug the browser (\"Not now\", or no answer). Use browser_read, browser_click and browser_type instead.");
  listenDebugger();
}

/** Keeps the tabs KesherAI works in together, in a "KesherAI" tab group (Chrome and Edge). */
let groupId;
async function groupTab(tabId) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const group = groupId !== undefined ? await chrome.tabGroups.get(groupId).catch(() => undefined) : undefined;
    if (group && group.windowId === tab.windowId) {
      if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [tabId], groupId });
      return;
    }
    if (tab.groupId !== undefined && tab.groupId !== -1) return; // the user's own group: leave it
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: "KesherAI", color: "blue" });
  } catch {
    // A group is a nicety; the task goes on without it.
  }
}

/** Attaches the debugger to a tab (asking for the site and the debugger first when needed). */
async function cdpAttach(tabId) {
  if (typeof tabId !== "number") throw new Error("Which tab?");
  const tab = await chrome.tabs.get(tabId);
  const origin = await checkPage(tab);
  await ensureSite(tabId);
  await ensureDebugger();
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3").catch(async (err) => {
      if (!/already attached/i.test(String(err?.message))) throw err;
      // Ours from before the browser put this worker to sleep: let go and take it again. Anyone else's (DevTools): say so.
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      await chrome.debugger.attach({ tabId }, "1.3").catch(() => {
        throw new Error("Another debugger (DevTools?) is attached to this tab. Close it and try again.");
      });
    });
    attached.set(tabId, { last: Date.now(), origin });
  }
  await groupTab(tabId);
  return { ok: true };
}

/** One CDP command for a tab (attaching first when needed; the site is checked again after the tab moved on). */
async function cdpSend(tabId, method, params) {
  if (!CDP_DOMAINS.test(method)) throw new Error(`KesherAI's extension does not send ${method}.`);
  if (typeof tabId !== "number") throw new Error("Which tab?");
  // A navigation goes to web pages only, never the app (the tab is checked again before each later command).
  if (method === "Page.navigate" && (!/^https?:/i.test(String(params?.url ?? "")) || (await isAppAddress(String(params.url))))) throw new Error("KesherAI's extension opens web pages only, not KesherAI itself.");
  const tab = await chrome.tabs.get(tabId);
  const origin = await checkPage(tab);
  const a = attached.get(tabId);
  if (!a) await cdpAttach(tabId);
  else if (a.origin !== origin) {
    await ensureSite(tabId);
    a.origin = origin;
  }
  attached.get(tabId).last = Date.now();
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Lets go of every tab (Stop, the app went away). */
async function detachAll() {
  const ids = [...attached.keys()];
  attached.clear();
  await Promise.all(ids.map((tabId) => chrome.debugger?.detach({ tabId }).catch(() => undefined)));
  return null;
}

/** Lets go of tabs nobody used for five minutes. */
function detachIdle() {
  for (const [tabId, a] of attached) {
    if (Date.now() - a.last < IDLE_MS) continue;
    attached.delete(tabId);
    void chrome.debugger.detach({ tabId }).catch(() => undefined);
    toApp({ type: "cdp-detached", tabId, reason: "idle" });
  }
}

/** Listens to the debugger's events (once; chrome.debugger exists only after the permission was given). */
let listening = false;
function listenDebugger() {
  if (listening || !chrome.debugger) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== undefined && attached.has(source.tabId)) toApp({ type: "cdp-event", tabId: source.tabId, method, params: params || {} });
  });
  // The tab closed, DevTools opened on it, or the user pressed "Cancel" on Chrome's bar (the app treats that as Stop).
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined || !attached.delete(source.tabId)) return;
    toApp({ type: "cdp-detached", tabId: source.tabId, reason });
  });
}
listenDebugger();
chrome.permissions.onAdded?.addListener(() => listenDebugger());
