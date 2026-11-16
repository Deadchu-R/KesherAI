import { useEffect, useRef, useState } from "react";
import { api, appHome } from "./api";
import { getLocale, he$ } from "./i18n";
import { type Handoff, phoneHandoffUrl } from "./phone-handoff";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Inside the phone app (remote): checks the computer every 15 seconds; when it stops answering twice, a banner offers
 * to go on with the open chat on the phone's own model. The chat's last messages are read ahead of time, while the
 * computer still answers.
 */
export function PcDrop() {
  const home = appHome();
  const [down, setDown] = useState(false);
  const kept = useRef<Handoff | null>(null);
  useEffect(() => {
    if (!home) return;
    let misses = 0;
    const tick = async () => {
      if (document.hidden) return;
      try {
        await api("/api/health", { signal: AbortSignal.timeout(5000) });
        misses = 0;
        setDown(false);
        const id = /^#\/c\/([\w-]{8,64})/.exec(location.hash)?.[1];
        kept.current = id ? await api<Handoff>(`/api/conversations/${id}/handoff`).catch(() => kept.current) : null;
      } catch {
        if (++misses >= 2) setDown(true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 15_000);
    return () => clearInterval(t);
  }, [home]);
  if (!home || !down) return null;
  return (
    <div className="pc-drop" role="alert">
      <span>{L("המחשב לא עונה.", "The computer is not answering.")}</span>
      <button type="button" className="primary small" onClick={() => (location.href = phoneHandoffUrl(home, kept.current))}>
        {kept.current?.messages.length ? L("המשך את הצ׳אט בטלפון", "Go on with this chat on the phone") : L("המשך בטלפון", "Go on on the phone")}
      </button>
    </div>
  );
}
