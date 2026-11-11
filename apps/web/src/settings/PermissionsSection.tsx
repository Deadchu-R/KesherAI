import { useEffect, useState } from "react";
import { api } from "../api";
import { useLibrary } from "../library";
import { getLocale, t } from "../i18n";

interface Rule { tool: string; scope: "conversation" | "model" | "everywhere"; conversationId?: string; modelId?: string; createdAt?: string; until?: string; command?: string }

/**
 * Settings → Privacy: the approvals the user gave for good (what runs without
 * asking, and where it applies). Loaded from /api/permissions; each row can be
 * removed.
 */
export function PermissionsSection() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const { conversations } = useLibrary();
  useEffect(() => {
    void api<Rule[]>("/api/permissions").then(setRules).catch(() => setRules([]));
  }, []);
  if (!rules) return null;
  const where = (r: Rule) =>
    r.scope === "everywhere" ? t("scopeEverywhere") : r.scope === "model" ? t("scopeModel", { model: r.modelId ?? "" }) : t("scopeChat", { chat: conversations.find((c) => c.id === r.conversationId)?.title ?? "?" });
  return (
    <section className="card stack">
      <h2>{t("permissionsTitle")}</h2>
      <p className="muted">{t("permissionsHint")}</p>
      {rules.length === 0 && <p className="muted">{t("permissionsNone")}</p>}
      <div className="list">
        {rules.map((r, i) => (
          <div key={`${r.tool}-${r.scope}-${r.conversationId ?? r.modelId ?? ""}-${r.command ?? ""}`} className="row">
            <span className="mono">{r.tool}{r.command ? <> · <code dir="ltr">{r.command}…</code></> : null}</span>
            <span className="grow muted" dir="auto">{where(r)}{r.until ? ` · ${Date.parse(r.until) <= Date.now() ? (getLocale() === "he" ? "הסתיים" : "ended") : `${getLocale() === "he" ? "עד" : "until"} ${new Date(r.until).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}` : ""}</span>
            <button type="button" onClick={() => void api<Rule[]>(`/api/permissions/${i}`, { method: "DELETE" }).then(setRules)}>{t("remove")}</button>
          </div>
        ))}
      </div>
    </section>
  );
}
