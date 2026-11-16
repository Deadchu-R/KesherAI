/* global localStorage, navigator, window, confirm, setTimeout, document */
// Phone Health on the phone itself (no computer needed): the numbers, a speed-up list (trash, all apps' caches
// through Android's own window, KesherAI's own cache, background apps and the phone model out of memory), and every
// installed app and game with its size. Nothing is deleted or closed without the person's press and Android's own
// confirmation where Android has one.

const lang = localStorage.getItem("lang") || (navigator.language.startsWith("he") ? "he" : "en");
const he = lang === "he";
const T = (h, e) => (he ? (globalThis.kesherHebrew ? globalThis.kesherHebrew(h) : h) : e);
const size = (b) => (!b ? "0 MB" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Draws Phone Health into a container.
 * @param {HTMLElement} root - Where it goes.
 */
export function renderPhoneHealth(root) {
  const P = window.Capacitor?.Plugins?.KesherLlm;
  if (!P?.health) {
    root.innerHTML = `<p class="intro">${T("זמין באפליקציה בטלפון.", "Available in the phone app.")}</p>`;
    return;
  }
  const state = { apps: null, only: "all", q: "" };
  const say = (text) => {
    const n = root.querySelector("#phNote");
    if (n) n.textContent = text;
  };

  const numbers = async () => {
    const h = await P.health().catch(() => ({}));
    const used = (a, b) => (b ? Math.round(((b - a) / b) * 100) : 0);
    root.querySelector("#phNumbers").innerHTML = [
      h.storageTotal ? `<li>${T("אחסון", "Storage")}: <b dir="ltr">${size(h.storageTotal - h.storageFree)} / ${size(h.storageTotal)}</b> (${used(h.storageFree, h.storageTotal)}%)</li>` : "",
      h.ramTotal ? `<li>${T("זיכרון", "Memory")}: <b dir="ltr">${size(h.ramTotal - h.ramFree)} / ${size(h.ramTotal)}</b>${h.lowMemory ? T(" · נמוך", " · low") : ""}</li>` : "",
      h.batteryPercent >= 0 ? `<li>${T("סוללה", "Battery")}: <b dir="ltr">${h.batteryPercent}%</b>${h.batteryTempC ? ` · <span dir="ltr">${h.batteryTempC}°C</span>` : ""}${h.charging ? T(" · בטעינה", " · charging") : ""}</li>` : "",
      h.modelsBytes ? `<li>${T("מודלים בטלפון", "Models on the phone")}: <b dir="ltr">${size(h.modelsBytes)}</b></li>` : "",
    ].join("");
  };

  const speedUp = async () => {
    const box = root.querySelector("#phSpeed");
    const trash = P.trash ? await P.trash().catch(() => ({ supported: false })) : { supported: false };
    box.innerHTML = `
      <div class="ph-row"><span>${T("פינוי זיכרון: אפליקציות ברקע והמודל של הטלפון", "Free memory: background apps and the phone model")}</span><button type="button" data-act="mem">${T("פנה", "Free")}</button></div>
      <div class="ph-row"><span>${T("קאש של כל האפליקציות (החלון של אנדרואיד)", "All apps' cache (Android's own window)")}</span><button type="button" data-act="caches">${T("נקה", "Clean")}</button></div>
      <div class="ph-row"><span>${T("הקאש של KesherAI", "KesherAI's cache")}</span><button type="button" data-act="own">${T("נקה", "Clean")}</button></div>
      ${trash.supported ? `<div class="ph-row"><span>${T("פח (קבצים שנמחקו)", "Trash (deleted files)")} <b dir="ltr">${trash.filesAccess || trash.items ? `${size(trash.bytes)} · ${trash.items}` : T("צריך גישה לקבצים", "needs file access")}</b></span><button type="button" data-act="trash" ${trash.items ? "" : "disabled"}>${T("רוקן", "Empty")}</button></div>` : ""}`;
    box.onclick = async (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      try {
        if (act === "mem") {
          const r = await P.freeMemory();
          say(T(`התפנו ${size(r.freed)}. אפליקציות שעל המסך לא נסגרות.`, `${size(r.freed)} freed. Apps on screen are not closed.`));
        } else if (act === "caches") {
          const r = await P.clearAllCaches();
          if (r.result === "needs-files-access") {
            if (confirm(T("אנדרואיד מבקש \"גישה לכל הקבצים\" פעם אחת. לפתוח את ההגדרה?", "Android needs \"All files access\" once. Open the setting?"))) await P.openSettings({ what: "files" });
          } else if (r.result === "old-android") {
            say(T("בגרסת האנדרואיד הזו מנקים מ'הגדרות › אחסון'.", "On this Android version, clean from Settings › Storage."));
            await P.openSettings({ what: "storage" });
          } else say(T("אשר בחלון של אנדרואיד.", "Confirm in Android's window."));
        } else if (act === "own") {
          const r = await P.clearOwnCache();
          say(T(`התפנו ${size(r.freed)}. המודלים נשארו.`, `${size(r.freed)} freed. The models stay.`));
        } else if (act === "trash") {
          if (!confirm(T("לרוקן את הפח? אנדרואיד יבקש אישור, ואחר כך אין שחזור.", "Empty the trash? Android asks to confirm; it cannot be undone."))) return;
          await P.emptyTrash();
        }
        setTimeout(() => void numbers(), 1500);
      } catch (err) {
        say(String(err?.message ?? err));
      }
    };
  };

  const drawApps = () => {
    const list = root.querySelector("#phApps");
    const a = state.apps;
    if (!a) return;
    const total = (x) => (x.appBytes ?? 0) + (x.dataBytes ?? 0) + (x.cacheBytes ?? 0);
    const shown = a.apps
      .filter((x) => state.only === "all" || (state.only === "games" ? x.game : !x.game))
      .filter((x) => !state.q || x.name.toLowerCase().includes(state.q.toLowerCase()))
      .sort((x, y) => total(y) - total(x) || x.name.localeCompare(y.name));
    list.innerHTML =
      (a.usageAccess ? "" : `<p class="intro">${T("כדי לראות גודל ושימוש אחרון לכל אפליקציה, אנדרואיד מבקש \"גישה לנתוני שימוש\" פעם אחת.", "To see each app's size and last use, Android asks for \"Usage access\" once.")} <button type="button" data-act="usage">${T("פתח הגדרה", "Open setting")}</button></p>`) +
      shown
        .slice(0, 300)
        .map((x) => `<div class="ph-row"><span><b dir="auto">${esc(x.name)}</b>${x.game ? " 🎮" : ""}<br><small class="muted" dir="ltr">${total(x) ? size(total(x)) : ""}${x.cacheBytes ? ` · ${T("קאש", "cache")} ${size(x.cacheBytes)}` : ""}${x.lastUsed ? ` · ${new Date(x.lastUsed).toLocaleDateString()}` : ""}</small></span><span class="ph-btns"><button type="button" data-info="${esc(x.package)}">${T("פרטים", "Info")}</button><button type="button" data-del="${esc(x.package)}">${T("הסר", "Remove")}</button></span></div>`)
        .join("");
  };
  const loadApps = async () => {
    root.querySelector("#phApps").innerHTML = `<p class="intro">${T("קורא את האפליקציות…", "Reading the apps…")}</p>`;
    state.apps = await P.apps().catch(() => ({ usageAccess: false, apps: [] }));
    root.querySelector("#phAppsTitle").textContent = T(`אפליקציות ומשחקים (${state.apps.apps.length})`, `Apps and games (${state.apps.apps.length})`);
    drawApps();
  };

  root.innerHTML = `
    <h2>${T("בריאות הטלפון", "Phone health")}</h2>
    <ul class="ph-numbers" id="phNumbers"></ul>
    <h2>${T("שיפור ביצועים", "Speed up")}</h2>
    <div id="phSpeed"></div>
    <p class="intro" id="phNote" role="status"></p>
    <h2 id="phAppsTitle">${T("אפליקציות ומשחקים", "Apps and games")}</h2>
    <div class="ph-filter">
      <input type="search" id="phQ" placeholder="${T("חיפוש…", "Search…")}" dir="auto" />
      <select id="phOnly"><option value="all">${T("הכל", "All")}</option><option value="games">${T("משחקים", "Games")}</option><option value="apps">${T("אפליקציות", "Apps")}</option></select>
    </div>
    <div id="phApps"><button type="button" id="phLoad">${T("הצג את כל האפליקציות", "Show all apps")}</button></div>`;
  root.querySelector("#phLoad").onclick = () => void loadApps();
  root.querySelector("#phQ").oninput = (e) => {
    state.q = e.target.value;
    drawApps();
  };
  root.querySelector("#phOnly").onchange = (e) => {
    state.only = e.target.value;
    drawApps();
  };
  root.querySelector("#phApps").onclick = async (e) => {
    const t = e.target;
    try {
      if (t?.dataset?.act === "usage") await P.openSettings({ what: "usage" });
      else if (t?.dataset?.info) await P.openSettings({ what: "app", package: t.dataset.info });
      else if (t?.dataset?.del) await P.uninstall({ package: t.dataset.del });
    } catch (err) {
      say(String(err?.message ?? err));
    }
  };
  // Coming back from Android's settings or uninstall window: read again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !root.isConnected || root.offsetParent === null) return;
    void numbers();
    if (state.apps) void loadApps();
  });
  void numbers();
  void speedUp();
}
