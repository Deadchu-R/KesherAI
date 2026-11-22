import { useCallback, useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What the server says about one free provider (free-cloud-catalog.ts + the pool's status). */
interface FreeProvider {
  id: string;
  name: string;
  free: { he: string; en: string };
  privacy: { he: string; en: string };
  trains?: boolean;
  link: string;
  keyLink: string;
  needsAccountId?: boolean;
  defaultModel: string;
  status?: {
    configured: boolean;
    enabled: boolean;
    state: "ready" | "limited" | "paused" | "nokey" | "off";
    until?: number;
    minute: { used: number; limit: number };
    day: { used: number; limit: number };
    model: string;
    lastError?: string;
  };
}
interface FreeView {
  settings: { order: string[]; disabled: string[]; chatFallback: boolean; backgroundFallback: boolean; models: Record<string, string>; cloudflareAccountId: string; zhipuRegion: "cn" | "global" };
  providers: FreeProvider[];
}
interface Listed {
  id: string;
  free: boolean;
  reason?: string;
}

/** The state as a short word and the look of its pill. */
function stateOf(p: FreeProvider): { text: string; cls: string } {
  const s = p.status;
  if (!s || s.state === "nokey") return { text: L("אין מפתח", "no key"), cls: "pill" };
  if (s.state === "off") return { text: L("כבוי", "off"), cls: "pill" };
  const mins = s.until ? Math.max(1, Math.ceil((s.until - Date.now()) / 60_000)) : 0;
  if (s.state === "limited") return { text: L(`במגבלה, עוד ${mins} דק׳`, `at its limit, ${mins} min`), cls: "pill bad" };
  if (s.state === "paused") return { text: L(`מושהה אחרי שגיאות, עוד ${mins} דק׳`, `paused after errors, ${mins} min`), cls: "pill bad" };
  return { text: L("מוכן", "ready"), cls: "pill good" };
}

/**
 * Settings › Accounts / Models › Free cloud helpers: Groq, OpenRouter (only :free models), Cloudflare Workers AI,
 * Mistral's free plan and Zhipu GLM-4-Flash. Each card says what is free (with a link: free plans change), its privacy
 * terms, and has a key field, a Test button and the provider's free models. The pool moves between them in the order
 * shown, inside their free limits, and never uses a paid model. Keys are typed on the computer and never shown again;
 * the phone sees the state only.
 */
export function FreeCloudSection() {
  const [view, setView] = useState<FreeView | null>(null);
  const remote = isRemote();
  const load = useCallback(() => void api<FreeView>("/api/free-cloud").then(setView, () => undefined), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  if (!view) return null;
  const put = (body: object) => void api<FreeView>("/api/free-cloud/settings", { method: "PUT", body }).then(setView, (e: Error) => toast(e.message));
  const s = view.settings;
  const move = (id: string, by: -1 | 1) => {
    const order = [...s.order];
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    put({ order });
  };
  const toggle = (id: string, on: boolean) => put({ disabled: on ? s.disabled.filter((x) => x !== id) : [...s.disabled, id] });
  const ordered = s.order.map((id) => view.providers.find((p) => p.id === id)).filter((p): p is FreeProvider => !!p);
  return (
    <section className="card stack free-cloud" id="free-cloud">
      <h2>☁️ {L("ספקי ענן חינמיים", "Free cloud helpers")}</h2>
      <p className="muted small">{L("מכניסים מפתח חינמי, ו-KesherAI עובר בין הספקים לבד בתוך המגבלות החינמיות שלהם: עבודת רקע ומחקר, ואם מאפשרים, גם צ'אט קטן כשהמודל המקומי כבוי. אף פעם לא מודל בתשלום. אפשר גם לבחור \"ענן חינמי (אוטומטי)\" כמודל של צ'אט.", "Enter a free key and KesherAI moves between the providers by itself, inside their free limits: background work and research and, if you allow it, small chats when the local model is off. Never a paid model. You can also pick \"Free cloud (automatic)\" as a chat's model.")}</p>
      <label className="row">
        <input type="checkbox" disabled={remote} checked={s.backgroundFallback} onChange={(e) => put({ backgroundFallback: e.target.checked })} />
        <span className="grow">{L("לעבודת רקע ועוזרים (מחקר)", "For background and helper work (research)")}</span>
      </label>
      <label className="row">
        <input type="checkbox" disabled={remote} checked={s.chatFallback} onChange={(e) => put({ chatFallback: e.target.checked })} />
        <span className="grow">{L("גם לצ'אט כשהמודל המקומי כבוי (צ'אט פרטי לעולם לא נשלח לענן)", "Also for a chat when the local model is off (a private chat is never sent to the cloud)")}</span>
      </label>
      <h3 className="small">{L("סדר הניסיון", "Order tried")}</h3>
      <ol className="free-order">
        {ordered.map((p, i) => (
          <li key={p.id} className="row" style={{ gap: 8 }}>
            <span className="grow">{p.name}</span>
            <span className={stateOf(p).cls}>{stateOf(p).text}</span>
            {!remote && (
              <>
                <button type="button" disabled={i === 0} onClick={() => move(p.id, -1)} aria-label={L("למעלה", "Move up")}>↑</button>
                <button type="button" disabled={i === ordered.length - 1} onClick={() => move(p.id, 1)} aria-label={L("למטה", "Move down")}>↓</button>
              </>
            )}
          </li>
        ))}
      </ol>
      {ordered.map((p) => (
        <ProviderCard key={p.id} p={p} s={s} remote={remote} onToggle={toggle} onView={setView} put={put} />
      ))}
      {remote && <p className="muted small">{L("מפתחות ושינויים נעשים במחשב. כאן רואים רק את המצב.", "Keys and changes are made on the computer. Here you only see the state.")}</p>}
    </section>
  );
}

/** One provider's card. */
function ProviderCard({ p, s, remote, onToggle, onView, put }: { p: FreeProvider; s: FreeView["settings"]; remote: boolean; onToggle: (id: string, on: boolean) => void; onView: (v: FreeView) => void; put: (b: object) => void }) {
  const [draft, setDraft] = useState("");
  const [account, setAccount] = useState(s.cloudflareAccountId);
  const [models, setModels] = useState<Listed[] | null>(null);
  const [busy, setBusy] = useState(false);
  const st = p.status;
  const have = !!st?.configured;
  const saveKey = (key: string | null) => {
    void api<FreeView>(`/api/free-cloud/${p.id}/key`, { method: "PUT", body: { key } }).then((v) => { onView(v); setDraft(""); setModels(null); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  };
  const test = () => {
    setBusy(true);
    void api<{ ok: boolean; message?: string; model: string } & FreeView>(`/api/free-cloud/${p.id}/test`, { method: "POST", body: {} }).then(
      (r) => { onView({ settings: r.settings, providers: r.providers }); toast(r.ok ? L(`עובד ✓ (${r.model})`, `Works ✓ (${r.model})`) : (r.message ?? L("נכשל.", "Failed."))); },
      (e: Error) => toast(e.message),
    ).finally(() => setBusy(false));
  };
  const loadModels = () => {
    setBusy(true);
    void api<{ models: Listed[] }>(`/api/free-cloud/${p.id}/models`).then((r) => setModels(r.models), (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const chosen = s.models[p.id] ?? "";
  return (
    <div className="stack free-card" style={{ borderTop: "1px solid var(--border, #8884)", paddingTop: 10 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <strong className="grow">{p.name}</strong>
        <span className={stateOf(p).cls}>{stateOf(p).text}</span>
        {!remote && have && (
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={st?.enabled ?? true} onChange={(e) => onToggle(p.id, e.target.checked)} />
            {L("פעיל", "On")}
          </label>
        )}
      </div>
      <p className="small">{L(p.free.he, p.free.en)} <a href={p.link} target="_blank" rel="noreferrer noopener">{L("כדאי לבדוק בעמוד של הספק", "check the provider's page")}</a></p>
      <p className={p.trains ? "warn small" : "muted small"}>🔒 {L(p.privacy.he, p.privacy.en)}</p>
      {st && (st.minute.limit > 0 || st.day.limit > 0) && (
        <p className="muted small" dir="ltr">
          {st.minute.limit > 0 && `${st.minute.used}/${st.minute.limit} / min`}{st.minute.limit > 0 && st.day.limit > 0 ? " · " : ""}{st.day.limit > 0 && `${st.day.used}/${st.day.limit} / day`}
        </p>
      )}
      {st?.lastError && <p className="warn small" dir="ltr">{st.lastError}</p>}
      {!remote && (
        <>
          {p.needsAccountId && (
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <input dir="ltr" style={{ flex: "1 1 180px", minWidth: 0 }} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Account ID" aria-label={L("מזהה חשבון Cloudflare", "Cloudflare account id")} />
              <button type="button" disabled={account === s.cloudflareAccountId} onClick={() => put({ cloudflareAccountId: account })}>{L("שמור", "Save")}</button>
            </div>
          )}
          {p.id === "fc-zhipu" && (
            <label className="row small" style={{ gap: 8 }}>
              <span>{L("פורטל", "Portal")}</span>
              <select value={s.zhipuRegion} onChange={(e) => put({ zhipuRegion: e.target.value })}>
                <option value="cn">open.bigmodel.cn</option>
                <option value="global">z.ai</option>
              </select>
            </label>
          )}
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <input dir="ltr" type="password" autoComplete="off" style={{ flex: "1 1 180px", minWidth: 0 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={have ? "••••••••" : L("מפתח API", "API key")} aria-label={`${p.name} ${L("מפתח", "key")}`} />
            <button type="button" disabled={!draft.trim()} onClick={() => saveKey(draft)}>{L("שמור", "Save")}</button>
            {have && <button type="button" onClick={() => saveKey(null)}>{L("הסר", "Remove")}</button>}
          </div>
          <p className="muted small"><a href={p.keyLink} target="_blank" rel="noreferrer noopener">{L("יוצרים מפתח חינם כאן", "Make a free key here")}</a> · {L("נשמר מוצפן במחשב ולא מוצג שוב", "kept encrypted on this computer, never shown again")}</p>
          {have && (
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <button type="button" disabled={busy} onClick={test}>{L("בדיקה", "Test")}</button>
              <button type="button" disabled={busy} onClick={loadModels}>{L("הצג מודלים חינמיים", "Show free models")}</button>
              <span className="muted small" dir="ltr">{chosen || st?.model}</span>
            </div>
          )}
          {models && (
            <select dir="ltr" aria-label={L("מודל", "Model")} value={chosen} onChange={(e) => put({ models: { [p.id]: e.target.value } })} style={{ maxWidth: "100%" }}>
              <option value="">{L("ברירת מחדל", "Default")} ({p.defaultModel})</option>
              {models.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.free}>{m.free ? m.id : `${m.id} (${L("בתשלום", "paid")})`}</option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}
