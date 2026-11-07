import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Key { id: string; name: string; prefix: string; createdAt: string; lastUsedAt?: string; uses?: number }
interface View { keys: Key[]; requireKeyLocally: boolean; base: string }

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" }) : L("עוד לא", "not yet"));

/**
 * The model APIs (OpenAI and Anthropic style) and an access key per app,
 * each of which can be revoked on its own.
 */
export function ApiKeysSection() {
  const [v, setV] = useState<View | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [tab, setTab] = useState<"openai" | "anthropic" | "claude">("openai");
  const [log, setLog] = useState<Array<{ at: string; caller: string; method: string; path: string; model?: string; status: number; ms: number }> | null>(null);
  useEffect(() => {
    api<View>("/api/api-keys").then(setV, () => undefined);
  }, []);
  if (!v) return null;
  const create = async () => {
    try {
      const r = await api<{ key: string; entry: Key }>("/api/api-keys", { method: "POST", body: { name } });
      setFresh({ key: r.key, name: r.entry.name });
      setName("");
      setV(await api<View>("/api/api-keys"));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const revoke = async (k: Key) => {
    if (!confirm(L(`לבטל את המפתח "${k.name}"? האפליקציה שמשתמשת בו תפסיק לעבוד.`, `Revoke "${k.name}"? The app using it stops working.`))) return;
    setV(await api<View>(`/api/api-keys/${k.id}`, { method: "DELETE" }));
  };
  const key = fresh?.key ?? "kai-…";
  const examples = {
    openai: `Base URL: ${v.base}/v1\nAPI key: ${key}\nModel: <provider>/<model>  (GET ${v.base}/v1/models)`,
    anthropic: `from anthropic import Anthropic\nclient = Anthropic(base_url="${v.base}", api_key="${key}")\nclient.messages.create(model="<provider>/<model>", max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello"}])`,
    claude: `ANTHROPIC_BASE_URL=${v.base}\nANTHROPIC_AUTH_TOKEN=${key}\nclaude`,
  };
  return (
    <section className="card stack">
      <h2>{L("API ומפתחות גישה לאפליקציות", "API and app access keys")}</h2>
      <p className="muted">{L("אפליקציות ו-SDK של OpenAI ושל Anthropic יכולים לעבוד עם כל מודל ש-KesherAI מכיר, גם מקומי. תנו לכל אפליקציה מפתח משלה — כך רואים מי משתמש ואפשר לבטל כל אחת בנפרד.", "Apps and SDKs for OpenAI and Anthropic can work with any model KesherAI knows, local ones too. Give each app its own key, so you see who uses it and can revoke each one alone.")}</p>
      <div className="row seg" role="tablist">
        {([["openai", "OpenAI"], ["anthropic", "Anthropic SDK"], ["claude", "Claude Code"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div className="snippet"><pre dir="ltr">{examples[tab]}</pre><button type="button" onClick={() => void navigator.clipboard?.writeText(examples[tab])}>{L("העתק", "Copy")}</button></div>
      {tab === "claude" && <p className="muted small">{L("Claude Code יעבוד עם המודל הפעיל ב-KesherAI (שם מודל שהוא לא מכיר הולך למודל הצ׳אט הפעיל). מודל מקומי צריך לתמוך בכלים.", "Claude Code then runs on KesherAI's active chat model (a model name it does not know goes there). A local model needs tool support.")}</p>}
      {fresh && (
        <div className="key-fresh">
          <strong>{L(`המפתח של "${fresh.name}" — העתיקו אותו עכשיו, הוא לא יוצג שוב:`, `The key for "${fresh.name}" — copy it now, it is not shown again:`)}</strong>
          <div className="snippet"><pre dir="ltr">{fresh.key}</pre><button type="button" onClick={() => void navigator.clipboard?.writeText(fresh.key)}>{L("העתק", "Copy")}</button></div>
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={L("שם האפליקציה, למשל Cursor בלפטופ", "The app's name, e.g. Cursor on the laptop")} />
        <button type="submit" className="primary" disabled={!name.trim()}>{L("צור מפתח", "Create key")}</button>
      </form>
      {v.keys.length > 0 && (
        <ul className="key-list">
          {v.keys.map((k) => (
            <li key={k.id} className="row">
              <strong>{k.name}</strong>
              <code dir="ltr">{k.prefix}…</code>
              <span className="muted small">{L("שימוש אחרון:", "Last used:")} {when(k.lastUsedAt)}{k.uses ? ` · ${k.uses}` : ""}</span>
              <span className="grow" />
              <button type="button" onClick={() => void revoke(k)}>{L("ביטול", "Revoke")}</button>
            </li>
          ))}
        </ul>
      )}
      <details onToggle={(e) => (e.target as HTMLDetailsElement).open && void api<NonNullable<typeof log>>("/api/api-keys/log").then(setLog)}>
        <summary className="muted small">{L("בקשות אחרונות", "Recent requests")}</summary>
        {log && log.length === 0 && <p className="muted small">{L("עוד אין.", "None yet.")}</p>}
        {log && log.length > 0 && (
          <table className="api-log small">
            <tbody>
              {log.map((l, i) => (
                <tr key={i}>
                  <td className="muted">{new Date(l.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined)}</td>
                  <td dir="auto">{l.caller}</td>
                  <td dir="ltr">{l.path}</td>
                  <td dir="ltr">{l.model ?? ""}</td>
                  <td className={l.status >= 400 ? "bad" : ""}>{l.status}</td>
                  <td className="muted">{l.ms < 1000 ? `${l.ms} ms` : `${(l.ms / 1000).toFixed(1)} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
      <label className="check">
        <input type="checkbox" checked={v.requireKeyLocally} onChange={(e) => void api<View>("/api/api-keys/settings", { method: "PUT", body: { requireKeyLocally: e.target.checked } }).then(setV)} />
        {L("לדרוש מפתח גם מאפליקציות במחשב הזה (ממכשירים אחרים תמיד צריך מפתח או את טוקן הגישה מרחוק)", "Ask apps on this computer for a key too (other devices always need a key or the remote token)")}
      </label>
    </section>
  );
}
