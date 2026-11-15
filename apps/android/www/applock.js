/* global window, document, localStorage, navigator */
// App lock (audit F14): when the lock is on, KesherAI's own screens are covered until the phone's fingerprint, face
// or screen lock opens them: at start, and after a minute away from the app. The computer's pages in the app check
// the same lock (apps/web/src/appLock.ts).
(() => {
  const LLM = window.Capacitor?.Plugins?.KesherLlm;
  if (!LLM?.lockState) return;
  const he = (localStorage.getItem("lang") || (navigator.language.startsWith("he") ? "he" : "en")) === "he";
  let cover;
  let asking = false;
  const ask = async () => {
    if (asking) return;
    asking = true;
    try {
      await LLM.unlock();
      cover?.remove();
      cover = undefined;
    } catch {
      /* cancelled: the cover stays, with its button */
    } finally {
      asking = false;
    }
  };
  const check = async () => {
    const st = await LLM.lockState().catch(() => ({ needed: false }));
    if (!st.needed) return;
    if (!cover) {
      cover = document.createElement("div");
      cover.setAttribute("role", "dialog");
      cover.setAttribute("aria-modal", "true");
      cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:var(--bg,#121213);color:var(--text,#ededee);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font:16px system-ui,sans-serif";
      cover.innerHTML = `<div style="font-size:44px" aria-hidden="true">🔒</div><div>${he ? "KesherAI נעול" : "KesherAI is locked"}</div><button type="button" style="min-height:48px;padding:0 22px;border-radius:12px;border:0;background:var(--accent,#98a3ff);color:var(--accent-ink,#121213);font:inherit;font-weight:600">${he ? "פתח" : "Open"}</button>`;
      cover.querySelector("button").onclick = () => void ask();
      document.body.append(cover);
    }
    void ask();
  };
  void check();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void check());
})();
