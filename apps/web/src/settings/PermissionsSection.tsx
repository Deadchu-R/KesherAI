import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, t, he$ } from "../i18n";
import { Select } from "../ui/Select";
import { toast, useLibrary } from "../library";

interface Rule { tool: string; scope: "conversation" | "model" | "everywhere"; conversationId?: string; modelId?: string; createdAt?: string; until?: string; command?: string; target?: string }
/** One grant still in force (GET /api/permissions/active): its place in the whole list, the agent kind, time left. */
interface Active { index: number; rule: Rule; kind: "chat" | "helper"; leftMs?: number }

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** How long an approval can be set to hold, in minutes (0 = for good). */
export function durations(): Array<[number, string]> {
  return [
    [15, L("15 דקות", "15 minutes")],
    [60, L("שעה", "1 hour")],
    [240, L("4 שעות", "4 hours")],
    [Math.max(1, Math.round((new Date().setHours(24, 0, 0, 0) - Date.now()) / 60_000)), L("עד סוף היום", "Until the end of today")],
    [7 * 24 * 60, L("שבוע", "1 week")],
    [0, L("לתמיד", "For good")],
  ];
}

/** "12 min left", "until 18:30", "ended" or "for good". */
function left(until?: string): string {
  if (!until) return L("לתמיד", "for good");
  const ms = Date.parse(until) - Date.now();
  if (ms <= 0) return L("הסתיים", "ended");
  if (ms < 60 * 60_000) return L(`עוד ${Math.ceil(ms / 60_000)} דק'`, `${Math.ceil(ms / 60_000)} min left`);
  return `${L("עד", "until")} ${new Date(until).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
}

/**
 * Smart auto approvals (F10): in chats set to "auto-edit", the chat's model reviews a plain command first and lets
 * it run when it clearly fits what you asked; anything else is still asked. Turned on only from the computer.
 */
export function AutoReviewSection() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ on: boolean }>("/api/permissions/auto-review").then((r) => setOn(r.on), () => setOn(null));
  }, []);
  if (on === null) return null;
  const set = (value: boolean) => void api<{ on: boolean }>("/api/permissions/auto-review", { method: "PUT", body: { on: value } }).then((r) => setOn(r.on), (e: Error) => toast(e.message));
  return (
    <section className="card stack">
      <h2>{L("אישורים אוטומטיים חכמים", "Smart auto approvals")}</h2>
      <label className="row check-row"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /><span className="grow">{L("המודל של הצ'אט בודק פקודות לפני שהן מגיעות אליי", "The chat's model checks commands before they reach me")}</span></label>
      <p className="muted small">
        {L(
          "בצ'אטים במצב \"עריכה אוטומטית\", המודל של הצ'אט בודק כל פקודה לפני שהיא מגיעה אליך: בנייה, בדיקות או git status שמתאימים למה שביקשת רצים לבד, וכל השאר עדיין נשאלים. הבודק רואה רק מה שכתבת ואת הפקודה, לא תוצאות של כלים. פקודות מסוכנות (מחיקה, push, התקנה) תמיד נשאלות. מדליקים רק מהמחשב.",
          "In chats set to \"auto-edit\", the chat's model checks each command before it reaches you: a build, tests or git status that fit what you asked run by themselves, and everything else is still asked. The reviewer sees only what you wrote and the command, never tool output. Dangerous commands (deleting, push, installing) always ask. Turned on only from the computer.",
        )}
      </p>
    </section>
  );
}

/** Where a grant holds, in words: a folder, a site, an app, or the whole tool. */
function targetText(target?: string): string | undefined {
  if (!target) return undefined;
  const [kind, ...rest] = target.split(":");
  const v = rest.join(":");
  if (kind === "site") return L(`באתר ${v}`, `on ${v}`);
  if (kind === "app") return L(`באפליקציה ${v}`, `in the ${v} app`);
  if (kind === "folder") return L(`בתיקייה ${v}`, `in ${v}`);
  return undefined;
}

/** A tool's name as people say it: the browser family as "the browser", a helper's without its prefix. */
function toolText(tool: string): string {
  const base = tool.replace(/^helper:/, "");
  return base === "browser_*" ? L("הדפדפן", "the browser") : base === "*" ? L("כל כלי", "any tool") : base;
}

/**
 * Settings › Approvals (and a chat's "Approvals"): the grants still in force — what runs without asking, which agent
 * kind (the chat or its helpers, kept apart), where (a folder, a site, an app), and the time left — each with a time
 * limit to set and Revoke. Revoke works from the phone too (it only narrows); widening a grant needs the computer.
 * Always-ask steps (dangerous commands, sensitive sites, deletes, system settings, guests) never appear here: no
 * card can grant them.
 *
 * @param props.conversationId - Show only the approvals that hold in this chat.
 * @param props.modelId - The chat's model (its "for this model" approvals).
 */
export function PermissionsSection({ conversationId, modelId }: { conversationId?: string; modelId?: string } = {}) {
  const [grants, setGrants] = useState<Active[] | null>(null);
  const [, tick] = useState(0);
  const { conversations } = useLibrary();
  const load = () => void api<Active[]>("/api/permissions/active").then(setGrants).catch(() => setGrants([]));
  useEffect(() => {
    load();
    // The time left counts down while the page is open; ended grants drop off on the next load.
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!grants) return null;
  // In a chat: the grants for this chat, its model, and everywhere.
  const shown = grants.filter(({ rule: r }) => !conversationId || r.scope === "everywhere" || (r.scope === "conversation" && r.conversationId === conversationId) || (r.scope === "model" && r.modelId === modelId));
  const where = (r: Rule) =>
    r.scope === "everywhere" ? t("scopeEverywhere") : r.scope === "model" ? t("scopeModel", { model: r.modelId ?? "" }) : t("scopeChat", { chat: conversations.find((c) => c.id === r.conversationId)?.title ?? "?" });
  const revoke = (g: Active) => void api(`/api/permissions/${g.index}`, { method: "DELETE" }).then(load, (err: Error) => toast(err.message));
  return (
    <section className="card stack">
      <h2>{conversationId ? L("אישורים בצ'אט הזה", "Approvals in this chat") : L("אישורים", "Approvals")}</h2>
      <p className="muted">
        {conversationId
          ? L("מה רץ כאן בלי לשאול, ועד מתי. אפשר לתת לכל אחד הגבלת זמן או לבטל.", "What runs here without asking, and until when. Give each a time limit, or revoke it.")
          : L("מה רץ בלי לשאול, איפה ועד מתי. עוזרים מקבלים אישורים נפרדים ומחמירים יותר. פקודות מסוכנות, סיסמאות, תשלומים, מחיקות, הגדרות מערכת, אתרים רגישים ואורחים תמיד נשאלים.", "What runs without asking, where, and until when. Helpers get their own, stricter approvals. Dangerous commands, passwords, payments, deletes, system settings, sensitive sites and guests are always asked.")}
      </p>
      {shown.length === 0 && <p className="muted">{t("permissionsNone")}</p>}
      <div className="list grant-list">
        {shown.map((g) => {
          const r = g.rule;
          const place = targetText(r.target);
          return (
            <div key={`${g.index}-${r.tool}-${r.target ?? ""}-${r.command ?? ""}`} className="row grant-row">
              <span className="grant-what" dir="auto">
                {g.kind === "helper" && <span className="pill">{L("עוזר", "Helper")}</span>} <bdi className="mono">{toolText(r.tool)}</bdi>
                {r.command ? <> · <code dir="ltr">{r.command}…</code></> : null}
                {place ? <> · <span>{place}</span></> : null}
              </span>
              <span className="grow muted small" dir="auto">{where(r)} · {left(r.until)}</span>
              <Select className="model-chip" value={-1} aria-label={L("לכמה זמן", "For how long")} onChange={(e) => void api(`/api/permissions/${g.index}`, { method: "PUT", body: { minutes: Number(e.target.value) } }).then(load, (err: Error) => toast(err.message))}>
                <option value={-1}>{L("⏱ זמן…", "⏱ Time…")}</option>
                {durations().map(([m, label]) => <option key={label} value={m}>{label}</option>)}
              </Select>
              <button type="button" onClick={() => revoke(g)}>{L("בטל", "Revoke")}</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
