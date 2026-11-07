import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { desktop } from "./library";
import { t } from "./i18n";

interface FileItem { path: string; size: number; modifiedAt: string }

const size = (b: number) => (b > 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const RUNNABLE = /\.(exe|msi|apk|appimage|dmg|zip)$/i;

/**
 * The files a conversation made or works on, each with a download button,
 * plus "Download all" as a ZIP and, in the desktop app, "Open folder".
 *
 * @param props.convId - Conversation id.
 * @param props.refresh - Changes whenever the agent may have changed files.
 * @param props.onCount - Reports how many files there are (for the button badge).
 */
export function FilesPanel({ convId, refresh, onCount }: { convId: string; refresh: number; onCount?: (n: number, runnable: boolean) => void }) {
  const [data, setData] = useState<{ folder: string; files: FileItem[] } | null>(null);
  const [building, setBuilding] = useState("");
  const [buildMsg, setBuildMsg] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void api<{ folder: string; files: FileItem[] }>(`/api/conversations/${convId}/files`)
      .then((d) => {
        setData(d);
        onCount?.(d.files.length, d.files.some((f) => RUNNABLE.test(f.path)));
      })
      .catch(() => setData({ folder: "", files: [] }));
  }, [convId, refresh, reload]);
  if (!data) return null;
  const base = `/api/conversations/${convId}/files`;
  const runnable = data.files.filter((f) => RUNNABLE.test(f.path));
  const others = data.files.filter((f) => !RUNNABLE.test(f.path));
  const build = async (path: string) => {
    setBuilding(path);
    setBuildMsg("");
    try {
      await api(`${base}/build`, { method: "POST", body: { path } });
      setBuildMsg(t("buildDone"));
      setReload((n) => n + 1);
    } catch (e) {
      setBuildMsg((e as Error).message);
    } finally {
      setBuilding("");
    }
  };
  const row = (f: FileItem) => (
    <div key={f.path} className="file-line">
      <a className="file-row grow" href={withToken(`${base}/download?path=${encodeURIComponent(f.path)}`)} download>
        <span className="mono grow" dir="ltr">{f.path}</span>
        <span className="muted mono" dir="ltr">{size(f.size)}</span>
        <span aria-hidden>⬇</span>
      </a>
      {/\.py$/i.test(f.path) && (
        <button type="button" disabled={!!building} onClick={() => void build(f.path)} title={t("buildExeHint")}>
          {building === f.path ? t("building") : t("buildExe")}
        </button>
      )}
    </div>
  );
  return (
    <aside className="files-panel card stack" aria-label={t("files")}>
      <div className="row">
        <strong className="grow">{t("files")}</strong>
        {data.files.length > 0 && <a className="button" href={withToken(`${base}/zip`)} download>{t("downloadAll")}</a>}
        {desktop()?.openPath && data.folder && <button type="button" onClick={() => void desktop()!.openPath!(data.folder)}>{t("openFolder")}</button>}
      </div>
      {data.files.length === 0 && <p className="muted">{t("noFiles")}</p>}
      {building && <p className="muted">{t("buildingHint")}</p>}
      {buildMsg && <p className={buildMsg === t("buildDone") ? "pill good" : "error"} style={{ alignSelf: "flex-start" }}>{buildMsg}</p>}
      {runnable.length > 0 && (
        <div className="stack">
          <span className="pill good" style={{ alignSelf: "flex-start" }}>{t("readyToRun")}</span>
          {runnable.map(row)}
        </div>
      )}
      <div className="list">{others.map(row)}</div>
    </aside>
  );
}
