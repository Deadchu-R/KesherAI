import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DECK_THEMES, SLIDE_LAYOUTS, pptxFiles, type Deck, type DeckTheme, type Slide, type SlideLayout } from "@kesher/shared";
import { strToU8, zipSync } from "fflate";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const LAYOUT_NAMES: Record<SlideLayout, [string, string]> = { title: ["כותרת", "Title"], bullets: ["נקודות", "Bullets"], two: ["שתי עמודות", "Two columns"], quote: ["ציטוט", "Quote"], picture: ["תמונה", "Picture"] };
const rtl = (t: string) => /[֐-ࣿ]/.test(t);
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Text she edits in place: plain text only (pasted formatting is dropped), saved when she leaves the field. */
function Editable({ value, onChange, className, placeholder, edit }: { value: string; onChange: (v: string) => void; className?: string; placeholder: string; edit: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.innerText !== value) ref.current.innerText = value;
  }, [value]);
  if (!edit) return <div className={className} dir="auto">{value}</div>;
  return (
    <div
      ref={ref}
      className={`${className ?? ""} slide-edit`}
      dir="auto"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onBlur={(e) => { const v = e.currentTarget.innerText.replace(/\n+$/, ""); if (v !== value) onChange(v); }}
      onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); }}
    />
  );
}

