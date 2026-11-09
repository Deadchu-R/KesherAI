import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Phone { id: string; brand: string; name: string; soc: string; gpu: string; android: number; screen: { w: number; h: number; hz: number }; tier: "high" | "mid" | "low"; detected?: boolean }
interface View { catalog: Phone[]; custom: Phone[]; targets: string[]; brief?: string }

const TIER: Record<Phone["tier"], [string, string]> = { high: ["חזק", "flagship"], mid: ["בינוני", "mid-range"], low: ["חלש", "budget"] };

/**
 * Target phones: tick the phones a game or site is for. Unity and Unreal
 * chats get a short brief (the weakest phone, screens, refresh rates, GPU
 * families) and Unity Android builds ask for the right frame rate.
 */
export function PhoneTargetsSection() {
  const [v, setV] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void api<View>("/api/phones").then(setV, () => undefined);
  }, []);
  if (!v) return null;
  const save = (targets: string[]) => void api<View>("/api/phones/targets", { method: "PUT", body: { targets } }).then(setV, (e: Error) => setMsg(e.message));
  const toggle = (id: string, on: boolean) => save(on ? [...v.targets, id] : v.targets.filter((t) => t !== id));
  const detect = () => {
    setBusy(true);
    setMsg("");
    void api<View & { detected: Phone }>("/api/phones/detect", { method: "POST" })
      .then((r) => {
        setV(r);
        setMsg(L(`נוסף: ${r.detected.name}`, `Added: ${r.detected.name}`));
      }, (e: Error) => setMsg(e.message))
      .finally(() => setBusy(false));
  };
  const brands = [...new Set(v.catalog.map((p) => p.brand))];
  const row = (p: Phone) => (
    <label key={p.id} className="check">
      <input type="checkbox" checked={v.targets.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
      <span dir="auto">
        {p.name} <span className="muted small">· {p.gpu} · {p.screen.w}×{p.screen.h} {p.screen.hz}Hz · Android {p.android} · {L(...TIER[p.tier])}{p.detected ? ` · ${L("נקרא מהטלפון", "read from the phone")}` : ""}</span>
      </span>
      {p.detected && <button type="button" className="icon-btn" aria-label={L("הסר", "Remove")} onClick={() => void api<View>(`/api/phones/custom/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(setV)}>✕</button>}
    </label>
  );
  return (
    <section className="card stack">
      <h2>{L("טלפוני יעד לבילדים", "Target phones for builds")}</h2>
      <p className="muted">{L("סמנו את הטלפונים שהמשחק או האתר מיועדים להם. צ'אטים של Unity ו-Unreal יבנו ויבדקו לפיהם (הטלפון החלש, מסכים, קצב רענון, סוגי GPU), ובילד Android של Unity יבקש את קצב הפריימים המתאים.", "Tick the phones a game or site is for. Unity and Unreal chats build and test for them (the weakest phone, screens, refresh rates, GPU types), and Unity Android builds ask for the right frame rate.")}</p>
      <div className="row">
        <button type="button" onClick={detect} disabled={busy}>{busy ? L("קורא…", "Reading…") : L("📱 הוסף את הטלפון שמחובר למחשב ב-USB", "📱 Add the phone connected to the computer by USB")}</button>
        {msg && <span className="muted small" dir="auto">{msg}</span>}
      </div>
      {v.custom.length > 0 && <div className="stack">{v.custom.map(row)}</div>}
      {brands.map((b) => (
        <details key={b} open={v.catalog.some((p) => p.brand === b && v.targets.includes(p.id))}>
          <summary>{b} <span className="muted small">({v.catalog.filter((p) => p.brand === b && v.targets.includes(p.id)).length}/{v.catalog.filter((p) => p.brand === b).length})</span></summary>
          <div className="stack">{v.catalog.filter((p) => p.brand === b).map(row)}</div>
        </details>
      ))}
      <p className="muted small">{L("הערכים ברשימה הם של הדגם הנפוץ; טלפון שנקרא ב-USB מדויק.", "Catalog values are the usual model; a phone read over USB is exact.")}</p>
      {v.brief && <details><summary className="small">{L("מה המודל מקבל", "What the model gets")}</summary><p className="small" dir="ltr">{v.brief}</p></details>}
    </section>
  );
}
