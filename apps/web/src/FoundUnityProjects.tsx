import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Unity projects found on this computer (Unity Hub's list and the usual
 * folders) that are not added yet: one click adds one. Works from the phone
 * too (only these found projects; any other folder is chosen on the computer).
 *
 * @param p.onAdded - After a project was added (the page reloads its status).
 */
export function FoundUnityProjects(p: { onAdded: () => void }) {
  const [found, setFound] = useState<Array<{ name: string; path: string; engine?: string }> | null>(null);
  const [busy, setBusy] = useState("");
  const load = () => void api<{ projects: Array<{ name: string; path: string; engine?: string }> }>("/api/unity/found").then((r) => setFound(r.projects), () => setFound([]));
  useEffect(load, []);
  if (!found?.length) return null;
  const add = (path: string) => {
    setBusy(path);
    void api("/api/unity/project", { method: "PUT", body: { project: path } })
      .then(() => { toast(L("הפרויקט נוסף", "Project added")); load(); p.onAdded(); }, (e: Error) => toast(e.message))
      .finally(() => setBusy(""));
  };
  return (
    <details className="card found-projects" open>
      <summary><strong>{L(`נמצאו במחשב (${found.length})`, `Found on this computer (${found.length})`)}</strong></summary>
      <ul>
        {found.map((f) => (
          <li key={f.path} className="row">
            <span className="grow">
              <strong>{f.name}</strong>
              {f.engine && <span className="muted small"> · Unity {f.engine}</span>}
              <span className="muted small block" dir="ltr">{f.path}</span>
            </span>
            <button type="button" disabled={!!busy} onClick={() => add(f.path)}>{busy === f.path ? "…" : L("הוסף", "Add")}</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
