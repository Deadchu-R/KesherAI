/* global document, localStorage, location, navigator, window, fetch, AbortSignal, setTimeout, URL */
// "Why does it not connect": when the computer cannot be reached, a sheet with each check (✓ / ✕ / —, with its
// time), the reason in plain words with its fix, and the buttons that help: Connect Tailscale (the Tailscale app's
// own broadcast, through plugins/tailscale), Use the hub instead, Wake, Try again. The reasons and the Tailscale call
// are shared (packages/shared/src/connect-why.ts, bundled into vendor/path.js as kesherWhy). Also keeps the phone's
// small connection log (the last 50 attempts: address kind, result, reason; no addresses or keys), sent to the
// computer when they reconnect (POST /api/faults/phone-connect), so a lost link can be read from the computer's log.
(() => {
  const W = globalThis.kesherWhy;
  if (!W) return;
  const LOG = "kesherai-connect-log";
  const TS_TRIED = "kesherai-ts-auto";
  const lang = () => localStorage.getItem("lang") || (navigator.language.startsWith("he") ? "he" : "en");
  const T = (w) => (w ? w[lang()] ?? w.en : "");
  const F = (he, en) => (lang() === "he" ? he : en);
  const Ts = () => window.Capacitor?.Plugins?.KesherTailscale;

  /** The log, oldest first (cleaned on every read). */
  const loadLog = () => { try { return W.cleanAttempts(JSON.parse(localStorage.getItem(LOG) || "[]")); } catch { return []; } };
  /** Adds one attempt to the log. */
  const record = (a) => { try { localStorage.setItem(LOG, JSON.stringify(W.addAttempt(loadLog(), { at: Date.now(), ...a }))); } catch { /* storage full: no log */ } };

  /** Whether an address is the computer's Tailscale one: a ts.net name or 100.64.0.0/10. */
  const isTs = (l) => { try { const h = new URL(l).hostname; return /\.ts\.net$/i.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h); } catch { return false; } };
  /** The kind of an address, for the log: home network, Tailscale, or the "anywhere" link (a public https one). */
  const viaOf = (l) => (isTs(l) ? "tailscale" : /^https:/.test(l) ? "anywhere" : "home");

  /** One address with this phone's key: ok, the status, or nothing when it did not answer. */
  const probe = (base, token, ms = 5000) =>
    fetch(`${base}/api/health`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(ms) })
      .then((r) => ({ ok: r.ok, status: r.status }), () => ({ ok: false }));

  /** Whether something on the internet answers (the hub when one is known; otherwise Google's always-up check). */
  async function internet(hub) {
    const tryOne = (u) => fetch(u, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
    if (hub && (await tryOne(`${hub}/api/config`))) return { internet: true, hub: true };
    const net = await tryOne("https://connectivitycheck.gstatic.com/generate_204");
    return { internet: net, ...(hub ? { hub: false } : {}) };
  }

  /**
   * Gathers the facts: internet, the hub, each saved address (logged one by one), whether the PC has a Tailscale
   * address, and what the hub page said about the PC (when it sent the phone here with ?why=1).
   *
   * @param c - The saved computer: { token, links, tailscale, wake }.
   * @param hint - From the hub page: { pc, ver, seen }; and { addressChanged } from the beacon.
   */
  async function gather(c, hint = {}) {
    const links = [...new Set([...(c.links || []), ...(globalThis.kesherPath?.directUrls(c.tailscale) ?? [])])];
    const hubBase = (() => { try { const h = localStorage.getItem("kesherai-hub"); return h && /^https:\/\//.test(h) ? new URL(h).origin : ""; } catch { return ""; } })();
    const [net, answers] = await Promise.all([internet(hubBase), Promise.all(links.map((l) => probe(l, c.token)))]);
    links.forEach((l, i) => record({ via: viaOf(l), ok: answers[i].ok, ...(answers[i].status ? { status: answers[i].status } : {}) }));
    if (hubBase) record({ via: "hub", ok: !!net.hub });
    const refused = answers.some((a) => a.status === 401 || a.status === 403);
    // On the PC's home network when its home address answers at all (without the key): there Tailscale is not needed.
    const home = links.filter((l) => viaOf(l) === "home");
    const atHome = home.length ? (await Promise.all(home.map((l) => fetch(`${l}/api/hello`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok, () => false)))).some(Boolean) : false;
    const pc = ["online", "asleep", "offline", "restarting"].includes(hint.pc) ? hint.pc : undefined;
    return {
      facts: {
        ...net,
        ...(pc ? { pcOnHub: pc } : {}),
        ...(hint.ver && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(hint.ver) ? { pcUpdate: hint.ver } : {}),
        ...(hint.seen && !Number.isNaN(Date.parse(hint.seen)) ? { pcLastSeen: hint.seen } : {}),
        direct: answers.some((a) => a.ok) ? "ok" : refused ? "unauthorized" : "fail",
        hasTailscalePath: links.some(isTs),
        ...(hint.addressChanged ? { addressChanged: true } : {}),
        canWake: !!(c.wake && window.Capacitor?.Plugins?.WakeOnLan),
      },
      atHome,
      tsLinks: links.filter(isTs),
    };
  }

  const css = document.createElement("style");
  css.textContent = `
    .cw-scrim { position: fixed; inset: 0; z-index: 70; background: rgb(0 0 0 / .45); }
    .cw-sheet { position: fixed; inset: auto 0 0 0; z-index: 71; max-height: 86vh; overflow-y: auto; padding: 14px 16px max(16px, env(safe-area-inset-bottom)); background: #1e1e21; border: 1px solid #2c2d33; border-radius: 20px 20px 0 0; box-shadow: 0 -12px 40px rgb(0 0 0 / .5); }
    .cw-grip { width: 40px; height: 4px; border-radius: 2px; background: #3a3a40; margin: 0 auto 10px; }
    .cw-title { font-size: 17px; font-weight: 500; margin: 0 0 4px; }
    .cw-fix { color: var(--muted); font-size: 14px; margin: 0 0 12px; line-height: 1.45; }
    .cw-checks { list-style: none; margin: 0 0 12px; padding: 0; border: 1px solid #2c2d33; border-radius: 12px; }
    .cw-checks li { display: flex; gap: 10px; align-items: center; padding: 9px 12px; font-size: 14px; border-top: 1px solid #2c2d33; }
    .cw-checks li:first-child { border-top: 0; }
    .cw-checks b { width: 18px; text-align: center; }
    .cw-checks .ok { color: #7fd6a4; } .cw-checks .fail { color: var(--bad); } .cw-checks .unknown { color: var(--muted); }
    .cw-checks time { margin-inline-start: auto; color: var(--muted); font-size: 12px; direction: ltr; }
    .cw-actions { display: grid; gap: 8px; }
    .cw-actions button { min-height: 46px; }
    .cw-result { font-size: 14px; margin: 10px 0 0; }
  `;
  document.head.append(css);

  let open = null;
  const close = () => { open?.remove(); open = null; };

  /**
   * Shows the sheet for one computer: gathers the checks, picks the reason, may turn Tailscale on by itself, and
   * offers the buttons.
   *
   * @param c - The saved computer.
   * @param o - { hint, onRetry, onWake, auto } — the hub page's hint, what Try again and Wake do, and whether the
   *   automatic Tailscale try is allowed (not when she opened the sheet just to read it).
   */
  async function explain(c, o = {}) {
    close();
    const box = document.createElement("div");
    open = box;
    const scrim = Object.assign(document.createElement("div"), { className: "cw-scrim", onclick: close });
    const sheet = Object.assign(document.createElement("section"), { className: "cw-sheet" });
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", F("למה אין חיבור", "Why it does not connect"));
    sheet.append(Object.assign(document.createElement("div"), { className: "cw-grip" }), Object.assign(document.createElement("p"), { className: "cw-fix", textContent: F("בודק…", "Checking…") }));
    box.append(scrim, sheet);
    document.body.append(box);

    const g = await gather(c, o.hint);
    if (open !== box) return;
    let verdict = W.diagnoseConnection(g.facts);
    record({ via: g.facts.hasTailscalePath ? "tailscale" : "home", ok: verdict.reason === "connected", reason: verdict.reason });
    if (verdict.reason === "connected") { close(); o.onRetry?.(); return; }
    draw(sheet, g, verdict, c, o);
    // Away from home with the PC online (or not known): turn Tailscale on by itself, once in 10 minutes.
    const last = Number(localStorage.getItem(TS_TRIED) || 0);
    if (o.auto !== false && Ts() && W.shouldAutoTailscale(g.facts, { atHome: g.atHome, lastTried: last }, Date.now())) {
      localStorage.setItem(TS_TRIED, String(Date.now()));
      void tailscale(sheet, g, c, o);
    }
  }

  /** Draws the reason, the checks and the buttons. */
  function draw(sheet, g, verdict, c, o) {
    const at = Date.now();
    const time = new Date(at).toLocaleTimeString(lang() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const list = document.createElement("ul");
    list.className = "cw-checks";
    for (const ch of W.connectChecks(g.facts, at)) {
      const li = document.createElement("li");
      const mark = Object.assign(document.createElement("b"), { className: ch.state, textContent: ch.state === "ok" ? "✓" : ch.state === "fail" ? "✕" : "—" });
      const name = document.createElement("span");
      name.textContent = T(W.CHECK_LABELS[ch.id]) + (ch.id === "pc" && g.facts.pcLastSeen && ch.state !== "ok" ? F(" · נראה לאחרונה ", " · last seen ") + new Date(g.facts.pcLastSeen).toLocaleString(lang() === "he" ? "he-IL" : "en-GB", { dateStyle: "short", timeStyle: "short" }) : "");
      li.append(mark, name, Object.assign(document.createElement("time"), { textContent: time }));
      list.append(li);
    }
    const actions = document.createElement("div");
    actions.className = "cw-actions";
    const btn = (label, primary, fn) => { const b = Object.assign(document.createElement("button"), { type: "button", className: primary ? "primary" : "", textContent: label, onclick: fn }); actions.append(b); return b; };
    for (const a of verdict.actions) {
      if (a === "tailscale" && Ts()) btn(F("חבר את Tailscale", "Connect Tailscale"), actions.childElementCount === 0, () => void tailscale(sheet, g, c, o));
      if (a === "tailscale" && !Ts()) continue;
      if (a === "hub" && localStorage.getItem("kesherai-hub")) btn(F("השתמש בהאב במקום", "Use the hub instead"), actions.childElementCount === 0, () => { close(); location.href = "cloud.html"; });
      if (a === "wake" && o.onWake) btn(F("הער את המחשב", "Wake the computer"), actions.childElementCount === 0, () => { close(); o.onWake(); });
      if (a === "retry") btn(F("נסה שוב", "Try again"), actions.childElementCount === 0, () => { close(); o.onRetry?.(); });
    }
    btn(F("סגור", "Close"), false, close);
    sheet.replaceChildren(
      Object.assign(document.createElement("div"), { className: "cw-grip" }),
      Object.assign(document.createElement("h2"), { className: "cw-title", textContent: T(verdict.title) }),
      Object.assign(document.createElement("p"), { className: "cw-fix", textContent: T(verdict.fix) }),
      list,
      actions,
      Object.assign(document.createElement("p"), { className: "cw-result", id: "cwResult" }),
    );
  }

  /** "Connect Tailscale": the broadcast (or the Tailscale app), then a few checks that the PC answers over Tailscale. */
  async function tailscale(sheet, g, c, o) {
    const out = sheet.querySelector("#cwResult");
    if (out) out.textContent = F("מבקש מ-Tailscale להתחבר ובודק שהמחשב עונה…", "Asking Tailscale to connect and checking that the PC answers…");
    const r = await W.connectTailscale({ plugin: Ts(), probe: async () => (await Promise.all(g.tsLinks.map((l) => probe(l, c.token, 3000)))).some((a) => a.ok) });
    record({ via: "tailscale", ok: r.reachable, reason: r.reachable ? "connected" : "tailscale-off" });
    if (r.reachable) { if (out) out.textContent = F("✓ Tailscale מחובר והמחשב עונה. פותח…", "✓ Tailscale is on and the PC answers. Opening…"); setTimeout(() => { close(); o.onRetry?.(); }, 800); return; }
    if (!out) return;
    out.textContent = r.how === "opened"
      ? F("נפתחה אפליקציית Tailscale: לחץ שם Connect, חזור ולחץ נסה שוב.", "The Tailscale app opened: tap Connect there, then come back and tap Try again.")
      : r.how === "broadcast"
        ? F("Tailscale קיבל את הבקשה אבל המחשב עדיין לא עונה. פתח את Tailscale ובדוק שהוא מחובר לאותו חשבון כמו המחשב.", "Tailscale got the request but the PC still does not answer. Open Tailscale and check it is connected to the same account as the PC.")
        : F("Tailscale לא מותקן בטלפון. התקן אותו מ-Google Play והתחבר לאותו חשבון כמו המחשב.", "Tailscale is not installed on this phone. Install it from Google Play and sign in with the PC's account.");
  }

  /**
   * Sends the log to the computer that just answered, then clears it (kept when the computer is older and refuses).
   *
   * @param base - The computer's address.
   * @param token - This phone's key for it.
   * @param device - This phone's name.
   */
  async function sendLog(base, token, device) {
    const attempts = loadLog();
    if (!attempts.some((a) => !a.ok)) return; // nothing went wrong: nothing to read
    const r = await fetch(`${base}/api/faults/phone-connect`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ device, attempts }), signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (r?.ok) localStorage.removeItem(LOG);
  }

  globalThis.KesherWhy = { explain, record, sendLog, viaOf };
})();
