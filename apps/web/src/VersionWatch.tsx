import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Something that must not be cut by a reload is running (a lecture recording); set by that page. */
export const busy = { recording: false };

/**
 * Notices that KesherAI on the computer was updated while this page stayed open (an automatic update, or one
 * started from another device): the page would keep the old interface until a full restart, which is how new
 * features went missing on the phone. Coming back to the page reloads it; while it is on screen, a bar offers the
 * reload. Never during a lecture recording.
 */
export function VersionWatch() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let first: string | undefined;
    let newer = false;
    const check = async () => {
      const v = await api<{ version: string; commit?: string }>("/api/version").catch(() => undefined);
      if (!v) return;
      const id = `${v.version}:${v.commit ?? ""}`;
      first ??= id;
      if (id !== first) {
        newer = true;
        setStale(true);
      }
    };
    const onShow = () => {
      if (document.visibilityState !== "visible") return;
      if (newer && !busy.recording) location.reload();
      else void check().then(() => newer && !busy.recording && location.reload());
    };
    void check();
    const id = setInterval(() => void check(), 3 * 60_000);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);
  if (!stale) return null;
  return (
    <div className="version-bar" role="status">
      <span>{L("KesherAI במחשב עודכן לגרסה חדשה.", "KesherAI on the computer was updated.")}</span>
      <button type="button" className="primary" onClick={() => location.reload()}>{L("רענן", "Reload")}</button>
    </div>
  );
}
