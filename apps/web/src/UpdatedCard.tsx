import { useEffect, useState } from "react";
import { api, appHome, isRemote } from "./api";
import { phoneAppBehind, versionsSince, type ReleaseNotes } from "./updated-notes";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const SEEN = "kesherai-seen-version";

type PhoneUpdater = { check(o: { url: string }): Promise<{ currentName: string; latestName: string; available: boolean }> };
const PHONE_VERSION_URL = "https://github.com/Deadchu-R/KesherAI/releases/download/android-latest/android-version.json";

/**
 * After an update, once per device: "Updated to X" (on a phone connected to the computer: "The PC was updated to X")
 * with what is new in every version since this device last saw one, from the release notes, on the home screen.
 * On the phone app it also says whether the app itself is behind. The first run only remembers the version.
 * Dismissing remembers the version in this browser (the phone's page lives at the computer's address, so it is per
 * computer).
 */
export function UpdatedCard({ hash }: { hash: string }) {
  const [card, setCard] = useState<{ version: string; versions: ReleaseNotes[]; phone?: string } | null>(null);
  useEffect(() => {
    void (async () => {
      const v = await api<{ version: string }>("/api/version").catch(() => undefined);
      if (!v) return;
      let seen: string | null = null;
      try { seen = localStorage.getItem(SEEN); } catch { /* storage off: show nothing */ return; }
      if (!seen) { try { localStorage.setItem(SEEN, v.version); } catch { /* none */ } return; }
      if (seen === v.version) return;
      const h = await api<{ releases: Array<{ version: string; notes: string[] }> }>("/api/updates/history").catch(() => undefined);
      const versions = versionsSince(h?.releases ?? [], seen, v.version);
      // The phone app itself: is a newer one out (the app's own updater answers; a plain browser has none).
      const up = (window as unknown as { Capacitor?: { Plugins?: { KesherUpdater?: PhoneUpdater } } }).Capacitor?.Plugins?.KesherUpdater;
      const phone = await up?.check({ url: PHONE_VERSION_URL }).then((i) => (phoneAppBehind(i.currentName, i.latestName) ? i.latestName : undefined), () => undefined);
      setCard({ version: v.version, versions, ...(phone ? { phone } : {}) });
    })();
  }, []);
  if (!card || (hash !== "#/" && hash !== "")) return null;
  const remote = isRemote() || !!appHome();
  const close = () => { try { localStorage.setItem(SEEN, card.version); } catch { /* none */ } setCard(null); };
  return (
    <section className="card stack updated-card" role="status">
      <div className="row" style={{ gap: 10 }}>
        <span className="updated-dot" aria-hidden />
        <b className="grow">{remote ? L(`המחשב עודכן ל-${card.version}`, `The PC was updated to ${card.version}`) : L(`עודכן ל-${card.version}`, `Updated to ${card.version}`)}</b>
        <button type="button" className="ghost small" aria-label={L("סגירה", "Close")} onClick={close}>✕</button>
      </div>
      {card.versions.map((r) => (
        <div key={r.version} className="stack updated-ver">
          {card.versions.length > 1 && <span className="muted small" dir="ltr">v{r.version}</span>}
          {r.notes.length > 0 && <ul dir="auto">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      ))}
      {card.phone && <p className="small" dir="auto">📱 {L(`גם אפליקציית הטלפון מחכה לעדכון (${card.phone}).`, `The phone app also has an update waiting (${card.phone}).`)}</p>}
      <div className="row"><a className="button" href="#/updates" onClick={close}>{L(remote ? "מה חדש" : "כל השינויים", remote ? "What's new" : "All changes")}</a></div>
    </section>
  );
}
