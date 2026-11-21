import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, t, he$ } from "./i18n";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Reading { index: number; name: string; temp: number; util: number; memUsed: number; memTotal: number; power?: number; powerLimit?: number }
interface GuardConfig { enabled: boolean; maxTemp: number; resumeTemp: number; unloadAfterMinutes: number; idleEmbeddings?: number; idleComfy?: number; idleTranslator?: number; gentle: boolean; maxRamPercent?: number; maxCpuPercent?: number; maxCpuTemp?: number }
/** What `/api/guard` answers. */
export interface GuardStatus {
  config: GuardConfig;
  cards: Reading[];
  paused: boolean;
  cooling: boolean;
  system?: { ramUsed: number; ramTotal: number; cpu: number; cpuTemp?: number };
  systemHold?: string;
  waiting: number;
  running: number;
  lastUnload?: { what: string; at: string };
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
const short = (name: string) => name.replace(/^NVIDIA (GeForce )?/i, "");

/**
 * Polls the guard while mounted.
 *
 * @param ms - How often.
 * @returns The latest status (null until the first answer) and a setter.
 */
function useGuard(ms: number): [GuardStatus | null, (g: GuardStatus) => void] {
  const [g, setG] = useState<GuardStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void api<GuardStatus>("/api/guard").then((x) => alive && setG(x), () => undefined);
    load();
    const timer = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ms]);
  return [g, setG];
}

/** A bar for one card's temperature, colored by how close it is to the limit. */
function TempBar({ temp, max }: { temp: number; max: number }) {
  const level = temp >= max ? "bad" : temp >= max - 8 ? "warn" : "good";
  return (
    <span className={`guard-temp ${level}`} title={`${temp} °C`}>
      <span style={{ width: `${Math.min(100, (temp / 100) * 100)}%` }} />
    </span>
  );
}

