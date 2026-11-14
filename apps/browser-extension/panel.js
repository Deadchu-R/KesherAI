// The side panel: KesherAI's own page from this computer, and "Ask about this page", which hands the page's text to
// it (only to the KesherAI page in this panel, by postMessage to its exact address).
const frame = document.getElementById("app");
let origin = "http://127.0.0.1:7420";
chrome.storage.local.get({ port: 7420 }).then((s) => {
  origin = `http://127.0.0.1:${Number(s.port) || 7420}`;
  frame.src = `${origin}/#/`;
});
const he = (navigator.language || "").startsWith("he");
if (he) {
  document.getElementById("ask").textContent = "📄 לשאול על הדף הזה";
  document.getElementById("home").textContent = "💬 צ'אט חדש";
  document.documentElement.dir = "rtl";
}
document.getElementById("home").onclick = () => (frame.src = `${origin}/#/`);
document.getElementById("ask").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ title: document.title, url: location.href, text: (document.body?.innerText || "").slice(0, 20000) }),
  });
  if (res?.result) frame.contentWindow.postMessage({ type: "kesher-page", ...res.result }, origin);
};
