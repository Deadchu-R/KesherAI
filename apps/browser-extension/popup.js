const $ = (id) => document.getElementById(id);
const TEXT = {
  on: ["Connected to KesherAI", "on"],
  connecting: ["Connecting…", ""],
  off: ["Paste the key from KesherAI to connect.", ""],
  "wrong-key": ["The key is wrong. Copy it again from KesherAI → Settings → Browser.", "bad"],
  "no-app": ["KesherAI is not running on this computer.", "bad"],
};
function show(state) {
  const [text, cls] = TEXT[state] || TEXT.off;
  $("state").textContent = text;
  $("state").className = `state ${cls}`;
}
chrome.storage.local.get({ key: "", port: 7420 }).then((s) => { $("key").value = s.key; $("port").value = s.port; });
chrome.runtime.sendMessage("state").then((r) => show(r?.state));
$("save").onclick = async () => {
  await chrome.storage.local.set({ key: $("key").value.trim(), port: Number($("port").value) || 7420, enabled: true });
  show("connecting");
  setTimeout(() => chrome.runtime.sendMessage("state").then((r) => show(r?.state)), 1500);
};

// The side panel: KesherAI's chat beside any page (Chrome's side panel; opened from this click).
$("panel").onclick = async () => {
  const w = await chrome.windows.getCurrent();
  if (chrome.sidePanel?.open) await chrome.sidePanel.open({ windowId: w.id });
  // Firefox: its sidebar.
  else if (globalThis.browser?.sidebarAction?.open) await globalThis.browser.sidebarAction.open();
  window.close();
};

// Sites: by default KesherAI asks for each site when a task needs it; this allows all of them at once (from this click).
$("all").onclick = () => void chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false).then(showAll);
function showAll() {
  void chrome.permissions.contains({ origins: ["<all_urls>"] }).then((all) => {
    $("all").hidden = all;
    $("sites").textContent = all ? "Allowed on all sites." : "KesherAI asks you for each site the first time a task needs it.";
  });
}
showAll();

// Debugging (0.3.0, Chrome-family browsers): the app's exact tools need the optional "debugger" permission. It is asked
// the first time a task needs it; this allows it ahead, from this click. Firefox has no debugger for extensions.
const heUi = (navigator.language || "").startsWith("he");
const T = (he, en) => (heUi ? he : en);
function showDebugger() {
  if (/Firefox\//.test(navigator.userAgent)) return;
  void chrome.permissions.contains({ permissions: ["debugger"] }).then((on) => {
    $("dbg").textContent = on
      ? T("ניפוי באגים מותר: כש-KesherAI עובד, Chrome מציג פס \"started debugging\" (Cancel בו עוצר אותו).", "Debugging allowed: while KesherAI works, Chrome shows a \"started debugging\" bar (Cancel there stops it).")
      : T("ניפוי באגים (קונסול, רשת, לחיצות מדויקות): KesherAI ישאל בפעם הראשונה שמשימה תצטרך אותו.", "Debugging (console, network, exact clicks): KesherAI asks the first time a task needs it.");
    $("dbg").dir = "auto";
    $("dbgon").hidden = on;
    $("dbgon").textContent = T("לאפשר ניפוי באגים עכשיו", "Allow debugging now");
  });
}
$("dbgon").onclick = () => void chrome.permissions.request({ permissions: ["debugger"] }).catch(() => false).then(showDebugger);
showDebugger();
