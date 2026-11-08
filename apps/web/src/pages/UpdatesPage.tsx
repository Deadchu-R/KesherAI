import { useEffect, useState } from "react";
import { api } from "../api";
import { desktop } from "../library";
import { reconnect } from "../Reconnect";
import { t } from "../i18n";

interface UpdateCheck { version: string; commit?: string; install: string; newCommits: Array<{ hash: string; subject: string }>; latestVersion?: string; localChanges: string[] }
interface UpdateProgress { running: boolean; step?: string; log: string[]; error?: string; restartRequired?: boolean; fromSource?: boolean; finishedAt?: string }

/** Updates, from the side menu: this version, what is new, and installing it. */
export function UpdatesPage() {
  return (
    <div className="page">
      <h1>{t("updatesNav")}</h1>
      <Updates />
    </div>
  );
}

function Updates() {
  const [version, setVersion] = useState<{ version: string; commit?: string; install: string } | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void api<{ version: string; commit?: string; install: string }>("/api/version").then(setVersion);
    void api<UpdateProgress>("/api/updates/progress").then((p) => p.running && setProgress(p));
  }, []);
  useEffect(() => {
    if (!progress?.running) return;
    // The server may restart during the update; keep polling through the gap.
    const timer = setInterval(() => void api<UpdateProgress>("/api/updates/progress").then(setProgress).catch(() => undefined), 1000);
    return () => clearInterval(timer);
  }, [progress?.running]);

  // When the update is done, open the new version by itself.
  const finished = !!progress && !progress.running && progress.step === "Done" && !progress.error;
  useEffect(() => {
    if (!finished || !progress) return;
    if (progress.restartRequired && desktop()?.restart) {
      void desktop()!.restart!();
      return;
    }
    if (progress.restartRequired) return void reconnect({ restart: true }); // the computer's app restarts itself
    // From source the server restarts itself; reload once it answers with the new commit.
    const before = version?.commit;
    const timer = setInterval(() => {
      void api<{ commit?: string }>("/api/version")
        .then((v) => {
          if (v.commit && v.commit !== before) location.reload();
        })
        .catch(() => undefined);
    }, 1500);
    const fallback = setTimeout(() => location.reload(), 20_000);
    return () => {
      clearInterval(timer);
      clearTimeout(fallback);
    };
  }, [finished]);

  const doCheck = async () => {
    setError("");
    setChecking(true);
    try {
      setCheck(await api<UpdateCheck>("/api/updates"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const apply = async () => {
    setError("");
    try {
      setProgress(await api<UpdateProgress>("/api/updates/apply", { method: "POST" }));
      // From the phone (or a browser): the computer's app installs and restarts; wait for it and reconnect.
      if (!desktop()?.restart) void reconnect({ update: true });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card stack">
      <h2>{t("version")}</h2>
      <p className="row muted small">
        <span className="grow">{t("restartHint")}</span>
        <button type="button" onClick={() => void reconnect({ restart: true })}>{t("restartComputerApp")}</button>
      </p>
      <p className="mono">{version ? `KesherAI v${version.version}${version.commit ? ` (${version.commit})` : ""}` : "…"}</p>
      <div className="row">
        <button type="button" onClick={() => void doCheck()} disabled={checking || !!progress?.running}>{checking ? "…" : t("checkUpdates")}</button>
        {check && check.newCommits.length > 0 && !progress?.running && (
          <button type="button" className="primary" onClick={() => void apply()}>{t("installUpdate")}</button>
        )}
      </div>
      {check && check.newCommits.length === 0 && <p className="pill good" style={{ alignSelf: "flex-start" }}>{t("upToDate")}</p>}
      {check && check.newCommits.length > 0 && (
        <>
          <p>{t("updateAvailable", { n: check.newCommits.length })}{check.latestVersion && check.latestVersion !== check.version ? ` · v${check.latestVersion}` : ""}</p>
          <ul className="commits">
            {check.newCommits.map((c) => <li key={c.hash}><span className="mono muted">{c.hash}</span> {c.subject}</li>)}
          </ul>
          {check.localChanges.length > 0 && <p className="error">{t("localChanges", { files: check.localChanges.slice(0, 5).join(", ") })}</p>}
        </>
      )}
      {progress && (
        <>
          <p>{progress.running ? `${t("updating")} ${progress.step ?? ""}` : progress.error ? "" : progress.restartRequired && !desktop()?.restart ? t("updateRestart") : t("updateDone")}</p>
          {finished && progress.restartRequired && desktop()?.restart && <button type="button" className="primary" onClick={() => void desktop()!.restart!()}>{t("restartNow")}</button>}
          {progress.running && progress.log.length > 0 && <p className="muted mono small" dir="ltr" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{progress.log.at(-1)}</p>}
          {progress.error && <p className="error">{progress.error}</p>}
          <details><summary>{t("output")}</summary><pre className="code" dir="ltr">{progress.log.join("\n")}</pre></details>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

