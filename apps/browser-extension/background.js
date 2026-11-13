/* global readPage, clickRef, typeRef */
// KesherAI browser extension: connects to the KesherAI app on this computer and carries out
// the agent's browser commands (list tabs, open, read, click, type, screenshot).
// The app asks you before each action unless you chose otherwise. It never types into password fields.

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
  const browser = /Edg\//.test(navigator.userAgent) ? "Edge" : /Brave/.test(navigator.userAgent) ? "Brave" : "Chrome";
  const sock = new WebSocket(`ws://127.0.0.1:${port}/api/browser/connect?key=${encodeURIComponent(key)}&browser=${browser}&version=${chrome.runtime.getManifest().version}`);
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
    if (state !== "wrong-key") setState("no-app");
  };
  sock.onerror = () => undefined;
}

// Keep the connection (and this worker) alive, and reconnect when the app starts.
chrome.alarms.create("kesher-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  else void connect();
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

async function inPage(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
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
    const tab = typeof a.tabId === "number" ? await chrome.tabs.update(a.tabId, { url: a.url }) : await chrome.tabs.create({ url: a.url, active: false });
    await waitLoaded(tab.id);
    return inPage(tab.id, readPage);
  }
  const tab = await tabOf(a.tabId);
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) throw new Error("The browser does not let extensions use its own pages.");
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
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 400));
    return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
  }
  throw new Error(`Unknown action ${action}`);
}
