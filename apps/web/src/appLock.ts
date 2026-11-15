/**
 * App lock (audit F14) on the computer's pages inside the phone app: when the person turned the lock on, the page is
 * covered until the phone's fingerprint, face or screen lock opens it (at start, and after a minute away). Outside the
 * phone app this does nothing. The phone's own pages use www/applock.js, with the same native lock.
 */
type Lock = { lockState(): Promise<{ needed: boolean }>; unlock(): Promise<void> };

/** Starts watching the lock (call once). */
export function startAppLock(): void {
  const lock = (window as unknown as { Capacitor?: { Plugins?: { KesherLlm?: Partial<Lock> } } }).Capacitor?.Plugins?.KesherLlm;
  if (!lock?.lockState || !lock.unlock) return;
  const l = lock as Lock;
  let cover: HTMLDivElement | undefined;
  let asking = false;
  const ask = async () => {
    if (asking) return;
    asking = true;
    try {
      await l.unlock();
      cover?.remove();
      cover = undefined;
    } catch {
      // Cancelled: the cover stays, with its button.
    } finally {
      asking = false;
    }
  };
  const check = async () => {
    const st = await l.lockState().catch(() => ({ needed: false }));
    if (!st.needed) return;
    if (!cover) {
      const he = document.documentElement.lang === "he";
      cover = document.createElement("div");
      cover.className = "app-lock";
      cover.setAttribute("role", "dialog");
      cover.setAttribute("aria-modal", "true");
      const icon = document.createElement("div");
      icon.textContent = "🔒";
      icon.className = "app-lock-icon";
      const text = document.createElement("div");
      text.textContent = he ? "KesherAI נעול" : "KesherAI is locked";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary";
      btn.textContent = he ? "פתח" : "Open";
      btn.onclick = () => void ask();
      cover.append(icon, text, btn);
      document.body.append(cover);
    }
    void ask();
  };
  void check();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}
