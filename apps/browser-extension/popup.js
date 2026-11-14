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
  window.close();
};
