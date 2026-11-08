import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";

interface Reading { index: number; name: string; temp: number; util: number; memUsed: number; memTotal: number; power?: number; powerLimit?: number }
interface GuardConfig { enabled: boolean; maxTemp: number; resumeTemp: number; unloadAfterMinutes: number; gentle: boolean }
/** What `/api/guard` answers. */
export interface GuardStatus {
  config: GuardConfig;
  cards: Reading[];
  paused: boolean;
  cooling: boolean;
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

      <div className="row">
        {g.paused ? (
          <button type="button" className="primary" onClick={() => void run("/api/guard/pause", { on: false })}>▶ {t("guardResume")}</button>
        ) : (
          <button type="button" onClick={() => void run("/api/guard/pause", { on: true })}>⏸ {t("guardPause")}</button>
        )}
        <button type="button" disabled={g.running > 0} onClick={() => void run("/api/guard/free")}>{t("guardFree")}</button>
        <span className="muted small">
          {g.cooling ? `🌡 ${t("guardCooling", { temp: c.resumeTemp })}` : g.paused ? t("guardPausedNote") : g.running ? t("guardRunning", { n: g.running }) : ""}
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
        <label className="field">
          <span>{t("guardUnload")}</span>
          <select value={c.unloadAfterMinutes} onChange={(e) => set({ unloadAfterMinutes: Number(e.target.value) })}>
            {[0, 5, 10, 20, 30, 60, 120].map((m) => <option key={m} value={m}>{m ? t("guardMinutes", { n: m }) : t("guardNever")}</option>)}
          </select>
        </label>
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
  if (!g || !g.config.enabled || (!g.paused && !g.cooling)) return null;
  return (
    <p className="guard-banner row">
      <span className="grow">{g.cooling ? `🌡 ${t("guardCooling", { temp: g.config.resumeTemp })}` : `⏸ ${t("guardPausedNote")}`}{g.waiting ? ` · ${t("guardWaiting", { n: g.waiting })}` : ""}</span>
      {g.paused && <button type="button" className="primary" onClick={() => void api<GuardStatus>("/api/guard/pause", { method: "POST", body: { on: false } }).then(setG)}>▶ {t("guardResume")}</button>}
    </p>
  );
}
