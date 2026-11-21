import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { ConvertWithAI } from "./ConvertWithAI";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** GET /api/engine-plugins/unity-compile: whether the KesherAI package compiled in the shown Unity project. */
interface CompileInfo {
  project?: string;
  /** The Unity editor version of the project, e.g. "2020.3.48f1". */
  editor?: string;
  state: "ok" | "failed" | "unknown";
  errors: string[];
}

/**
 * "The KesherAI package did not compile in this Unity version" (Roee, 2026-11-21): when Unity's own log shows compile
 * errors in the package (and the package's `Temp/KesherBridge.ok` marker is missing), the page says so with the first
 * error and offers "Convert with AI" (the same flow as Unreal's), sending the error lines with the task. Reads files on
 * the computer through the server, so it shows on the phone too. Nothing is shown while it compiled or is unknown.
 *
 * @param props.project - The Unity project folder shown (the server's active project when empty).
 */
export function UnityCompileFailed({ project }: { project?: string }) {
  const [info, setInfo] = useState<CompileInfo | null>(null);
  useEffect(() => {
    const load = () => void api<CompileInfo>(`/api/engine-plugins/unity-compile${project ? `?project=${encodeURIComponent(project)}` : ""}`).then(setInfo, () => setInfo(null));
    load();
    // Unity compiles when it gets focus, a little after the package was added: look again now and then.
    const id = setInterval(load, 15000);
    addEventListener("kesher-unity-added", load);
    return () => {
      clearInterval(id);
      removeEventListener("kesher-unity-added", load);
    };
  }, [project]);
  if (!info || info.state !== "failed" || !info.editor) return null;
  return (
    <section className="card stack compile-failed" role="alert">
      <strong dir="auto">⚠ {L("חבילת KesherAI לא התקמפלה בגרסת Unity הזאת", "The KesherAI package did not compile in this Unity version")}{info.project ? ` · ${info.project}` : ""}</strong>
      <p className="small" dir="ltr">{info.errors[0]}</p>
      {info.errors.length > 1 && (
        <details>
          <summary className="small">{L(`עוד ${info.errors.length - 1} שגיאות`, `${info.errors.length - 1} more errors`)}</summary>
          <pre className="ue-log" dir="ltr">{info.errors.slice(1).join("\n")}</pre>
        </details>
      )}
      <ConvertWithAI engine="unity" version={info.editor} {...(info.project ? { project: info.project } : {})} errors={info.errors} />
    </section>
  );
}
