/**
 * "Update" in the top bar, next to the design button, when a newer KesherAI is out: big enough to see, with the
 * version on it (the small arrow at the bottom of the sidebar was easy to miss). It opens the Updates page.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

export function UpdateButton() {
  const [latest, setLatest] = useState("");
  useEffect(() => {
    const check = () =>
      void api<{ newCommits: unknown[]; latestVersion?: string; version: string }>("/api/updates").then(
        (c) => setLatest(c.newCommits.length && c.latestVersion && c.latestVersion !== c.version ? c.latestVersion : ""),
        () => undefined,
      );
    check();
    const t = window.setInterval(() => !document.hidden && check(), 30 * 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!latest) return null;
  return (
    <a className="bar-update" href="#/updates" title={L(`גרסה ${latest} זמינה: לדף העדכונים`, `Version ${latest} is available: open Updates`)}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
      <span>{L("עדכון", "Update")}</span>
      <span className="bar-update-v" dir="ltr">{latest}</span>
    </a>
  );
}
