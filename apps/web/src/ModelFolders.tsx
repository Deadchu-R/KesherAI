import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { desktop } from "./library";

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

interface Folder { folder: string; source: string }
interface ScanResult extends Folder { added: boolean; totalSize: number; models: Array<{ path: string; name: string; size: number; format: string }> }

/**
 * Where models are downloaded, the other folders KesherAI reads models
 * from, and "Scan this computer" to find models other apps downloaded.
 */
export function ModelFolders({ onChange }: { onChange: () => void }) {
  const [info, setInfo] = useState<{ modelsDir: string; defaultDir: string; folders: Folder[] } | null>(null);
  const [dir, setDir] = useState("");
  const [extra, setExtra] = useState("");
  const [scan, setScan] = useState<ScanResult[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<typeof info>("/api/models/folders").then((i) => { setInfo(i); setDir(i?.modelsDir ?? ""); }).catch(() => undefined);
  }, []);
  if (!info) return null;
  const save = async (body: { modelsDir?: string | null; folders?: Folder[] }) => {
    setError("");
    try {
      const next = await api<NonNullable<typeof info>>("/api/models/folders", { method: "PUT", body });
      setInfo(next);
      setDir(next.modelsDir);
      onChange();
      return next;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  };
  const runScan = async () => {
    setScanning(true);
    setError("");
    try { setScan(await api<ScanResult[]>("/api/models/scan", { method: "POST" })); } catch (e) { setError((e as Error).message); }
    setScanning(false);
  };
  const add = async (f: Folder) => {
    const next = await save({ folders: [...info.folders, f] });
    if (next && scan) setScan(scan.map((r) => (r.folder === f.folder ? { ...r, added: true } : r)));
  };
  const pick = (set: (v: string) => void) => desktop() && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && set(f))}>{t("browse")}</button>;
  return (
    <div className="stack folders">
      <label className="stack">
        <strong>{t("modelsFolder")}</strong>
        <span className="muted">{t("modelsFolderHint")}</span>
        <div className="row">
          <input className="grow mono" dir="ltr" value={dir} onChange={(e) => setDir(e.target.value)} />
          {pick(setDir)}
          <button type="button" className="primary" disabled={dir === info.modelsDir} onClick={() => void save({ modelsDir: dir })}>{t("save")}</button>
          {info.modelsDir !== info.defaultDir && <button type="button" onClick={() => void save({ modelsDir: null })}>{t("useDefault")}</button>}
        </div>
      </label>

      <div className="stack">
        <strong>{t("otherFolders")}</strong>
        <span className="muted">{t("otherFoldersHint")}</span>
        {info.folders.map((f) => (
          <div key={f.folder} className="row">
            <span className="pill">{f.source}</span>
            <span className="mono grow" dir="ltr">{f.folder}</span>
            <button type="button" onClick={() => void save({ folders: info.folders.filter((x) => x.folder !== f.folder) })}>{t("remove")}</button>
          </div>
        ))}
        <div className="row">
          <input className="grow mono" dir="ltr" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="D:\AI\models" aria-label={t("otherFolders")} />
          {pick(setExtra)}
          <button type="button" disabled={!extra} onClick={() => void add({ folder: extra, source: "Folder" }).then(() => setExtra(""))}>{t("addFolder")}</button>
          <button type="button" className="primary" disabled={scanning} onClick={() => void runScan()}>{scanning ? t("scanning") : t("scanComputer")}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {scan && (
        <div className="card stack">
          <strong>{scan.length ? t("scanFound", { n: scan.reduce((n, r) => n + r.models.length, 0) }) : t("scanNothing")}</strong>
          {scan.map((r) => (
            <details key={r.folder}>
              <summary className="row">
                <span className="pill">{r.source}</span>
                <span className="mono grow" dir="ltr">{r.folder}</span>
                <span className="muted" dir="ltr">{r.models.length} · {gb(r.totalSize)}</span>
                {r.added ? <span className="pill good">{t("added")}</span> : (
                  <button type="button" className="primary" onClick={(e) => { e.preventDefault(); void add({ folder: r.folder, source: r.source }); }}>{t("useThese")}</button>
                )}
              </summary>
              <div className="list">
                {r.models.map((m) => (
                  <div key={m.path} className="row muted">
                    <span className="mono grow" dir="ltr">{m.name}</span>
                    <span className="mono" dir="ltr">{m.format}</span>
                    <span className="mono" dir="ltr">{gb(m.size)}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
          <span className="muted">{t("scanNote")}</span>
        </div>
      )}
    </div>
  );
}
