import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import "../control-card.css";
import "./vision-models.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One vision model, as GET /api/vision shows it (routes/vision.ts). */
interface VisionModelView {
  id: string;
  name: string;
  repo: string;
  sizeGb: number;
  approx: boolean;
  vramGb: number;
  license: string;
  source: string;
  installId: string;
  note: { en: string; he: string };
  installed: boolean;
  busy: boolean;
}

interface TaskResult { id: string; ok: boolean; ms: number; confidence?: number; error?: string }
interface ModelResult { model: string; name: string; right: number; of: number; medianMs: number; loadMs: number; tasks: TaskResult[]; error?: string }
interface Run { at: string; models: ModelResult[] }

interface VisionState {
  models: VisionModelView[];
  choice: "auto" | string;
  dir: string;
  loaded?: string;
  pane: boolean;
  bench: { running: boolean; done: number; of: number; model?: string; error?: string };
  runs: Run[];
}

/** The ten tasks' names on the screen (vision-bench.ts ids). */
const TASK_NAMES: Record<string, [string, string]> = {
  "web-save": ["כפתור שמירה כחול", "Blue Save button"],
  "web-search-icon": ["אייקון חיפוש", "Search icon"],
  "web-remember": ["תיבת \"זכור אותי\"", "\"Remember me\" box"],
  "web-next-arrow": ["חץ לתמונה הבאה", "Next photo arrow"],
  "web-cart-icon": ["אייקון עגלה", "Cart icon"],
  "notepad-file": ["פנקס: תפריט File", "Notepad: File menu"],
  "notepad-edit": ["פנקס: תפריט Edit", "Notepad: Edit menu"],
  "notepad-gear": ["פנקס: גלגל הגדרות", "Notepad: settings gear"],
  "notepad-zoom": ["פנקס: זום 100%", "Notepad: 100% zoom"],
  "notepad-plus": ["פנקס: לשונית חדשה", "Notepad: new tab"],
};

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} ${L("שנ׳", "s")}`;

/**
 * The local vision models for computer and browser control (Phase 6): which are installed (size, graphics memory,
 * where they are saved), Install, which one finds things, and "Test vision models" with the saved results. On the
 * Models screen (`compact`) it shows only the models. Works from the phone: installs and the test run on the computer.
 *
 * @param props.compact - Only the models and Install (the Models screen).
 */
export function VisionModelsSection({ compact = false }: { compact?: boolean }) {
  const [s, setS] = useState<VisionState | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => api<VisionState>("/api/vision").then(setS, () => undefined);
  useEffect(() => void load(), []);
  // While something downloads or the test runs: check every few seconds.
  const live = !!s && (s.bench.running || s.models.some((m) => m.busy));
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [live]);
  if (!s) return null;
  const install = (m: VisionModelView) =>
    void api(`/api/installables/${encodeURIComponent(m.installId)}/install`, { method: "POST", body: {} }).then(load, (e: Error) => setMsg(e.message));
  const choose = (model: string) => void api("/api/vision/choice", { method: "PUT", body: { model } }).then(load, (e: Error) => setMsg(e.message));
  const test = () => {
    setMsg("");
    void api("/api/vision/bench", { method: "POST" }).then(load, (e: Error) => setMsg(e.message));
  };
  const installed = s.models.filter((m) => m.installed);
  const last = s.runs.at(-1);
  return (
    <section className="card stack vision-models">
      <h2>{L("ראייה למחשב ולדפדפן", "Computer & browser vision")}</h2>
      <p className="muted small" dir="auto">
        {L(
          "מודל מקומי שמוצא דברים בצילום מסך לפי תיאור (\"כפתור השמירה הכחול\") כשאין להם שם בעץ הנגישות: משחקים, Unity, Unreal וקנבס. רץ בכרטיס המסך שלך, ליד מודל הצ'אט. כל לחיצה עדיין מבקשת אישור.",
          "A local model that finds things on a screenshot by description (\"the blue Save button\") when the accessibility tree has no name for them: games, Unity, Unreal, canvases. It runs on your graphics card beside the chat's model. Every click still asks you.",
        )}
      </p>
      <ul className="vm-list">
        {s.models.map((m) => (
          <li key={m.id} className="vm-item">
            <div className="vm-head">
              <b dir="ltr">{m.name}</b>
              {m.installed ? <span className="pill ok">{L("מותקן", "Installed")}</span> : m.busy ? <span className="pill">{L("מוריד…", "Downloading…")}</span> : null}
              {s.loaded === m.id && <span className="pill">{L("טעון עכשיו", "Loaded now")}</span>}
            </div>
            <p className="muted small" dir="auto">{getLocale() === "he" ? he$(m.note.he) : m.note.en}</p>
            <p className="muted small vm-facts">
              <span dir="ltr">{m.approx ? "~" : ""}{m.sizeGb} GB</span> · <span>{L(`כ־${m.vramGb} GB זיכרון גרפי`, `about ${m.vramGb} GB VRAM`)}</span> · <span dir="ltr">{m.license}</span> · <span dir="ltr">{m.source}</span>
            </p>
            {!m.installed && !m.busy && (
              <button type="button" className="primary small" onClick={() => install(m)}>
                {L(`התקנה (${m.sizeGb} GB)`, `Install (${m.sizeGb} GB)`)}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small vm-where" dir="auto">
        {L("נשמר ב־", "Saved in ")}<span className="mono" dir="ltr">{s.dir}</span>
      </p>
      {!compact && installed.length > 0 && (
        <>
          <h3>{L("מוצא דברים עם", "Find things with")}</h3>
          <div className="cs-radios" role="radiogroup">
            {[{ id: "auto", name: L("אוטומטי (הראשון שמותקן)", "Automatic (the first installed)") }, ...installed.map((m) => ({ id: m.id, name: m.name }))].map((c) => (
              <label key={c.id} className={`cs-radio${s.choice === c.id ? " on" : ""}`}>
                <input type="radio" name="vision-choice" checked={s.choice === c.id} onChange={() => choose(c.id)} />
                <span dir="auto"><b>{c.name}</b></span>
              </label>
            ))}
          </div>
        </>
      )}
      {!compact && (
        <div className="stack vm-bench">
          <h3>{L("בדיקת מודלי הראייה", "Vision model test")}</h3>
          <p className="muted small" dir="auto">
            {L(
              "10 משימות קבועות: 5 דפי אינטרנט ו־5 בחלון שנראה כמו פנקס הרשימות. כל מודל מותקן מחפש את המטרה; בודקים כמה הצליח וכמה זמן לקח. הדפים מצוירים בדפדפן של KesherAI, בלי ללחוץ על כלום.",
              "10 fixed tasks: 5 web pages and 5 on a Notepad-like window. Each installed model looks for the target; it counts how many it got right and how long each took. The pages are drawn in KesherAI's browser, nothing is clicked.",
            )}
          </p>
          <button type="button" className="primary" disabled={s.bench.running || !installed.length || !s.pane} onClick={test}>
            {s.bench.running ? L(`בודק… ${s.bench.done}/${s.bench.of}`, `Testing… ${s.bench.done}/${s.bench.of}`) : L("בדיקת מודלי הראייה", "Test vision models")}
          </button>
          {!installed.length && <p className="muted small">{L("התקינו מודל קודם.", "Install a model first.")}</p>}
          {installed.length > 0 && !s.pane && <p className="muted small" dir="auto">{L("הבדיקה מציירת דפים בדפדפן של KesherAI: פתחו את KesherAI במחשב.", "The test draws pages in KesherAI's browser: open KesherAI on the computer.")}</p>}
          {s.bench.error && <p className="error small" dir="auto">{s.bench.error}</p>}
          {last && (
            <div className="vm-results">
              <p className="muted small">{L("הבדיקה האחרונה: ", "Last test: ")}<span dir="ltr">{new Date(last.at).toLocaleString(getLocale() === "he" ? "he-IL" : "en-GB")}</span></p>
              {last.models.map((r) => (
                <details key={r.model} className="vm-result">
                  <summary>
                    <b dir="ltr">{r.name}</b>
                    {r.error ? (
                      <span className="error small" dir="auto"> {r.error}</span>
                    ) : (
                      <span className="vm-score">
                        <span className={r.right >= 8 ? "pill ok" : r.right >= 5 ? "pill" : "pill warn"}>{r.right}/{r.of}</span>
                        <span className="muted small">{L("חציון ", "median ")}{sec(r.medianMs)} · {L("טעינה ", "load ")}{sec(r.loadMs)}</span>
                      </span>
                    )}
                  </summary>
                  <ol className="vm-tasks small">
                    {r.tasks.map((t) => (
                      <li key={t.id} className={t.ok ? "ok" : "bad"}>
                        <span aria-hidden>{t.ok ? "✓" : "✗"}</span> <span dir="auto">{L(...(TASK_NAMES[t.id] ?? [t.id, t.id]))}</span>
                        {t.ms > 0 && <span className="muted"> · {sec(t.ms)}</span>}
                        {t.confidence !== undefined && <span className="muted"> · {Math.round(t.confidence * 100)}%</span>}
                        {t.error && <span className="muted" dir="auto"> · {t.error}</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
      {msg && <p className="error small" dir="auto">{msg}</p>}
    </section>
  );
}