/** Settings → Protect the graphics card: live readings, pause / resume, limits. */
export function GuardSection() {
  const [g, setG] = useGuard(4000);
  const [error, setError] = useState("");
  if (!g) return null;
  const c = g.config;
  const run = async (path: string, body?: unknown, method = "POST") => {
    setError("");
    try {
      setG(await api<GuardStatus>(path, { method, ...(body ? { body } : {}) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const set = (patch: Partial<GuardConfig>) => void run("/api/guard", patch, "PUT");

  return (
    <section className="card stack guard">
      <div className="row">
        <h2 className="grow">{t("guardTitle")}</h2>
        <label className="row small"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {t("guardOn")}</label>
      </div>
      <p className="muted small">{t("guardIntro")}</p>

      {g.cards.length > 0 ? (
        <ul className="guard-cards">
          {g.cards.map((card) => (
            <li key={card.index}>
              <strong>{short(card.name)}</strong>
              <span className="row small">
                <TempBar temp={card.temp} max={c.maxTemp} /> <b>{card.temp}°C</b>
                <span className="muted">{t("guardUse", { n: card.util })}</span>
                <span className="muted">{gb(card.memUsed)} / {gb(card.memTotal)} GB</span>
                {card.power !== undefined && <span className="muted">{Math.round(card.power)}{card.powerLimit ? ` / ${Math.round(card.powerLimit)}` : ""} W</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t("guardNoCards")}</p>
      )}

      {g.system && (
        <ul className="guard-cards">
          <li>
            <strong>{L("המחשב", "This computer")}</strong>
            <span className="row small">
              <span>{L("זיכרון", "Memory")} <b>{gb(g.system.ramUsed)} / {gb(g.system.ramTotal)} GB</b> ({Math.round((g.system.ramUsed / Math.max(1, g.system.ramTotal)) * 100)}%)</span>
              <span>{L("מעבד", "Processor")} <b>{g.system.cpu}%</b></span>
              {g.system.cpuTemp !== undefined ? <span><TempBar temp={g.system.cpuTemp} max={c.maxCpuTemp || 95} /> <b>{g.system.cpuTemp}°C</b></span> : c.maxCpuTemp ? <span className="muted">{L("Windows לא מוסר את טמפרטורת המעבד במחשב הזה", "This computer does not report the processor's temperature")}</span> : null}
            </span>
          </li>
        </ul>
      )}

      <div className="row">
        {g.paused ? (
          <button type="button" className="primary" onClick={() => void run("/api/guard/pause", { on: false })}>▶ {t("guardResume")}</button>
        ) : (
          <button type="button" onClick={() => void run("/api/guard/pause", { on: true })}>⏸ {t("guardPause")}</button>
        )}
        <button type="button" disabled={g.running > 0} onClick={() => void run("/api/guard/free")}>{t("guardFree")}</button>
        <span className="muted small">
          {g.cooling ? `🌡 ${t("guardCooling", { temp: c.resumeTemp })}` : g.systemHold ? `⏳ ${L("עבודה חדשה ממתינה", "New work waits")}: ${g.systemHold}` : g.paused ? t("guardPausedNote") : g.running ? t("guardRunning", { n: g.running }) : ""}
          {g.waiting ? ` · ${t("guardWaiting", { n: g.waiting })}` : ""}
        </span>
      </div>

      <div className="guard-limits">
        <label className="field">
          <span>{t("guardMax", { temp: c.maxTemp })}</span>
          <input type="range" min={65} max={92} value={c.maxTemp} onChange={(e) => set({ maxTemp: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t("guardResumeAt", { temp: c.resumeTemp })}</span>
          <input type="range" min={55} max={c.maxTemp - 3} value={c.resumeTemp} onChange={(e) => set({ resumeTemp: Number(e.target.value) })} />
        </label>
        <fieldset className="guard-on-demand stack">
          <legend>{L("טעינה לפי צורך", "Load on demand")}</legend>
          <p className="muted small">{L("שום דבר כבד לא נטען כשהאפליקציה עולה. כל מנוע נטען כשמשהו צריך אותו, ויורד מהזיכרון אחרי זמן בלי שימוש. אף פעם לא באמצע עבודה. \"להשאיר טעון\" למי שרוצה מהירות.", "Nothing heavy loads when the app starts. Each engine loads when something needs it and leaves memory after an idle time, never in the middle of work. \"Keep loaded\" if you want speed.")}</p>
          {([
            ["unloadAfterMinutes", L("מודל הצ'אט", "Chat model"), 10],
            ["idleEmbeddings", L("חיפוש לפי משמעות", "Search by meaning"), 5],
            ["idleComfy", L("ComfyUI (תמונות, וידאו, מוזיקה)", "ComfyUI (pictures, video, music)"), 5],
            ["idleTranslator", L("מודל התרגום", "Translation model"), 5],
          ] as const).map(([key, label, def]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <Select value={c[key] ?? def} onChange={(e) => set({ [key]: Number(e.target.value) })}>
                {[...new Set([1, 2, 5, 10, 20, 30, 60, 120, c[key] ?? def])].filter((m) => m > 0).sort((a, b) => a - b).map((m) => <option key={m} value={m}>{L(`לפרוק אחרי ${m} דק'`, `Unload after ${m} min`)}</option>)}
                <option value={0}>{L("להשאיר טעון", "Keep loaded")}</option>
              </Select>
            </label>
          ))}
          <p className="muted small">{L("מנוע התמונות המובנה (sd.cpp) רץ רק בזמן יצירת תמונה ונסגר מיד אחריה.", "The built-in image engine (sd.cpp) runs only while it makes a picture and closes right after.")}</p>
        </fieldset>
        {!c.maxRamPercent && !c.maxCpuPercent && (
          <div className="row wrap guard-suggest">
            <span className="small grow">{L("הצעה: אם משחקים או עובדים ב-Unreal בזמן ש-KesherAI עובד, להגביל לזיכרון עד 85% ומעבד עד 80%, כדי שהמחשב יישאר מהיר.", "Suggestion: if you game or work in Unreal while KesherAI works, limit memory to 85% and the processor to 80%, so the computer stays quick.")}</span>
            <button type="button" className="small" onClick={() => set({ maxRamPercent: 85, maxCpuPercent: 80 })}>{L("להפעיל את ההצעה", "Use the suggestion")}</button>
          </div>
        )}
        <label className="field">
          <span>{L("הגבלת זיכרון (RAM)", "Memory (RAM) limit")}</span>
          <Select value={c.maxRamPercent ?? 0} onChange={(e) => set({ maxRamPercent: Number(e.target.value) })}>
            {[0, 70, 80, 85, 90, 95].map((n) => <option key={n} value={n}>{n ? L(`עד ${n}%`, `Up to ${n}%`) : L("בלי הגבלה", "No limit")}</option>)}
          </Select>
        </label>
        <label className="field">
          <span>{L("הגבלת מעבד", "Processor limit")}</span>
          <Select value={c.maxCpuPercent ?? 0} onChange={(e) => set({ maxCpuPercent: Number(e.target.value) })}>
            {[0, 50, 60, 70, 80, 90].map((n) => <option key={n} value={n}>{n ? L(`עד ${n}%`, `Up to ${n}%`) : L("בלי הגבלה", "No limit")}</option>)}
          </Select>
        </label>
        <label className="field">
          <span>{L("טמפרטורת מעבד מקסימלית", "Highest processor temperature")}</span>
          <Select value={c.maxCpuTemp ?? 0} onChange={(e) => set({ maxCpuTemp: Number(e.target.value) })}>
            {[0, 70, 75, 80, 85, 90, 95].map((n) => <option key={n} value={n}>{n ? `${n}°C` : L("בלי הגבלה", "No limit")}</option>)}
          </Select>
        </label>
        <p className="muted small">{L("כשעוברים גבול, עבודה מקומית חדשה ממתינה (מה שכבר רץ מסתיים), וכשהזיכרון מלא מודלים לא בשימוש נפרקים. חלוקת עבודה בין המחשבים מדלגת על מחשב חם או עמוס ובוחרת לכל מחשב מודל שמתאים לחומרה שלו.", "Past a limit, new local work waits (what runs finishes), and when memory is full idle models are unloaded. Splitting work across your computers skips a hot or busy one and gives each computer a model that fits its hardware.")}</p>
        <label className="row">
          <input type="checkbox" checked={c.gentle} onChange={(e) => set({ gentle: e.target.checked })} />
          <span>{t("guardGentle")}</span>
        </label>
      </div>
      {g.lastUnload && <p className="muted small">{t("guardUnloaded", { what: g.lastUnload.what, time: new Date(g.lastUnload.at).toLocaleTimeString() })}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** A bar across the app while local work is held (paused, or a card is cooling), with Resume. */
export function GuardBanner() {
  const [g, setG] = useGuard(8000);
  if (!g || !g.config.enabled || (!g.paused && !g.cooling && !g.systemHold)) return null;
  return (
    <p className="guard-banner row">
      <span className="grow">{g.cooling ? `🌡 ${t("guardCooling", { temp: g.config.resumeTemp })}` : g.systemHold ? `⏳ ${L("עבודה חדשה ממתינה", "New work waits")}: ${g.systemHold}` : `⏸ ${t("guardPausedNote")}`}{g.waiting ? ` · ${t("guardWaiting", { n: g.waiting })}` : ""}</span>
      {g.paused && <button type="button" className="primary" onClick={() => void api<GuardStatus>("/api/guard/pause", { method: "POST", body: { on: false } }).then(setG)}>▶ {t("guardResume")}</button>}
    </p>
  );
}
