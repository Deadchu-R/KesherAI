import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, t } from "../i18n";
import { Select } from "../ui/Select";
import { toast, useLibrary } from "../library";

interface Rule { tool: string; scope: "conversation" | "model" | "everywhere"; conversationId?: string; modelId?: string; createdAt?: string; until?: string; command?: string }

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

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
 * The approvals the user gave (what runs without asking, where, and for how long): in Settings → Privacy all of
 * them; in a chat's "Approvals" only those that apply to that chat. Each can get a time limit (15 minutes, an
 * hour…) or be removed. Loaded from /api/permissions.
 *
 * @param props.conversationId - Show only the approvals that hold in this chat.
 */
export function PermissionsSection({ conversationId, modelId }: { conversationId?: string; modelId?: string } = {}) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const { conversations } = useLibrary();
  useEffect(() => {
    void api<Rule[]>("/api/permissions").then(setRules).catch(() => setRules([]));
  }, []);
  if (!rules) return null;
  // In a chat: the rules for this chat, its model, and everywhere (with their place in the whole list).
  const shown = rules.map((r, i) => ({ r, i })).filter(({ r }) => !conversationId || r.scope === "everywhere" || (r.scope === "conversation" && r.conversationId === conversationId) || (r.scope === "model" && r.modelId === modelId));
  const where = (r: Rule) =>
    r.scope === "everywhere" ? t("scopeEverywhere") : r.scope === "model" ? t("scopeModel", { model: r.modelId ?? "" }) : t("scopeChat", { chat: conversations.find((c) => c.id === r.conversationId)?.title ?? "?" });
  return (
    <section className="card stack">
      <h2>{conversationId ? L("אישורים בצ'אט הזה", "Approvals in this chat") : t("permissionsTitle")}</h2>
      <p className="muted">{conversationId ? L("מה רץ כאן בלי לשאול, ועד מתי. אפשר לתת לכל אחד הגבלת זמן או להסיר.", "What runs here without asking, and until when. Give each a time limit, or remove it.") : t("permissionsHint")}</p>
      {shown.length === 0 && <p className="muted">{t("permissionsNone")}</p>}
      <div className="list">
        {shown.map(({ r, i }) => (
          <div key={`${r.tool}-${r.scope}-${r.conversationId ?? r.modelId ?? ""}-${r.command ?? ""}`} className="row">
            <span className="mono">{r.tool}{r.command ? <> · <code dir="ltr">{r.command}…</code></> : null}</span>
            <span className="grow muted" dir="auto">{where(r)} · {left(r.until)}</span>
            <Select className="model-chip" value={-1} aria-label={L("לכמה זמן", "For how long")} onChange={(e) => void api<Rule[]>(`/api/permissions/${i}`, { method: "PUT", body: { minutes: Number(e.target.value) } }).then(setRules, (err: Error) => toast(err.message))}>
              <option value={-1}>{L("⏱ זמן…", "⏱ Time…")}</option>
              {durations().map(([m, label]) => <option key={label} value={m}>{label}</option>)}
            </Select>
            <button type="button" onClick={() => void api<Rule[]>(`/api/permissions/${i}`, { method: "DELETE" }).then(setRules)}>{t("remove")}</button>
          </div>
        ))}
      </div>
    </section>
  );
}
