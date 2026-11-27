import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Role = "chat" | "watchdog" | "translator" | "embeddings";

/** What GET /api/cpu-pool answers (routes/cpu-pool.ts). */
interface PoolView {
  available: boolean;
  engine?: "router" | "instances";
  pinnable?: boolean;
  settings: { enabled: boolean; maxGenerating: number; ramBudgetMb: number; idleWatchdog: number; idleChat: number; pinCcd: boolean; translatorDevice: "cpu" | "gpu" | "auto" };
  roles?: Array<{ role: Role; model?: string; state: "unloaded" | "loading" | "loaded" | "running"; threads?: number; ramMb?: number; tps?: number; queued: number }>;
  running?: number;
  maxGenerating?: number;
  ramUsedMb?: number;
  ramBudgetMb?: number;
  threadsBudget?: number;
  playing?: boolean;
}

/** Each role's name on the card. */
const ROLE_NAME: Record<Role, () => string> = {
  chat: () => L("צ'אט משימות (בקרוב)", "Task chat (later)"),
  watchdog: () => L("שומר הריצה", "Run watchdog"),
  translator: () => L("מתרגם", "Translator"),
  embeddings: () => L("חיפוש לפי משמעות", "Search by meaning"),
};

const STATE: Record<string, () => string> = {
  unloaded: () => L("לא טעון", "Not loaded"),
  loading: () => L("נטען…", "Loading…"),
  loaded: () => L("טעון", "Loaded"),
  running: () => L("עונה", "Answering"),
};

