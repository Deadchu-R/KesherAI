import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Request { id: string; code: string; device: string; from: string }

/** On this computer: a phone that found it on the network asks to connect; the user allows or denies. */
export function PairPrompt() {
  const [reqs, setReqs] = useState<Request[]>([]);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Request[]>("/api/pair").then(
        (r) => !stop && setReqs(r),
        () => (stop = true), // not this computer (a phone's view): nothing to ask
      );
    void load();
    const id = setInterval(() => !stop && void load(), 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  const r = reqs[0];
  if (!r) return null;
  const answer = (allow: boolean) => void api(`/api/pair/${r.id}`, { method: "POST", body: { allow } }).finally(() => setReqs((x) => x.filter((y) => y.id !== r.id)));
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog card stack" role="alertdialog" aria-modal="true" aria-labelledby="pair-title">
        <strong id="pair-title">{L(`"${r.device}" רוצה להתחבר למחשב הזה`, `"${r.device}" wants to connect to this computer`)}</strong>
        <p className="muted small">{L(`מהרשת: ${r.from}. אשר רק אם זה הטלפון שלך ומופיע עליו אותו קוד.`, `From the network: ${r.from}. Allow only if it is your phone and it shows the same code.`)}</p>
        <p className="pair-code" dir="ltr">{r.code}</p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={() => answer(false)}>{L("דחה", "Deny")}</button>
          <button type="button" className="primary" onClick={() => answer(true)}>{L("אשר", "Allow")}</button>
        </div>
      </div>
    </div>
  );
}
