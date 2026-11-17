import { useEffect, useRef, useState } from "react";
import { RichText } from "./RichText";
import { speak, stopSpeaking } from "./Speak";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A text as sentences to read one by one (code blocks and diagrams left out). */
export function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n+/)
    .flatMap((line) => line.replace(/^[#>*\-\d.\s]+/, "").split(/(?<=[.!?;:])\s+/))
    .map((x) => x.replace(/[*_`#]/g, "").trim())
    .filter((x) => /[\p{L}\p{N}]/u.test(x));
}

/**
 * Read-along (RESEARCH_LOG students part 26 #4, like NaturalReader): the text read aloud sentence by sentence, the
 * sentence being read highlighted and kept in view; tap a sentence to read from it. Otherwise the text as usual
 * (`plain`: a lecture's own text, shown as it is, not as markdown).
 */
export function ReadAlong({ text, plain }: { text: string; plain?: boolean }) {
  const parts = sentences(text);
  const [at, setAt] = useState<number | null>(null);
  const run = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const play = (from: number) => {
    const token = ++run.current;
    const next = (i: number) => {
      if (token !== run.current) return;
      if (i >= parts.length) return setAt(null);
      setAt(i);
      void speak(parts[i]!, () => next(i + 1));
    };
    next(from);
  };
  const stop = () => {
    run.current++;
    stopSpeaking();
    setAt(null);
  };
  useEffect(() => () => {
    run.current++;
    stopSpeaking();
  }, []);
  useEffect(() => {
    if (at === null) return;
    box.current?.querySelector(`[data-s="${at}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [at]);
  return (
    <div className="read-along">
      <button type="button" className={at !== null ? "primary" : ""} onClick={() => (at !== null ? stop() : play(0))}>{at !== null ? `⏹ ${L("עצירה", "Stop")}` : `🔊 ${L("להקריא עם הדגשה", "Read aloud with highlight")}`}</button>
      {at === null ? (plain ? <div dir="auto" className="read-along-plain">{text}</div> : <div dir="auto"><RichText text={text} /></div>) : (
        <div ref={box} className="read-along-text" dir="auto">
          {parts.map((p, i) => <span key={i} data-s={i} className={i === at ? "now" : i < at ? "read" : ""} onClick={() => play(i)}>{p} </span>)}
        </div>
      )}
    </div>
  );
}
