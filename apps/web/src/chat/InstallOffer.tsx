import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What the server says about one installable (routes/installables.ts InstallView). */
export interface InstallView {
  id: string;
  he: string;
  en: string;
  aboutHe: string;
  aboutEn: string;
  sizeGb?: number;
  approx?: boolean;
  where: string;
  changeHref: string;
  ready: boolean;
  busy: boolean;
}

/**
 * "Install" under the answer when the chat needs something that is not installed (the model's offer_install call;
 * docs/WORK_LIST.md "Chat step 8b"). The button opens a floating window with what it is, its size and where it is
 * saved, and Install / Cancel. The install runs on the computer (also when pressed on the phone) with the app's own
 * installer; when it is done the server sends the chat "Installed, go on" and the chat continues by itself.
 *
 * @param props.id - The installable's id (installables.ts).
 * @param props.why - The model's short reason, shown on the chip.
 * @param props.convId - The chat to continue after installing.
 */
export function InstallOffer({ id, why, convId }: { id: string; why?: string; convId?: string }) {
  const [info, setInfo] = useState<InstallView | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | "installing" | "error">("idle");
  const [error, setError] = useState("");
  const load = () => api<InstallView>(`/api/installables/${encodeURIComponent(id)}`).then(setInfo, () => undefined);
  useEffect(() => void load(), [id]);
  // While it installs: check every few seconds (the window may be closed; the chip still shows the state).
  const installing = state === "installing" || (!!info?.busy && !info.ready);
  useEffect(() => {
    if (!installing) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [installing, id]);
  const name = info ? (getLocale() === "he" ? he$(info.he) : info.en) : id;
  const install = async () => {
    setState("starting");
    setError("");
    try {
      setInfo(await api<InstallView>(`/api/installables/${encodeURIComponent(id)}/install`, {
        method: "POST",
        body: { ...(convId ? { chatId: convId } : {}), continueText: L(`הותקן: ${name}. תמשיך בבקשה הקודמת שלי.`, `Installed: ${name}. Please go on with my request.`) },
      }));
      setState("installing");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };
  const size = installSize(info);
  return (
    <div className={`memory-chip install-offer${info?.ready ? " undone" : ""}`} role="status">
      <span aria-hidden>📦</span>
      <span className="grow memory-chip-text" dir="auto">
        <strong>{info?.ready ? L(`${name} מותקן`, `${name} is installed`) : installing ? L(`מתקין את ${name}…`, `Installing ${name}…`) : L(`צריך להתקין: ${name}`, `Needs installing: ${name}`)}</strong>
        {why && !info?.ready && <span className="muted"> · {why}</span>}
      </span>
      {!info?.ready && !installing && <button type="button" className="primary small" onClick={() => setOpen(true)}>{L("להתקנה", "Install")}</button>}
      {open && (
        <InstallDialog
          info={info}
          name={name}
          size={size}
          starting={state === "starting"}
          error={error}
          onInstall={() => void install()}
          onCancel={() => setOpen(false)}
          onNavigate={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The size the Install window shows.
 *
 * @param info - What the server says about the installable.
 * @returns "~1.2 GB", "120 MB", "nothing to download" (editors), or "shown in Downloads" when the installer does not say.
 */
export function installSize(info: InstallView | null): string {
  if (info?.sizeGb === undefined) return L("יוצג בהורדות", "shown in Downloads");
  if (info.sizeGb === 0) return L("בלי הורדה", "nothing to download");
  return `${info.approx ? "~" : ""}${info.sizeGb < 1 ? `${Math.max(1, Math.round(info.sizeGb * 1024))} MB` : `${info.sizeGb} GB`}`;
}

/**
 * The Install window: what it is, its size and where it is saved, with Install / Cancel. Shared by the chat's Install
 * button and by the editors' "Edit in…" when the other editor is missing (InstallWindow.tsx). Works on a 390 px phone.
 *
 * @param props.info - What the server says about it (null while loading).
 * @param props.name - Its name in the current language.
 * @param props.size - The size line ({@link installSize}).
 * @param props.starting - The Install press is being sent.
 * @param props.error - An error to show.
 * @param props.why - What the person was doing (the editors' hand-off), shown as a line.
 * @param props.note - The line under the facts (what happens after installing).
 */
export function InstallDialog({ info, name, size, starting, error, why, note, onInstall, onCancel, onNavigate }: {
  info: InstallView | null;
  name: string;
  size: string;
  starting: boolean;
  error: string;
  why?: string;
  note?: string;
  onInstall: () => void;
  onCancel: () => void;
  onNavigate: () => void;
}) {
  return createPortal(
    <div className="dialog-backdrop on-top" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog card stack install-dialog" role="dialog" aria-modal="true" aria-label={L("התקנה", "Install")} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <h3 dir="auto">{L(`להתקין את ${name}?`, `Install ${name}?`)}</h3>
        {why && <p className="muted small" dir="auto">{why}</p>}
        {info ? (
          <dl className="install-facts">
            <dt>{L("מה זה", "What it is")}</dt>
            <dd dir="auto">{getLocale() === "he" ? he$(info.aboutHe) : info.aboutEn}</dd>
            <dt>{L("גודל", "Size")}</dt>
            <dd dir="ltr">{size}</dd>
            <dt>{L("נשמר ב", "Saved in")}</dt>
            <dd>
              <code dir="ltr" className="install-where">{info.where}</code>{" "}
              <a className="chip-text" href={info.changeHref} onClick={onNavigate}>{L("שינוי", "Change")}</a>
            </dd>
          </dl>
        ) : <p className="muted">…</p>}
        <p className="muted small">{note ?? L("ההתקנה רצה במחשב, גם כשלוחצים מהטלפון. כשתסתיים, הצ'אט ימשיך לבד.", "It installs on the computer, also when pressed on the phone. When it is done, the chat goes on by itself.")}</p>
        {error && <p className="danger small" dir="auto">{error}</p>}
        <div className="row wrap">
          <button type="button" className="primary" disabled={!info || starting} onClick={onInstall}>{starting ? L("מתחיל…", "Starting…") : L("התקנה", "Install")}</button>
          <button type="button" onClick={onCancel}>{L("ביטול", "Cancel")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
