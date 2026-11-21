import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Settings → Accounts: the user's Hugging Face access token, for models that need a login (gated) and a higher
 * download limit. It is typed on the computer, kept encrypted there and never shown again: the page only knows
 * whether it is set ("saved ✓" / remove). The phone sees whether it is set and changes it on the computer.
 * The download error card for a 401/403 opens this section.
 */
export function HuggingFaceTokenSection() {
  const [set, setSet] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const remote = isRemote();
  useEffect(() => {
    void api<{ set: boolean }>("/api/hf-token").then((r) => setSet(r.set), () => undefined);
  }, []);
  if (set === null) return null;
  const save = (token: string | null) =>
    void api<{ set: boolean }>("/api/hf-token", { method: "PUT", body: { token } }).then((r) => { setSet(r.set); setDraft(""); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  return (
    <section className="card stack" id="hf-token">
      <h2>Hugging Face</h2>
      <p className="muted small">{L("טוקן גישה להורדת מודלים שדורשים התחברות, ולמגבלת הורדה גבוהה יותר. אפשר ליצור אחד חינם באתר של Hugging Face (Settings › Access Tokens, הרשאת קריאה). הוא נשמר מוצפן במחשב ולא מוצג שוב.", "An access token for models that need a login, and for a higher download limit. You can make one free on the Hugging Face site (Settings › Access Tokens, read access). It is kept encrypted on this computer and never shown again.")}</p>
      <span className="small">{set ? L("נשמר ✓", "saved ✓") : L("לא מוגדר", "not set")}</span>
      {!remote && (
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input dir="ltr" type="password" autoComplete="off" style={{ flex: "1 1 180px", minWidth: 0 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="hf_…" aria-label={L("טוקן של Hugging Face", "Hugging Face token")} />
          <button type="button" disabled={!draft.trim()} onClick={() => save(draft)}>{L("שמור", "Save")}</button>
          {set && <button type="button" onClick={() => save(null)}>{L("הסר", "Remove")}</button>}
        </div>
      )}
      {remote && <p className="muted small">{L("משנים את זה במחשב.", "Changed on the computer.")}</p>}
    </section>
  );
}