const mb = (n: number) => (n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} GB` : `${n} MB`);

/**
 * PC Health → "CPU models": the small models on the processor (the watchdog, the translator, embeddings) that share
 * one pool (cpu-pool.ts): each one's model, loaded or not, its last speed, memory and queue; and the pool's settings
 * (how many answer at once, where the translator runs, the X3D pinning). Works from the phone too.
 */
export function CpuModelsCard() {
  const [v, setV] = useState<PoolView | null>(null);
  const load = () => void api<PoolView>("/api/cpu-pool").then(setV, () => undefined);
  useEffect(() => {
    load();
    // Live while the page is open: loads, speeds and queues change as jobs run.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const put = (body: Partial<PoolView["settings"]>) => void api<PoolView>("/api/cpu-pool", { method: "PUT", body }).then(setV, (e: Error) => toast(e.message));
  const unload = (role: Role) => void api<PoolView>("/api/cpu-pool/unload", { method: "POST", body: { role } }).then(setV, (e: Error) => toast(e.message));
  if (!v?.available) return null;
  const s = v.settings;
  const roles = (v.roles ?? []).filter((r) => r.model || r.role !== "chat");
  return (
    <section className="card stack cpu-models">
      <div className="row wrap">
        <h2 className="grow">{L("מודלים על המעבד", "CPU models")}</h2>
        <span className="muted small" dir="auto">
          {L(`⁦${v.running ?? 0}/${v.maxGenerating ?? s.maxGenerating}⁩ עונים · זיכרון ⁦${mb(v.ramUsedMb ?? 0)} / ${mb(v.ramBudgetMb ?? 0)}⁩`, `${v.running ?? 0}/${v.maxGenerating ?? s.maxGenerating} answering · memory ${mb(v.ramUsedMb ?? 0)} / ${mb(v.ramBudgetMb ?? 0)}`)}
        </span>
      </div>
      {v.playing && <p className="small" role="status">{L("משחק רץ: עבודות הרקע ממתינות עד שייסגר.", "A game is running: background work waits until it closes.")}</p>}
      {!s.enabled && <p className="small muted">{L("כבוי: כל מודל קטן רץ בנפרד כמו קודם.", "Off: each small model runs on its own, as before.")}</p>}
      <ul className="cpu-roles">
        {roles.map((r) => (
          <li key={r.role} className={`cpu-role ${r.state}`}>
            <span className="cpu-dot" aria-hidden="true" />
            <div className="stack grow">
              <strong>{ROLE_NAME[r.role]()}</strong>
              <span className="muted small" dir="ltr">{r.model ?? L("אין מודל במחשב", "No model on this computer")}</span>
            </div>
            <div className="stack cpu-nums small">
              <span>{STATE[r.state]!()}{r.queued ? L(` · ⁦${r.queued}⁩ ממתינים`, ` · ${r.queued} waiting`) : ""}</span>
              <span className="muted" dir="ltr">{[r.tps !== undefined ? `${r.tps} tok/s` : "", r.ramMb ? mb(r.ramMb) : "", r.threads ? `${r.threads} ${L("ליבות", "threads")}` : ""].filter(Boolean).join(" · ")}</span>
            </div>
            {r.state === "loaded" && <button type="button" className="small" onClick={() => unload(r.role)} aria-label={L(`פרוק את ${ROLE_NAME[r.role]()}`, `Unload ${ROLE_NAME[r.role]()}`)}>{L("פרוק", "Unload")}</button>}
          </li>
        ))}
      </ul>
      <details>
        <summary>{L("הגדרות", "Settings")}</summary>
        <div className="stack cpu-settings">
          <label className="row"><input type="checkbox" checked={s.enabled} onChange={(e) => put({ enabled: e.target.checked })} /> <span className="grow">{L("מאגר אחד לכל המודלים הקטנים", "One pool for all small models")}</span></label>
          <div className="stack">
            <span className="small">{L("המתרגם רץ על", "The translator runs on")}</span>
            <div className="seg-pills" role="radiogroup" aria-label={L("המתרגם רץ על", "The translator runs on")}>
              {([["cpu", L("המעבד", "Processor")], ["gpu", L("כרטיס המסך", "Graphics card")], ["auto", L("אוטומטי", "Automatic")]] as const).map(([k, text]) => (
                <button key={k} type="button" role="radio" aria-checked={s.translatorDevice === k} className={s.translatorDevice === k ? "on" : ""} onClick={() => put({ translatorDevice: k })}>{text}</button>
              ))}
            </div>
          </div>
          <div className="stack">
            <span className="small">{L("כמה עונים בבת אחת", "How many answer at once")}</span>
            <div className="seg-pills" role="radiogroup" aria-label={L("כמה עונים בבת אחת", "How many answer at once")}>
              {[1, 2, 3, 4].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={s.maxGenerating === n} className={s.maxGenerating === n ? "on" : ""} onClick={() => put({ maxGenerating: n })}>{n}</button>
              ))}
            </div>
          </div>
          <label className="row small">
            <span className="grow">{L("פריקת שומר הריצה אחרי (דקות)", "Unload the watchdog after (minutes)")}</span>
            <input type="number" min={0} max={1440} style={{ width: 72 }} defaultValue={s.idleWatchdog} onBlur={(e) => put({ idleWatchdog: Number(e.target.value) })} />
          </label>
          <label className="row small">
            <span className="grow">{L("תקציב זיכרון (MB, 0 = רבע מהזיכרון)", "Memory budget (MB, 0 = a quarter of RAM)")}</span>
            <input type="number" min={0} step={512} style={{ width: 88 }} defaultValue={s.ramBudgetMb} onBlur={(e) => put({ ramBudgetMb: Number(e.target.value) })} />
          </label>
          {v.pinnable && (
            <label className="row small"><input type="checkbox" checked={s.pinCcd} onChange={(e) => put({ pinCcd: e.target.checked })} /> <span className="grow">{L("רק על הליבות בלי המטמון הנוסף (X3D; כדאי למדוד קודם)", "Only on the cores without the extra cache (X3D; measure first)")}</span></label>
          )}
          <p className="muted small">{L(`עד ⁦${v.threadsBudget ?? 0}⁩ ליבות לכולם, בעדיפות נמוכה. צ'אט › שומר › מתרגם › חיפוש. מנוע: ${v.engine === "router" ? "llama.cpp במצב נתב" : "llama.cpp לכל מודל"}.`, `Up to ${v.threadsBudget ?? 0} threads for all, at low priority. Chat › watchdog › translator › search. Engine: ${v.engine === "router" ? "llama.cpp router mode" : "one llama.cpp per model"}.`)}</p>
        </div>
      </details>
    </section>
  );
}
