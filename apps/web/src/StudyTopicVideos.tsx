import { useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { clockOf } from "./StudyTimeNotes";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
interface Found { id: string; title: string; channel?: string; duration?: number }

/**
 * Videos on the lecture's topic (design TopicVideos, students part 29 #7, like Gemini Guided Learning): a few YouTube
 * lectures found by the topic's words (only the words leave the computer), each to watch on YouTube or to add as a
 * lecture of the course in one tap (its captions become the text, with minute marks).
 */
export function StudyTopicVideos({ courseId, topic }: { courseId: string; topic: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(topic);
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState("");
  const search = async () => {
    setBusy("search");
    try {
      setFound((await api<{ videos: Found[] }>(`/api/study/courses/${courseId}/videos?q=${encodeURIComponent(q)}`)).videos);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const add = async (v: Found) => {
    setBusy(v.id);
    try {
      const l = await api<{ id: string }>(`/api/study/courses/${courseId}/lectures/youtube`, { method: "POST", body: { url: `https://www.youtube.com/watch?v=${v.id}` } });
      toast(L("נוסף כהרצאה בקורס", "Added as a lecture"));
      location.hash = `#/study/${courseId}/l/${l.id}`;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!open) return <button type="button" className="ghost small" onClick={() => { setOpen(true); void search(); }}>🎬 {L("סרטונים על הנושא", "Videos on this topic")}</button>;
  return (
    <section className="study-videos">
      <form className="row study-papers-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input type="search" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} aria-label={L("חיפוש סרטונים", "Find videos")} />
        <button type="submit" disabled={!q.trim() || busy === "search"}>{busy === "search" ? "…" : L("חיפוש", "Search")}</button>
      </form>
      {found && !found.length && <p className="muted small">{L("לא נמצאו סרטונים. נסי מילים אחרות.", "No videos found. Try other words.")}</p>}
      {found?.map((v) => (
        <div key={v.id} className="study-video-row">
          <div className="study-video-info">
            <b dir="auto">{v.title}</b>
            <span className="muted small" dir="auto">{[v.channel, v.duration ? clockOf(v.duration) : ""].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="row study-paper-actions">
            <a className="button small" href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noopener noreferrer">▶ {L("לצפייה", "Watch")}</a>
            <button type="button" className="small" disabled={!!busy} onClick={() => void add(v)}>{busy === v.id ? L("מוסיף…", "Adding…") : L("➕ כהרצאה", "➕ As a lecture")}</button>
          </div>
        </div>
      ))}
      <p className="muted small">{L("רק מילות החיפוש יוצאות מהמחשב. הוספה כהרצאה לוקחת את הכתוביות של הסרטון (או מתמללת אותו).", "Only the search words leave the computer. Adding one takes the video's captions (or transcribes it).")}</p>
    </section>
  );
}
