import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$, t } from "./i18n";
import { Select } from "./ui/Select";

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
  comfyGpu?: number | null;
}

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

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
            <Select value={r.prefs.mode} onChange={(e) => void set({ mode: e.target.value })}>
              <option value="auto">{t("gpuModeAuto")}</option>
              <option value="all">{t("gpuModeAll")}</option>
              <option value="fastest">{t("gpuModeFastest")}</option>
            </Select>
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
      {r.gpus.length > 1 && <WorkSplit r={r} reload={load} />}
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

/**
 * Two cards: everything together (a big model split across both), or the chat on one card and ComfyUI (pictures) on
 * the other, so the chat answers while a picture is made.
 */
function WorkSplit({ r, reload }: { r: Report; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const cards = r.gpus.slice(0, 2);
  const split = r.comfyGpu != null && r.prefs.use?.length === 1 ? { chat: r.prefs.use[0]!, comfy: r.comfyGpu } : null;
  const pairs: Array<[GpuInfo, GpuInfo]> = cards.length === 2 ? [[cards[0]!, cards[1]!], [cards[1]!, cards[0]!]] : [];
  const choose = async (body: { chat: number | null; comfy: number | null }) => {
    setBusy(true);
    try {
      await api("/api/engines/gpu-split", { method: "PUT", body });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" role="radiogroup" aria-label={L("איך לחלק את העבודה", "How to split the work")}>
      <span>{L("איך לחלק את העבודה", "How to split the work")}</span>
      <label className={`split-opt${split ? "" : " on"}`}>
        <input type="radio" name="gpu-work" checked={!split} disabled={busy} onChange={() => void choose({ chat: null, comfy: null })} />
        <span>{L("הכול יחד: מודל גדול מתחלק על שני הכרטיסים", "Everything together: a big model splits across both cards")}</span>
      </label>
      {pairs.map(([a, b]) => {
        const on = split?.chat === a.index && split?.comfy === b.index;
        return (
          <label key={`${a.index}-${b.index}`} className={`split-opt${on ? " on" : ""}`}>
            <input type="radio" name="gpu-work" checked={on} disabled={busy} onChange={() => void choose({ chat: a.index, comfy: b.index })} />
            <span>{L("צ׳אט על ", "Chat on ")}<b dir="ltr">{short(a.name)}</b>{L(", ‏ComfyUI ותמונות על ", ", ComfyUI and pictures on ")}<b dir="ltr">{short(b.name)}</b></span>
          </label>
        );
      })}
      <p className="muted small">{L("כך הצ׳אט עונה בזמן שתמונה נוצרת, בלי לחכות. ComfyUI מופעל מחדש על הכרטיס שנבחר; מודל הצ׳אט עובר בטעינה הבאה.", "The chat then answers while a picture is made. ComfyUI restarts on its card; the chat model moves at its next load.")}</p>
    </div>
  );
}
