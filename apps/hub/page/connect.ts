/**
 * The approval page for the Claude connector (`/connect`, public/connect.html, reached from `GET /oauth/authorize`). The signed-in
 * owner sees which app asks, where the browser goes back to, and what it may do, and approves or refuses. The hub
 * checks everything again on approval (src/oauth.ts); this page only passes the request's parameters on.
 *
 * A separate small entry (only dom.ts), so the approval loads fast on a phone and never runs the full hub page.
 */
import { h, initLocale, L, setLocale, getLocale } from "./dom.js";

const KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"];

/** The authorization request's parameters, from this page's query. */
function params(): Record<string, string> {
  const q = new URLSearchParams(location.search);
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const v = q.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** POSTs JSON to the hub with the session cookie. */
async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

/** Goes back to the app (an https URL or Claude Code's loopback, both checked by the hub before it gave them). */
function go(to: unknown): void {
  if (typeof to !== "string") return;
  const u = new URL(to);
  if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) location.assign(u.toString());
}

const root = document.getElementById("app")!;

/** Draws the page's one card. */
function show(...children: Array<Node | string | null>): void {
  root.replaceChildren(
    h(
      "main",
      { class: "signin" },
      h("div", { class: "logo", "aria-hidden": "true" }, "☁"),
      h("h1", null, L("חיבור ל-Claude", "Connect to Claude")),
      ...children,
      h("button", { type: "button", class: "btn", onclick: () => { setLocale(getLocale() === "he" ? "en" : "he"); void start(); } }, getLocale() === "he" ? "English" : "עברית"),
    ),
  );
}

/** Asks the hub about the request and draws the approval (or why it cannot). */
async function start(): Promise<void> {
  const p = params();
  show(h("p", { class: "mut sm" }, L("בודק…", "Checking…")));
  const r = await post("/api/oauth/check", { params: p }).catch(() => undefined);
  if (!r) return show(h("p", { class: "warn sm", role: "alert" }, L("אין תשובה מהמרכז.", "No answer from the hub.")), h("button", { type: "button", class: "btn pri", onclick: () => void start() }, L("נסה שוב", "Try again")));
  if (r.status === 401) {
    return show(
      h("p", { class: "sm" }, L("כדי לאשר, התחברו קודם למרכז עם חשבון Google שלכם.", "To approve, sign in to the hub with your Google account first.")),
      h("a", { class: "btn pri big", href: "/#settings", target: "_blank", rel: "noopener" }, L("פתח את המרכז והתחבר ↗", "Open the hub and sign in ↗")),
      h("button", { type: "button", class: "btn", onclick: () => void start() }, L("התחברתי, נסה שוב", "Signed in, try again")),
    );
  }
  if (r.status !== 200) {
    const back = r.data.redirect;
    return show(h("p", { class: "warn sm", role: "alert" }, String(r.data.error ?? L("הבקשה לא תקינה.", "The request is not valid."))), back ? h("button", { type: "button", class: "btn", onclick: () => go(back) }, L("חזרה ל-Claude", "Back to Claude")) : null);
  }
  const host = String(r.data.redirectHost ?? "");
  const decide = async (allow: boolean) => {
    const d = await post("/api/oauth/decide", { params: p, allow }).catch(() => undefined);
    if (d?.status === 200) return go(d.data.redirect);
    show(h("p", { class: "warn sm", role: "alert" }, String(d?.data.error ?? L("לא הצליח.", "It did not work."))));
  };
  show(
    h("p", { class: "sm" }, L(`"${String(r.data.clientName)}" מבקש גישה למרכז שלך.`, `"${String(r.data.clientName)}" asks to use your hub.`)),
    h("div", { class: "card stack pad", style: "text-align:start" },
      h("span", { class: "sm" }, L("חוזר אל: ", "Returns to: "), h("b", { class: "mono" }, host)),
      r.data.loopback ? h("span", { class: "warn sm" }, L("כתובת מקומית במחשב הזה (Claude Code). אשרו רק אם הפעלתם עכשיו את Claude Code.", "A local address on this computer (Claude Code). Approve only if you just started Claude Code.")) : null,
      h("span", { class: "mut sm" }, L("יוכל: לראות מכשירים, סוכנים, כמה מחכה לאישור ומזהי משימות; לשלוח משימה למחשב שמקבל משימות.", "It can: see devices, agents, how much waits for approval and task ids; send a task to a PC that takes tasks.")),
      h("span", { class: "mut sm" }, L("לא יוכל: לקרוא תוכן משימות, תוצאות או אישורים (נעולים), לשנות הגדרות או לאשר במקומך.", "It cannot: read task text, results or approvals (sealed), change settings or approve for you.")),
      h("span", { class: "mut xs" }, L("אפשר לנתק בכל רגע: הגדרות › אפליקציות מחוברות.", "Revoke any time: Settings › Connected apps.")),
    ),
    h("button", { type: "button", class: "btn pri big", onclick: () => void decide(true) }, L("אשר", "Approve")),
    h("button", { type: "button", class: "btn bad", onclick: () => void decide(false) }, L("סרב", "Refuse")),
  );
}

initLocale();
void start();
