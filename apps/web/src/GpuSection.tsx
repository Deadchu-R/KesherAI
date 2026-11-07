import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";

interface GpuInfo {
  index: number;
  name: string;
  vramTotal: number;
  vramFree: number;
  computeCap?: number;
  fastest: boolean;
}
interface Prefs {
  mode: "auto" | "fastest" | "all";
  use?: number[];
  split?: number[];
  main?: number;
}
interface Report {
  gpus: GpuInfo[];
  prefs: Prefs;
  examples: Array<{ modelGb: number; leader: number | null; parts: Array<{ index: number; share: number }> }>;
  current: string | null;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(0)} GB`;
const short = (name: string) => name.replace(/^NVIDIA (GeForce )?/i, "");

/** Settings → Graphics cards: which cards models use, how a model is split across two, and which card leads. */
export function GpuSection() {
  const [r, setR] = useState<Report | null>(null);
  const load = () => api<Report>("/api/engines/gpus").then(setR, () => undefined);
  useEffect(() => {
    void load();
  }, []);
  if (!r || r.gpus.length === 0) {
    return (
      <section className="card stack">
        <h2>{t("gpuTitle")}</h2>
        <p className="muted">{r ? t("gpuNone") : t("barChecking")}</p>
      </section>
    );
  }
  const set = async (body: Record<string, unknown>) => {
    await api("/api/engines/gpus", { method: "PUT", body });
    await load();
  };
  const nameOf = (i: number) => r.gpus.find((g) => g.index === i)?.name ?? `#${i}`;
  const used = r.gpus.filter((g) => !r.prefs.use || r.prefs.use.includes(g.index));
  const shares = r.prefs.split && r.prefs.split.length === used.length ? r.prefs.split : used.map((g) => Math.round(g.vramFree / 1024 ** 3));
  const total = shares.reduce((a, b) => a + b, 0) || 1;

  return (
    <section className="card stack gpus">
      <h2>{t("gpuTitle")}</h2>
      <p className="muted small">{t("gpuIntro")}</p>
      <ul className="gpu-list">
        {r.gpus.map((g) => {
          const on = !r.prefs.use || r.prefs.use.includes(g.index);
          return (
            <li key={g.index} className={on ? "" : "off"}>
              <label className="gpu-use">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && used.length === 1}
                  onChange={(e) => {
                    const next = e.target.checked ? [...(r.prefs.use ?? []), g.index] : used.map((x) => x.index).filter((i) => i !== g.index);
                    void set({ use: next.length === r.gpus.length ? null : next, split: null });
                  }}
                />
                <span>
                  <strong dir="ltr">{g.name.replace(/^NVIDIA (GeForce )?/i, "")}</strong>
                  <span className="muted small" dir="ltr"> #{g.index} · {gb(g.vramTotal)} · {t("gpuFree", { gb: gb(g.vramFree) })}{g.computeCap ? ` · CUDA ${g.computeCap}` : ""}</span>
                </span>
              </label>
              {g.fastest && <span className="pill good">{t("gpuFastest")}</span>}
              {r.gpus.length > 1 && on && (
                <label className="gpu-lead small">
                  <input type="radio" name="gpu-main" checked={(r.prefs.main ?? r.gpus.find((x) => x.fastest)?.index) === g.index} onChange={() => void set({ main: g.fastest ? null : g.index })} />
                  {t("gpuLeads")}
                </label>
              )}
            </li>
          );
        })}
      </ul>

      {used.length > 1 && (
        <>
          <label className="stack">
            <span>{t("gpuMode")}</span>
            <select value={r.prefs.mode} onChange={(e) => void set({ mode: e.target.value })}>
              <option value="auto">{t("gpuModeAuto")}</option>
              <option value="all">{t("gpuModeAll")}</option>
              <option value="fastest">{t("gpuModeFastest")}</option>
            </select>
          </label>
          {r.prefs.mode !== "fastest" && (
            <div className="stack">
              <span>{t("gpuSplit")}</span>
              <div className="gpu-split" aria-hidden>
                {used.map((g, i) => (
                  <span key={g.index} style={{ flexGrow: shares[i] }}>{Math.round(((shares[i] ?? 0) / total) * 100)}%</span>
                ))}
              </div>
              {used.map((g, i) => (
                <label key={g.index} className="row small">
                  <span className="gpu-split-name" dir="ltr">{g.name.replace(/^NVIDIA (GeForce )?/i, "")}</span>
                  <input type="range" dir="ltr" min={1} max={64} value={shares[i]} onChange={(e) => { const next = [...shares]; next[i] = Number(e.target.value); void set({ split: next }); }} aria-label={t("gpuShareOf", { name: g.name })} />
                </label>
              ))}
              {r.prefs.split && <button type="button" className="link-btn" onClick={() => void set({ split: null })}>{t("gpuSplitReset")}</button>}
            </div>
          )}
        </>
      )}
      <div className="gpu-examples">
        <span className="muted small">{t("gpuWhatHappens")}</span>
        <ul>
          {r.examples.map((e) => (
            <li key={e.modelGb} className="small">
              {t("gpuExample", { gb: e.modelGb })}{" "}
              <span className="muted">
                {e.parts.length === 1
                  ? t("gpuOnly", { name: short(nameOf(e.parts[0]!.index)) })
                  : t("gpuSplitInto", { parts: e.parts.map((x) => `${short(nameOf(x.index))} ${x.share}%`).join(" + "), lead: short(nameOf(e.leader ?? -1)) })}
              </span>
            </li>
          ))}
        </ul>
        {r.current && <p className="small">{t("gpuNow")} <span className="muted" dir="ltr">{r.current}</span></p>}
      </div>
      <p className="muted small">{t("gpuNote")}</p>
    </section>
  );
}
