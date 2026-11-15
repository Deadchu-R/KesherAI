import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Lora {
  versionId: number;
  name: string;
  version: string;
  creator?: string;
  baseModel?: string;
  triggers: string[];
  fileName: string;
  sizeBytes: number;
  image?: string;
  downloads?: number;
}

const BASES = ["", "SDXL 1.0", "Pony", "Illustrious", "Flux.1 D", "SD 1.5", "Qwen", "Wan Video"];

/**
 * LoRAs from CivitAI (audit F5): search, see the preview, base model and trigger words, and download into the LoRA
 * folder. Downloaded LoRAs keep their trigger words, which are added to the prompt when the LoRA is chosen.
 *
 * @param props.onDownloaded - Called when a download started (the list of LoRAs here refreshes when it is done).
 */
export function CivitaiLoras({ onDownloaded }: { onDownloaded: () => void }) {
  const [q, setQ] = useState("");
  const [base, setBase] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [list, setList] = useState<Lora[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<number[]>([]);
  const search = async () => {
    setBusy(true);
    try {
      const p = new URLSearchParams({ q, ...(base ? { base } : {}), ...(nsfw ? { nsfw: "1" } : {}) });
      setList((await api<{ loras: Lora[] }>(`/api/civitai/loras?${p}`)).loras);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void search();
  }, []);
  const download = async (l: Lora) => {
    try {
      await api("/api/civitai/download", { method: "POST", body: { versionId: l.versionId } });
      setStarted((s) => [...s, l.versionId]);
      toast(L(`מוריד את ${l.name}. הוא יופיע ברשימת ה־LoRA כשיסתיים.`, `Downloading ${l.name}. It shows in the LoRA list when done.`));
      onDownloaded();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
  return (
    <section className="card stack civitai">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="grow" type="search" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש LoRA ב־CivitAI (סגנון, דמות, אפקט)", "Search CivitAI LoRAs (style, character, effect)")} aria-label={L("חיפוש LoRA", "Search LoRAs")} />
        <select value={base} onChange={(e) => setBase(e.target.value)} aria-label={L("מודל בסיס", "Base model")}>
          {BASES.map((b) => <option key={b} value={b}>{b || L("כל מודל בסיס", "Any base model")}</option>)}
        </select>
        <button type="submit" className="primary" disabled={busy}>{busy ? "…" : L("חפש", "Search")}</button>
      </form>
      <label className="row small check-row"><input type="checkbox" checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} /><span className="grow">{L("כולל תוכן למבוגרים (התמונות שלו לא מוצגות)", "Include adult content (its pictures are not shown)")}</span></label>
      {list && list.length === 0 && <p className="muted">{L("לא נמצא כלום. נסה מילים אחרות או מודל בסיס אחר.", "Nothing found. Try other words or another base model.")}</p>}
      <div className="civitai-grid">
        {list?.map((l) => (
          <article key={l.versionId} className="civitai-card">
            {l.image ? <img src={withToken(`/api/civitai/image?url=${encodeURIComponent(l.image)}`)} alt="" loading="lazy" /> : <div className="civitai-noimg" aria-hidden="true">🎨</div>}
            <div className="stack" style={{ gap: 4 }}>
              <b dir="auto">{l.name}</b>
              <span className="muted small" dir="auto">{[l.baseModel, l.version, mb(l.sizeBytes), l.downloads !== undefined ? `⬇ ${l.downloads.toLocaleString()}` : ""].filter(Boolean).join(" · ")}</span>
              {l.triggers.length > 0 && <span className="small" dir="auto">{L("מילות הפעלה: ", "Trigger words: ")}<code dir="ltr">{l.triggers.slice(0, 4).join(", ")}</code></span>}
              <button type="button" disabled={started.includes(l.versionId)} onClick={() => void download(l)}>{started.includes(l.versionId) ? L("מוריד…", "Downloading…") : L("הורד", "Download")}</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
