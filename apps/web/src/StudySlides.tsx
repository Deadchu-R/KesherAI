import { useRef, useState } from "react";
import type { StudySlide } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Base64 of a file, in pieces. */
async function base64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The lecture's slides beside its recording (design SlidesSync, students part 28 #1, like Genio and Notability): she
 * adds the PowerPoint or PDF; each slide shows with the minute it is talked about; a tap plays from there, and the
 * slide being heard is marked.
 */
export function StudySlides({ base, slides, heard, onSeek, onSlides, hasRecording }: { base: string; slides: StudySlide[]; heard?: number | undefined; onSeek: (sec: number) => void; onSlides: (s: StudySlide[] | undefined) => void; hasRecording: boolean }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = async (f: File) => {
    setBusy(true);
    try {
      const r = await api<{ slides: StudySlide[] }>(`${base}/slides`, { method: "POST", body: { name: f.name, data: await base64(f) } });
      onSlides(r.slides);
      const matched = r.slides.filter((s) => s.sec !== undefined).length;
      toast(L(`${r.slides.length} שקפים, ${matched} הותאמו להקלטה`, `${r.slides.length} slides, ${matched} matched to the recording`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // The slide being heard: the last one whose minute has passed.
  let current = -1;
  if (heard !== undefined) slides.forEach((s, i) => { if (s.sec !== undefined && s.sec <= heard) current = i; });
  return (
    <div className="study-slides">
      <div className="row study-actions">
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? L("קורא את השקפים…", "Reading the slides…") : slides.length ? L("להחליף שקפים", "Replace the slides") : L("הוספת שקפי ההרצאה (PowerPoint / PDF)", "Add the lecture's slides (PowerPoint / PDF)")}</button>
        {!!slides.length && <button type="button" className="ghost small" disabled={busy} onClick={() => void api(`${base}/slides`, { method: "DELETE" }).then(() => onSlides(undefined), (e: Error) => toast(e.message))}>{L("להסיר", "Remove")}</button>}
        <input ref={input} type="file" hidden accept=".pptx,.pdf" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void add(f); }} />
      </div>
      {!slides.length && <p className="muted small">{L("כל שקף יותאם לדקה בהקלטה שבה דיברו עליו. לחיצה על השקף מנגנת משם.", "Each slide is matched to the minute of the recording where it is talked about. Tap a slide to play from there.")}</p>}
      <ol className="study-slide-list">
        {slides.map((s, i) => {
          const [title, ...rest] = s.text.split("\n").filter((x) => x.trim());
          return (
            <li key={s.n} className={i === current ? "on" : ""}>
              <div className="row">
                <b dir="auto">{s.n}. {title ?? ""}</b>
                <span className="grow" />
                {s.sec !== undefined && (hasRecording ? <button type="button" className="ghost small" dir="ltr" onClick={() => onSeek(s.sec!)}>▶ {mmss(s.sec)}</button> : <span className="muted small" dir="ltr">{mmss(s.sec)}</span>)}
              </div>
              {rest.length > 0 && <p className="small muted" dir="auto">{rest.slice(0, 6).join(" · ")}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