/** One slide drawn in the deck's theme; editable in the editor, still when presenting or in a thumbnail. */
export function SlideView({ slide: raw, theme, edit = false, onChange, small = false }: { slide: Slide; theme: DeckTheme; edit?: boolean; onChange?: (s: Slide) => void; small?: boolean }) {
  // An older or hand-made slide may lack its lists.
  const slide = { ...raw, bullets: raw.bullets ?? [] };
  const t = DECK_THEMES[theme] ?? DECK_THEMES.night;
  const style = { ["--bg" as string]: t.bg, ["--fg" as string]: t.fg, ["--accent" as string]: t.accent, ["--muted" as string]: t.muted } as CSSProperties;
  const set = (p: Partial<Slide>) => onChange?.({ ...slide, ...p });
  const list = (items: string[], key: "bullets" | "more") => (edit
    ? <Editable edit value={items.join("\n")} onChange={(v) => set({ [key]: v.split("\n").map((x) => x.trim()).filter(Boolean) })} className="slide-list" placeholder={L("נקודה בכל שורה", "One point per line")} />
    : <ul className="slide-list">{items.map((b, i) => <li key={i}>{b}</li>)}</ul>);
  const dir = rtl(slide.title + slide.bullets.join("")) ? "rtl" : "ltr";
  return (
    <div className={`slide ${slide.layout}${small ? " small" : ""}`} style={style} dir={dir}>
      {slide.layout === "title" ? (
        <div className="slide-center">
          <Editable edit={edit} value={slide.title} onChange={(v) => set({ title: v })} className="slide-title big" placeholder={L("כותרת", "Title")} />
          {(edit || slide.bullets[0]) && <Editable edit={edit} value={slide.bullets[0] ?? ""} onChange={(v) => set({ bullets: v ? [v] : [] })} className="slide-sub" placeholder={L("כותרת משנה", "Subtitle")} />}
        </div>
      ) : slide.layout === "quote" ? (
        <div className="slide-center">
          <Editable edit={edit} value={slide.title} onChange={(v) => set({ title: v })} className="slide-quote" placeholder={L("הציטוט", "The quote")} />
          <Editable edit={edit} value={(slide.more ?? [])[0] ?? ""} onChange={(v) => set({ more: v ? [v] : [] })} className="slide-sub" placeholder={L("מי אמר", "Who said it")} />
        </div>
      ) : (
        <>
          <Editable edit={edit} value={slide.title} onChange={(v) => set({ title: v })} className="slide-title" placeholder={L("כותרת", "Title")} />
          <div className={`slide-body ${slide.layout}`}>
            {list(slide.bullets, "bullets")}
            {slide.layout === "two" && list(slide.more ?? [], "more")}
            {slide.layout === "picture" && (
              <figure className="slide-pic">
                {slide.image ? <img src={slide.image.startsWith("data:") ? slide.image : withToken(`/api/web/image?url=${encodeURIComponent(slide.image)}`)} alt={slide.title} /> : edit ? <span className="muted small">{L("הדביקי תמונה או קישור למטה", "Paste a picture or a link below")}</span> : null}
                {(slide.more ?? [])[0] && <figcaption>{slide.more![0]}</figcaption>}
              </figure>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The deck as a PDF, through the system's "Save as PDF": one page per slide (and its notes), no other program. */
export function printDeckPdf(d: Pick<Deck, "title" | "theme" | "slides">) {
  const t = DECK_THEMES[d.theme];
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const he = rtl(d.title + d.slides.map((x) => x.title).join(""));
  const li = (a: string[]) => (a.length ? `<ul>${a.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "");
  const page = (s: Slide) => `<section class="${s.layout}"><h1>${esc(s.title)}</h1>${s.layout === "two" ? `<div class="two">${li(s.bullets)}${li(s.more ?? [])}</div>` : li(s.layout === "quote" ? s.more ?? [] : s.bullets)}${s.layout === "picture" && s.image?.startsWith("data:") ? `<img src="${s.image}">` : ""}${s.notes ? `<p class="say">${esc(s.notes)}</p>` : ""}</section>`;
  const html = `<!doctype html><html dir="${he ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>@page{size:A4 landscape;margin:0}body{margin:0;font-family:Heebo,Arial,sans-serif}section{box-sizing:border-box;width:297mm;height:210mm;padding:20mm 24mm;background:${t.bg};color:${t.fg};page-break-after:always;display:flex;flex-direction:column;-webkit-print-color-adjust:exact;print-color-adjust:exact}section.title,section.quote{justify-content:center;text-align:center}h1{font-size:30pt;margin:0 0 10mm;color:${t.fg}}section.title h1{font-size:40pt}section.quote h1{font-style:italic}li{font-size:19pt;line-height:1.65}.two{display:grid;grid-template-columns:1fr 1fr;gap:12mm}img{max-height:110mm;max-width:100%;object-fit:contain}.say{margin-top:auto;font-size:10pt;color:${t.muted}}</style></head><body>${d.slides.map(page).join("")}</body></html>`;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

/** The deck as an editable .pptx (optional: for whoever needs PowerPoint). */
function downloadPptx(d: Deck) {
  const files = pptxFiles(d.title, d.slides.map((s) => ({ title: s.title, bullets: s.layout === "two" ? [...s.bullets, ...(s.more ?? [])] : s.layout === "quote" ? s.more ?? [] : s.bullets, notes: s.notes ?? "" })));
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
  a.download = `${d.title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || "slides"}.pptx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Full-screen presenting: arrows, space and clicks move; Esc ends; N shows the notes. */
function Present({ deck, from, onClose }: { deck: Deck; from: number; onClose: () => void }) {
  const [i, setI] = useState(from);
  const [notes, setNotes] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void box.current?.requestFullscreen?.().catch(() => undefined);
    const rtlDeck = rtl(deck.title);
    const key = (e: KeyboardEvent) => {
      const fwd = rtlDeck ? ["ArrowLeft", "ArrowDown", " ", "PageDown"] : ["ArrowRight", "ArrowDown", " ", "PageDown"];
      const back = rtlDeck ? ["ArrowRight", "ArrowUp", "PageUp"] : ["ArrowLeft", "ArrowUp", "PageUp"];
      if (fwd.includes(e.key)) setI((n) => Math.min(deck.slides.length - 1, n + 1));
      else if (back.includes(e.key)) setI((n) => Math.max(0, n - 1));
      else if (e.key === "Escape") onClose();
      else if (e.key.toLowerCase() === "n") setNotes((v) => !v);
    };
    const exit = () => !document.fullscreenElement && onClose();
    addEventListener("keydown", key);
    document.addEventListener("fullscreenchange", exit);
    return () => {
      removeEventListener("keydown", key);
      document.removeEventListener("fullscreenchange", exit);
    };
  }, [deck, onClose]);
  const s = deck.slides[i];
  if (!s) return null;
  return (
    <div ref={box} className="slides-present" onClick={() => setI((n) => Math.min(deck.slides.length - 1, n + 1))}>
      <SlideView slide={s} theme={deck.theme} />
      <span className="slides-present-count">{i + 1} / {deck.slides.length}</span>
      {notes && s.notes && <p className="slides-present-notes" dir="auto">{s.notes}</p>}
    </div>
  );
}

/**
 * KesherAI's own slides (#/slides and #/slides/<id>, design DeckEditor): the list of decks, and the editor: click any
 * text to edit it, add, remove and move slides, a theme, speaker notes, versions, present, PDF (PPTX optional).
 * The model's edits from the chat appear live.
 */
export function SlidesPage({ id }: { id?: string }) {
  if (!id) return <DeckList />;
  return <DeckEditor key={id} id={id} />;
}

function DeckList() {
  const [decks, setDecks] = useState<Array<{ id: string; title: string; slides: number; updatedAt: string }> | null>(null);
  useEffect(() => void api<{ decks: NonNullable<typeof decks> }>("/api/decks").then((r) => setDecks(r.decks), (e: Error) => toast(e.message)), []);
  const create = async () => {
    const d = await api<Deck>("/api/decks", { method: "POST", body: { title: L("מצגת חדשה", "New deck"), slides: [{ layout: "title", title: L("מצגת חדשה", "New deck"), bullets: [] }] } });
    location.hash = `#/slides/${d.id}`;
  };
  return (
    <main className="page slides-page">
      <header className="page-head row">
        <h1>📑 {L("מצגות", "Slides")}</h1>
        <span className="grow" />
        <button type="button" className="primary" onClick={() => void create()}>＋ {L("מצגת חדשה", "New deck")}</button>
      </header>
      <p className="muted">{L("מצגות שנשמרות ב-KesherAI: עורכים, מציגים ומורידים כ-PDF, בלי PowerPoint. אפשר גם לבקש מהצ'אט \"תכין לי מצגת על…\".", "Decks kept in KesherAI: edit, present and save as PDF, no PowerPoint needed. You can also ask a chat to \"make slides about…\".")}</p>
      {!decks ? <p className="muted">…</p> : !decks.length ? <p className="muted">{L("עוד אין מצגות.", "No decks yet.")}</p> : (
        <ul className="slides-list">{decks.map((d) => <li key={d.id}><a href={`#/slides/${d.id}`} className="card"><b dir="auto">{d.title}</b><span className="muted small">{L(`${d.slides} שקופיות`, `${d.slides} slides`)} · {new Date(d.updatedAt).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB")}</span></a></li>)}</ul>
      )}
    </main>
  );
}

function DeckEditor({ id }: { id: string }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [at, setAt] = useState(0);
  const [present, setPresent] = useState(false);
  const [saving, setSaving] = useState<"" | "saving" | "saved">("");
  const [ask, setAsk] = useState("");
  const pending = useRef<Deck | null>(null);
  const timer = useRef(0);
  const load = useCallback(() => void api<Deck>(`/api/decks/${id}`).then((d) => { if (!pending.current) setDeck(d); }, (e: Error) => toast(e.message)), [id]);
  useEffect(load, [load]);
  // The model's edits from the chat: loaded when the deck changes (not while her own edit is waiting to save).
  useEffect(() => {
    const es = new EventSource(withToken(`/api/decks/${id}/events`));
    es.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { rev?: number };
      if (typeof m.rev === "number" && m.rev !== pending.current?.rev && m.rev !== deckRev.current) load();
    };
    return () => es.close();
  }, [id, load]);
  const deckRev = useRef(-1);
  deckRev.current = deck?.rev ?? -1;
  const save = (next: Deck) => {
    setDeck(next);
    pending.current = next;
    setSaving("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const d = pending.current;
      if (!d) return;
      try {
        const saved = await api<Deck>(`/api/decks/${id}`, { method: "PUT", body: { title: d.title, theme: d.theme, slides: d.slides, rev: d.rev } });
        pending.current = null;
        setDeck((cur) => (cur ? { ...cur, rev: saved.rev, versions: saved.versions } : saved));
        setSaving("saved");
      } catch (e) {
        pending.current = null;
        toast(L("המצגת השתנתה בינתיים (למשל מהצ'אט). טוען את החדשה, ואפשר לערוך שוב.", "The deck changed meanwhile (from the chat, say). Loading the new one; edit again."));
        load();
        void e;
      }
    }, 700);
  };
  if (!deck) return <main className="page"><p className="muted">…</p></main>;
  const slides = deck.slides;
  const cur = slides[Math.min(at, slides.length - 1)];
  const setSlides = (s: Slide[]) => save({ ...deck, slides: s });
  const change = (s: Slide) => setSlides(slides.map((x) => (x.id === s.id ? s : x)));
  const add = (layout: SlideLayout) => {
    const s: Slide = { id: newId(), layout, title: "", bullets: [] };
    const i = Math.min(at + 1, slides.length);
    setSlides([...slides.slice(0, i), s, ...slides.slice(i)]);
    setAt(i);
  };
  const move = (d: -1 | 1) => {
    const j = at + d;
    if (j < 0 || j >= slides.length) return;
    const n = [...slides];
    [n[at], n[j]] = [n[j]!, n[at]!];
    setSlides(n);
    setAt(j);
  };
  const remove = () => {
    if (slides.length <= 1) return;
    setSlides(slides.filter((_, i) => i !== at));
    setAt(Math.max(0, at - 1));
  };
  const askAi = async () => {
    if (!ask.trim() || !cur) return;
    try {
      const conv = deck.convId ?? (await api<{ id: string }>("/api/conversations", { method: "POST", body: { kind: "chat" } })).id;
      await api(`/api/conversations/${conv}/messages`, { method: "POST", body: { text: `${L("במצגת", "In the deck")} "${deck.title}" (#/slides/${deck.id}), ${L("שקופית", "slide")} [${cur.id}]: ${ask.trim()}\n${L("השתמש בכלי slides (קודם read, אחר כך change).", "Use the slides tool (read first, then change).")}` } });
      setAsk("");
      toast(L("נשלח לצ'אט. השינוי יופיע כאן כשיסתיים.", "Sent to the chat. The change appears here when it is done."));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <main className="page slides-editor">
      <div className="slides-bar">
        <a href="#/slides" className="link">‹</a>
        <Editable edit value={deck.title} onChange={(v) => save({ ...deck, title: v || deck.title })} className="slides-name" placeholder={L("שם המצגת", "Deck name")} />
        <span className="muted small">{saving === "saving" ? L("שומר…", "Saving…") : saving === "saved" ? L("נשמר", "Saved") : ""}</span>
        {!!deck.versions?.length && (
          <select aria-label={L("גרסאות", "Versions")} value="" onChange={(e) => e.target.value && void api<Deck>(`/api/decks/${id}/restore`, { method: "POST", body: { rev: Number(e.target.value) } }).then(setDeck, (er: Error) => toast(er.message))}>
            <option value="">{L(`גרסה ${deck.rev}`, `Version ${deck.rev}`)} ▾</option>
            {[...deck.versions].reverse().map((v) => <option key={v.rev} value={v.rev}>{L("לחזור לגרסה", "Back to version")} {v.rev} · {new Date(v.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</option>)}
          </select>
        )}
        <span className="grow" />
        <select aria-label={L("ערכה", "Theme")} value={deck.theme} onChange={(e) => save({ ...deck, theme: e.target.value as DeckTheme })}>
          {(Object.keys(DECK_THEMES) as DeckTheme[]).map((t) => <option key={t} value={t}>🎨 {L(DECK_THEMES[t].he, DECK_THEMES[t].en)}</option>)}
        </select>
        <button type="button" className="primary" onClick={() => setPresent(true)}>🖥 {L("להציג", "Present")}</button>
        <button type="button" onClick={() => printDeckPdf(deck)}>⬇ PDF</button>
        <button type="button" className="link small" onClick={() => downloadPptx(deck)}>PowerPoint</button>
      </div>
      <div className="slides-work">
        <ol className="slides-thumbs" aria-label={L("שקופיות", "Slides")}>
          {slides.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={i === at ? "on" : ""} onClick={() => setAt(i)} aria-label={`${i + 1}. ${s.title}`}>
                <span className="muted small">{i + 1}</span>
                <SlideView slide={s} theme={deck.theme} small />
              </button>
            </li>
          ))}
        </ol>
        {cur && (
          <div className="slides-main">
            <div className="slides-tools row">
              <select aria-label={L("פריסה", "Layout")} value={cur.layout} onChange={(e) => change({ ...cur, layout: e.target.value as SlideLayout })}>
                {SLIDE_LAYOUTS.map((l) => <option key={l} value={l}>{L(...LAYOUT_NAMES[l])}</option>)}
              </select>
              <select aria-label={L("שקופית חדשה", "New slide")} value="" onChange={(e) => e.target.value && add(e.target.value as SlideLayout)}>
                <option value="">＋ {L("שקופית", "Slide")}</option>
                {SLIDE_LAYOUTS.map((l) => <option key={l} value={l}>{L(...LAYOUT_NAMES[l])}</option>)}
              </select>
              <button type="button" className="icon-btn" aria-label={L("להזיז אחורה", "Move back")} disabled={at === 0} onClick={() => move(-1)}>↑</button>
              <button type="button" className="icon-btn" aria-label={L("להזיז קדימה", "Move forward")} disabled={at >= slides.length - 1} onClick={() => move(1)}>↓</button>
              <button type="button" className="icon-btn" aria-label={L("למחוק שקופית", "Delete slide")} disabled={slides.length <= 1} onClick={remove}>🗑</button>
            </div>
            <SlideView slide={cur} theme={deck.theme} edit onChange={change} />
            {cur.layout === "picture" && (
              <input dir="ltr" placeholder={L("קישור לתמונה (https)", "Picture link (https)")} value={cur.image?.startsWith("data:") ? "" : cur.image ?? ""} onChange={(e) => change({ ...cur, image: e.target.value })}
                onPaste={(e) => {
                  const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
                  if (!f) return;
                  e.preventDefault();
                  if (f.size > 3 * 1024 * 1024) return toast(L("התמונה גדולה מ-3MB.", "The picture is over 3 MB."));
                  const r = new FileReader();
                  r.onload = () => change({ ...cur, image: String(r.result) });
                  r.readAsDataURL(f);
                }} />
            )}
            <label className="slides-notes">
              <span className="muted small">{L("הערות דובר", "Speaker notes")}</span>
              <textarea dir="auto" rows={3} value={cur.notes ?? ""} onChange={(e) => change({ ...cur, notes: e.target.value })} />
            </label>
            <form className="slides-ask row" onSubmit={(e) => { e.preventDefault(); void askAi(); }}>
              <input dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`✨ ${L("לבקש מהמודל לשנות את השקופית הזו…", "Ask the model to change this slide…")}`} />
              <button type="submit" disabled={!ask.trim()}>{L("שליחה", "Send")}</button>
            </form>
          </div>
        )}
      </div>
      {present && <Present deck={deck} from={at} onClose={() => { setPresent(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); }} />}
    </main>
  );
}
