/**
 * The privacy guard in the interface (Roee, 2026-11-23): the "may train on your data" tag (model menu, Settings ›
 * Connections, task cards), the chat's one-time warning line, and the "sensitive info found" dialog shown before a
 * message goes to such a model. The server hides or blocks what is left (core privacy-guard.ts), so the dialog is a
 * choice, never the only guard. Works the same on the phone (remote): the check runs on the computer.
 */
import { useEffect, useState } from "react";
import { LEAK_LABEL, connectionTrainingRisk, trainingRiskOf, type LeakKind, type PrivacyMode, type TrainingRisk } from "@kesher/shared";
import { api, type ModelInfo } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The server's answer to the chat's check (POST /api/privacy/check). */
export interface PrivacyCheck {
  risk: TrainingRisk | null;
  mode: PrivacyMode;
  found: Array<{ kind: LeakKind; count: number }>;
  hidden: string;
}

/**
 * The "⚠ may train on your data" tag for a model or a connection. Nothing for services that do not train.
 *
 * @param p.modelId - A model id (`<connection>/<model>`).
 * @param p.connection - Or a connection id (its row in Settings › Connections).
 * @param p.short - Only the ⚠ sign (the model chip), with the words as its tooltip.
 */
export function TrainTag(p: { modelId?: string; connection?: string; short?: boolean }) {
  const risk = p.modelId ? trainingRiskOf(p.modelId) : p.connection ? connectionTrainingRisk(p.connection) : undefined;
  if (!risk) return null;
  const words = risk === "some" ? L("חלק מהמודלים החינמיים עשויים לאמן על המידע שלך", "some free models may train on your data") : L("עשוי לאמן על המידע שלך", "may train on your data");
  const why = L("השירות הזה עשוי להשתמש במה שנשלח אליו לאימון מודלים. מידע רגיש נבדק לפני שליחה (הגדרות › פרטיות).", "This service may use what it is sent to train models. Sensitive info is checked before sending (Settings › Privacy).");
  return (
    <span className={`train-tag${p.short ? " short" : ""}`} title={`${words}. ${why}`} aria-label={words}>
      ⚠{p.short ? "" : ` ${words}`}
    </span>
  );
}

const warnKey = (convId: string, modelId: string) => `kesher.trainWarned.${convId}.${modelId.split("/")[0]}`;

/**
 * The chat's one-time line when its model's service may train: shown until "Got it" for this chat and service.
 *
 * @param p.convId - The chat.
 * @param p.modelId - Its model.
 */
export function TrainWarnLine(p: { convId: string; modelId: string }) {
  const key = warnKey(p.convId, p.modelId);
  const [seen, setSeen] = useState(() => localStorage.getItem(key) === "1");
  useEffect(() => {
    setSeen(localStorage.getItem(key) === "1");
  }, [key]);
  if (seen || !trainingRiskOf(p.modelId)) return null;
  return (
    <div className="train-warn" role="note">
      <span aria-hidden="true">⚠</span>
      <span className="grow">
        {L("השירות של המודל הזה עשוי לאמן על מה שנשלח אליו. לפני כל שליחה KesherAI בודק אם יש מפתחות, סיסמאות או מידע אישי, ושואל מה לעשות.", "This model's service may train on what you send. Before each message KesherAI checks for keys, passwords and personal info, and asks what to do.")}{" "}
        <a href="#/settings/privacy">{L("הגדרות פרטיות", "Privacy settings")}</a>
      </span>
      <button type="button" className="small" onClick={() => { localStorage.setItem(key, "1"); setSeen(true); }}>{L("הבנתי", "Got it")}</button>
    </div>
  );
}

/** What the user chose in the dialog: send the hidden text, switch to another model and send as written, or cancel. */
export type PrivacyChoice = { kind: "hide"; text: string } | { kind: "model"; modelId: string } | null;

let show: ((r: { check: PrivacyCheck; alt?: ModelInfo; resolve: (c: PrivacyChoice) => void }) => void) | undefined;

/**
 * The model to offer instead: the first chat model on this computer or a local server, else one whose service does
 * not train.
 *
 * @param models - The models the chat can use.
 */
