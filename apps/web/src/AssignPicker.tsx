import { useState } from "react";
import { ASSIGN_CHOICES, assignQuestion, KNOWN_MODELS, type AssignResult, type AssignTo, type InboxModel, type ModelFamily } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

/**
 * "Who does it" (Roee, 2026-11-20; boards InboxAssign, PhoneInboxAssign): a button that opens the list of executors
 * (Claude, Antigravity, the local model, a chat agent role) for an inbox task or a work-list item. Choosing one sends
 * it through the server (task-assign.ts), so it works the same from the phone in remote. A running or finished task
 * asks first; nothing is stopped or run again without the user's yes.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * @param p.id - The inbox task id, or the work-list item id (`w-…`).
 * @param p.current - Who has it now (marked in the list).
 * @param p.label - The button's text (default "Who does it").
 * @param p.onDone - Called after a change (to load the list again).
 * @param p.only - For a task that has not started and was given to an executor: whether "only this executor" is on (the
 *   quota failover then never moves it). Shown under the list as a switch.
 * @param p.model - For an Antigravity task that has not started: the models to offer, the task's pick ("" = the
 *   default) and the default's family (inbox-models.ts). Shown under the list as "Model".
 */
export function AssignPicker({ id, current, label, onDone, model, only }: { id: string; current?: AssignTo; label?: string; onDone?: () => void; model?: { list: InboxModel[]; pick: string; auto: ModelFamily }; only?: { on: boolean } }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (to: AssignTo, confirm = false): Promise<void> => {
    setBusy(true);
    try {
      const r = await api<AssignResult>(`/api/task-inbox/assign/${encodeURIComponent(id)}`, { method: "POST", body: { to, confirm } });
      if (r.ask && !confirm) {
        const q = assignQuestion(r.ask, to);
        if (window.confirm(L(q.he, q.en))) return await send(to, true);
        return;
      }
      toast(r.text);
      if (r.ok) {
        setOpen(false);
        onDone?.();
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setOnly = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/task-inbox/tasks/${encodeURIComponent(id)}/only-this`, { method: "PUT", body: { on } });
      toast(on ? L("רק המבצע הזה: המשימה תחכה לו", "Only this executor: the task waits for it") : L("אפשר להעביר למבצע אחר כשנגמרת המכסה", "May move to another executor when its quota runs out"));
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pickModel = async (name: string): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/task-inbox/tasks/${encodeURIComponent(id)}/model`, { method: "PUT", body: { model: name } });
      toast(name ? L(`ירוץ על ${name}`, `Runs on ${name}`) : L("ירוץ על ברירת המחדל לסוג המשימה", "Runs on the default for its kind"));
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="assign">
      <button type="button" aria-expanded={open} aria-haspopup="true" disabled={busy} onClick={() => setOpen((o) => !o)}>
        👤 {label ?? L("מי עושה", "Who does it")} ▾
      </button>
      {open && (
        <span className="assign-list" role="group" aria-label={L("למי לתת את המשימה", "Who to give the task to")}>
          {ASSIGN_CHOICES.map((c) => (
            <button type="button" key={c.to} className={`assign-opt${c.to === current ? " on" : ""}`} aria-pressed={c.to === current} disabled={busy} onClick={() => void send(c.to)}>
              <span aria-hidden>{c.icon}</span>
              <span className="assign-t">
                <b>{L(c.he, c.en)}</b>
                <span className="small muted">{c.to === current ? L("אצלו עכשיו", "Has it now") : L(c.noteHe, c.noteEn)}</span>
              </span>
            </button>
          ))}
          {only && (
            <label className="assign-only small">
              <input type="checkbox" role="switch" checked={only.on} disabled={busy} onChange={(e) => void setOnly(e.target.checked)} />
              <span>
                <b>{L("רק המבצע הזה", "Only this executor")}</b>
                <span className="muted"> · {only.on ? L("תחכה לו גם כשנגמרת המכסה", "waits for it even when its quota is out") : L("אם נגמרת המכסה, עוברת למבצע עם מכסה", "if its quota runs out, it moves to one with quota")}</span>
              </span>
            </label>
          )}
          {model && current === "antigravity" && (
            <span className="assign-models" role="group" aria-label={L("מודל ב-Antigravity", "Model in Antigravity")}>
              <span className="small muted">{L("מודל", "Model")}</span>
              <button type="button" className={`chip-text${!model.pick ? " on" : ""}`} aria-pressed={!model.pick} disabled={busy} onClick={() => void pickModel("")}>
                {L("אוטומטי", "Auto")} <span className="muted">({KNOWN_MODELS[model.auto].replace(/\s*\(.*\)$/, "")})</span>
              </button>
              {model.list.map((m) => (
                <button type="button" key={m.id} className={`chip-text${model.pick === m.name ? " on" : ""}`} aria-pressed={model.pick === m.name} disabled={busy} onClick={() => void pickModel(m.name)} dir="ltr">
                  {m.name}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The model on an Antigravity task's row as a button (Roee, 26.11): tap it to pick another of Antigravity's models for
 * the next run, in the same place the model is shown. "Auto" goes back to the default for the task's kind.
 *
 * @param p.id - The inbox task id.
 * @param p.label - The model shown now (its pick, or the one it ran on).
 * @param p.model - The models Antigravity offers, the task's pick ("" = the default) and the default's family.
 * @param p.onDone - Called after a change (to load the list again).
 */
export function ModelPick({ id, label, model, onDone }: { id: string; label: string | null; model: { list: InboxModel[]; pick: string; auto: ModelFamily }; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pick = async (name: string): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/task-inbox/tasks/${encodeURIComponent(id)}/model`, { method: "PUT", body: { model: name } });
      toast(name ? L(`ירוץ על ${name}`, `Runs on ${name}`) : L("ירוץ על ברירת המחדל לסוג המשימה", "Runs on the default for its kind"));
      setOpen(false);
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const auto = KNOWN_MODELS[model.auto].replace(/\s*\(.*\)$/, "");
  return (
    <span className="assign model-pick">
      <button type="button" className="chip-text tinbox-model" dir="ltr" aria-expanded={open} aria-haspopup="true" disabled={busy} title={L("בחר מודל של Antigravity", "Pick Antigravity's model")} onClick={() => setOpen((o) => !o)}>
        {label || `${L("אוטומטי", "Auto")} (${auto})`} ▾
      </button>
      {open && (
        <span className="assign-list assign-models" role="group" aria-label={L("מודל ב-Antigravity", "Model in Antigravity")}>
          <button type="button" className={`chip-text${!model.pick ? " on" : ""}`} aria-pressed={!model.pick} disabled={busy} onClick={() => void pick("")}>
            {L("אוטומטי", "Auto")} <span className="muted">({auto})</span>
          </button>
          {model.list.map((m) => (
            <button type="button" key={m.id} className={`chip-text${model.pick === m.name ? " on" : ""}`} aria-pressed={model.pick === m.name} disabled={busy} onClick={() => void pick(m.name)} dir="ltr">
              {m.name}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
