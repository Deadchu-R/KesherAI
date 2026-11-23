import { useEffect, useRef, useState } from "react";
import { api, appHome, getWakeMac, getWakeBcast } from "./api";
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
  // What the computer says it is busy with (reading a level takes the processor): shown instead of "not answering".
  const [busy, setBusy] = useState<string | null>(null);
  const kept = useRef<Handoff | null>(null);
  useEffect(() => {
    if (!home) return;
    let misses = 0;
    let wasBusy = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        // A busy computer answers slowly: wait longer, and count more misses, before saying it is gone.
        const h = await api<{ busy?: string; busyHe?: string }>("/api/health", { signal: AbortSignal.timeout(wasBusy ? 20_000 : 5000) });
        wasBusy = !!h.busy;
        setBusy(h.busy ? L(h.busyHe ?? h.busy, h.busy) : null);
        misses = 0;
        setDown(false);
        const id = /^#\/c\/([\w-]{8,64})/.exec(location.hash)?.[1];
        kept.current = id ? await api<Handoff>(`/api/conversations/${id}/handoff`).catch(() => kept.current) : null;
      } catch {
        if (++misses >= (wasBusy ? 6 : 2)) {
          setDown(true);
          setBusy(null);
        }
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 15_000);
    return () => clearInterval(t);
  }, [home]);
  // The phone's home-screen widget asks for one of the phone's own screens: go there from the computer's interface too.
  useEffect(() => {
    if (!home) return;
    const notify = (window as unknown as { Capacitor?: { Plugins?: { KesherNotify?: { takeOpenPhone?: () => Promise<{ path?: string }>; addListener?: (e: string, f: () => void) => Promise<{ remove: () => void }> } } } }).Capacitor?.Plugins?.KesherNotify;
    const WIDGET: Record<string, string> = { "#/phone/new": "local.html?new=1", "#/phone/live": "local.html?new=1&live=1", "#/phone/study": "local.html?tab=study", "#/phone/chats": "local.html?tab=chats" };
    const go = () => void notify?.takeOpenPhone?.().then((r) => { const to = r?.path ? WIDGET[r.path] : undefined; if (to) location.href = `${home.replace(/\/$/, "")}/${to}`; }, () => undefined);
    go();
    const sub = notify?.addListener?.("openPhone", go);
    return () => void sub?.then((x) => x.remove());
  }, [home]);
  const tryWake = () => {
    const mac = getWakeMac();
    const bcast = getWakeBcast();
    if (!mac || !bcast) return;
    const wol = (window as unknown as { Capacitor?: { Plugins?: { WakeOnLan?: { wake?: (o: { mac: string; broadcast: string }) => Promise<void> } } } }).Capacitor?.Plugins?.WakeOnLan;
    if (wol) {
      void wol.wake?.({ mac, broadcast: bcast }).catch(() => undefined);
    }
  };
  if (home && busy && !down) return <div className="pc-drop" role="status"><span>{L("המחשב עסוק: ", "The computer is busy: ")}{busy}…</span></div>;
  if (!home || !down) return null;
  const hasWake = getWakeMac() && getWakeBcast();
  return (
    <div className="pc-drop" role="alert">
      <span>{L("המחשב לא עונה.", "The computer is not answering.")}</span>
      {hasWake && (
        <button type="button" className="small" onClick={tryWake}>
          {L("הערת מחשב", "Wake computer")}
        </button>
      )}
      <button type="button" className="primary small" onClick={() => (location.href = phoneHandoffUrl(home, kept.current))}>
        {kept.current?.messages.length ? L("המשך את הצ׳אט בטלפון", "Go on with this chat on the phone") : L("המשך בטלפון", "Go on on the phone")}
      </button>
    </div>
  );
}