export function saferModel(models: readonly ModelInfo[]): ModelInfo | undefined {
  const chat = models.filter((m) => m.category === "chat" && !m.id.startsWith("agent/") && !trainingRiskOf(m.id));
  return chat.find((m) => m.location !== "cloud") ?? chat[0];
}

/**
 * Before a chat message is sent: when the chat's model may train, asks the computer what the text holds and, on a
 * hit, lets the user choose (the dialog). Models that do not train, and texts with nothing found, pass at once.
 *
 * @param modelId - The chat's model.
 * @param text - The message.
 * @param models - The chat models, for the safer choice.
 * @returns What to do: `hide` with the hidden text, `model` to switch to, or null to cancel. Undefined: send as is.
 */
export async function guardBeforeSend(modelId: string, text: string, models: readonly ModelInfo[]): Promise<PrivacyChoice | undefined> {
  if (!trainingRiskOf(modelId)) return undefined;
  const check = await api<PrivacyCheck>("/api/privacy/check", { method: "POST", body: { modelId, text } }).catch(() => null);
  // The check could not run: the server's own guard still hides what it finds before sending.
  if (!check || !check.found.length) return undefined;
  if (check.mode === "auto-hide") return { kind: "hide", text: check.hidden };
  const alt = saferModel(models);
  if (!show) return { kind: "hide", text: check.hidden };
  return new Promise<PrivacyChoice>((resolve) => show!({ check, ...(alt ? { alt } : {}), resolve }));
}

/** The dialog's host: mounted once in the app (like the model picker). */
export function PrivacyHitHost() {
  const [req, setReq] = useState<{ check: PrivacyCheck; alt?: ModelInfo; resolve: (c: PrivacyChoice) => void } | null>(null);
  useEffect(() => {
    show = setReq;
    return () => {
      show = undefined;
    };
  }, []);
  if (!req) return null;
  const he = getLocale() === "he";
  const done = (c: PrivacyChoice) => {
    req.resolve(c);
    setReq(null);
  };
  const blocked = req.check.mode === "block-training-providers";
  return (
    <div className="dialog-backdrop on-top" role="presentation" onClick={() => done(null)}>
      <div className="dialog card privacy-hit" role="alertdialog" aria-modal="true" aria-labelledby="privacy-hit-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="privacy-hit-title">🛡 {L("נמצא מידע רגיש", "Sensitive info found")}</h2>
        <p className="muted">
          {L("ההודעה נשלחת לשירות שעשוי לאמן על מה שנשלח אליו. מצאנו בה:", "This message goes to a service that may train on what it is sent. It holds:")}
        </p>
        <div className="privacy-kinds">
          {req.check.found.map((f) => (
            <span key={f.kind} className="chip">{f.count > 1 ? `${f.count} × ` : ""}{he ? he$(LEAK_LABEL[f.kind].he) : LEAK_LABEL[f.kind].en}</span>
          ))}
        </div>
        {!blocked && (
          <>
            <p className="small muted">{L("כך היא תישלח אם נסתיר:", "With them hidden it is sent as:")}</p>
            <pre className="privacy-preview" dir="auto">{req.check.hidden.length > 600 ? `${req.check.hidden.slice(0, 600)}…` : req.check.hidden}</pre>
          </>
        )}
        {blocked && <p className="small">{L("לפי ההגדרות שלך, מידע כזה לא נשלח לשירותים שמאמנים.", "By your settings, such info is never sent to services that train.")}</p>}
        <div className="privacy-actions">
          {!blocked && <button type="button" className="primary" autoFocus onClick={() => done({ kind: "hide", text: req.check.hidden })}>{L("להסתיר ולשלוח", "Hide and send")}</button>}
          {req.alt && (
            <button type="button" {...(blocked ? { className: "primary", autoFocus: true } : {})} onClick={() => done({ kind: "model", modelId: req.alt!.id })}>
              {L("לשלוח ל", "Send to ")}<bdi dir="ltr">{req.alt.name}</bdi>{req.alt.location === "cloud" ? L(" (לא מאמן)", " (does not train)") : L(" (מקומי)", " (local)")}
            </button>
          )}
          <button type="button" onClick={() => done(null)}>{L("ביטול", "Cancel")}</button>
        </div>
        <a className="small" href="#/settings/privacy" onClick={() => done(null)}>{L("הגדרות פרטיות", "Privacy settings")}</a>
      </div>
    </div>
  );
}
