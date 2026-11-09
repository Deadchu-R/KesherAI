import { useEffect, useState } from "react";
import { api } from "../api";
import { desktop } from "../library";
import { reconnect } from "../Reconnect";
import { getLocale, t } from "../i18n";

interface UpdateCheck { version: string; commit?: string; install: string; newCommits: Array<{ hash: string; subject: string }>; latestVersion?: string; localChanges: string[]; building?: string }
interface UpdateProgress { running: boolean; step?: string; log: string[]; error?: string; restartRequired?: boolean; fromSource?: boolean; finishedAt?: string }

/** Updates, from the side menu: this version, what is new, and installing it. */
export function UpdatesPage() {
  return (
    <div className="page">
      <h1>{t("updatesNav")}</h1>
      <Updates />
      <PhoneAppUpdates />
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
  // "Update all my computers" (My devices, same Google account): the others start at once, this one as usual.
  const [others, setOthers] = useState<number>(0);
  const [allResult, setAllResult] = useState<Array<{ name: string; started: boolean; message: string }> | null>(null);
  const [allBusy, setAllBusy] = useState(false);
  useEffect(() => {
    void api<{ devices: Array<{ me: boolean }> }>("/api/devices").then((d) => setOthers(d.devices.filter((x) => !x.me).length), () => undefined);
  }, []);
  const updateAll = async () => {
    setAllBusy(true);
    setError("");
    try {
      const r = await api<{ computers: Array<{ name: string; started: boolean; message: string }> }>("/api/devices/update-all", { method: "POST" });
      setAllResult(r.computers);
      const c = check ?? (await api<UpdateCheck>("/api/updates").catch(() => null));
      if (c?.newCommits.length) await apply();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAllBusy(false);
    }
  };
  // Builds running now: they keep going through the update, and the chat joins them again afterwards.
  const [jobs, setJobs] = useState<Array<{ id: string; key: string; startedAt: string }>>([]);
  useEffect(() => {
    void api<{ running: Array<{ id: string; key: string; startedAt: string }> }>("/api/jobs").then((r) => setJobs(r.running), () => undefined);
  }, []);
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
      {jobs.length > 0 && (
        <p className="small" dir="auto">
          🔨 {getLocale() === "he"
            ? `${jobs.length === 1 ? "בנייה אחת רצה" : `${jobs.length} בניות רצות`} עכשיו (${jobs.map((j) => j.key.split(":")[0]).join(", ")}). הן ממשיכות לרוץ בזמן העדכון; אחריו כתוב "המשך" בצ'אט והוא יתחבר אליהן שוב.`
            : `${jobs.length === 1 ? "A build is" : `${jobs.length} builds are`} running now (${jobs.map((j) => j.key.split(":")[0]).join(", ")}). They keep going during the update; afterwards say "continue" in the chat and it picks them up again.`}
        </p>
      )}
      <div className="row">
        <button type="button" onClick={() => void doCheck()} disabled={checking || !!progress?.running}>{checking ? "…" : t("checkUpdates")}</button>
        {check && check.newCommits.length > 0 && !progress?.running && (
          <button type="button" className="primary" onClick={() => void apply()}>{t("installUpdate")}</button>
        )}
      </div>
      {others > 0 && (
        <div className="stack">
          <div className="row">
            <button type="button" className="primary" disabled={allBusy || !!progress?.running} onClick={() => void updateAll()}>⟳ {getLocale() === "he" ? `עדכן את כל המחשבים שלי (${others + 1})` : `Update all my computers (${others + 1})`}</button>
            <span className="muted small">{getLocale() === "he" ? "המחשבים ב\"המכשירים שלי\" (אותו חשבון Google) מתעדכנים ונפתחים מחדש לבד, וגם המחשב הזה." : "The computers in My devices (same Google account) update and restart by themselves, and this one too."}</span>
          </div>
          {allResult && (
            <ul className="small">
              {allResult.map((c) => <li key={c.name}>{c.started ? "⟳" : "⚠"} <b>{c.name}</b>: {c.started ? (getLocale() === "he" ? "מתעדכן" : "updating") : c.message}</li>)}
            </ul>
          )}
        </div>
      )}
      {check && check.newCommits.length === 0 && <p className="pill good" style={{ alignSelf: "flex-start" }}>{t("upToDate")}</p>}
      {check?.building && (
        <p className="muted small">{getLocale() === "he" ? `גרסה ${check.building} עדיין נבנית למחשב הזה ב-GitHub. היא תופיע כאן כשתהיה מוכנה (בדרך כלל תוך כמה דקות).` : `Version ${check.building} is still being built for this computer on GitHub. It appears here when it is ready (usually within minutes).`}</p>
      )}
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


type PhoneUpdater = {
  check(o: { url: string }): Promise<{ available: boolean; currentName: string; latestName: string; apkUrl?: string; changes?: Array<{ subject: string; he?: string }> }>;
  install(o: { url: string; open?: boolean }): Promise<unknown>;
  addListener(event: "progress", cb: (p: { percent: number }) => void): Promise<{ remove: () => void }>;
};
const PHONE_VERSION_URL = "https://github.com/Deadchu-R/KesherAI/releases/download/android-latest/android-version.json";

/** Inside the Android app: the phone app's own updates, without leaving the computer's page. */
function PhoneAppUpdates() {
  const up = (window as unknown as { Capacitor?: { Plugins?: { KesherUpdater?: PhoneUpdater } } }).Capacitor?.Plugins?.KesherUpdater;
  const [info, setInfo] = useState<Awaited<ReturnType<PhoneUpdater["check"]>> | null>(null);
  const [state, setState] = useState("");
  const [pct, setPct] = useState(-1);
  useEffect(() => {
    if (up) void up.check({ url: PHONE_VERSION_URL }).then(setInfo, () => undefined);
  }, []);
  if (!up) return null;
  const check = async () => {
    setState(t("checking"));
    try {
      setInfo(await up.check({ url: PHONE_VERSION_URL }));
      setState("");
    } catch (e) {
      setState((e as Error).message);
    }
  };
  const install = async () => {
    if (!info?.apkUrl) return;
    setPct(0);
    const sub = await up.addListener("progress", (p) => setPct(p.percent));
    try {
      await up.install({ url: info.apkUrl, open: true });
      setState(t("phoneUpdateInstalling"));
    } catch (e) {
      const m = (e as Error).message;
      setState(m === "needs-permission" ? t("phoneUpdatePermission") : m);
    } finally {
      sub.remove();
      setPct(-1);
    }
  };
  return (
    <section className="card stack">
      <h2>{t("phoneAppUpdates")}</h2>
      <p className="mono">{info ? `v${info.currentName}` : ""}</p>
      <div className="row">
        <button type="button" onClick={() => void check()} disabled={pct >= 0}>{t("checkUpdates")}</button>
        {info?.available && <button type="button" className="primary" disabled={pct >= 0} onClick={() => void install()}>{pct >= 0 ? `${pct}%` : t("installUpdate")}</button>}
      </div>
      {info && !info.available && <p className="pill good" style={{ alignSelf: "flex-start" }}>{t("upToDate")}</p>}
      {info?.available && <p>{t("phoneUpdateAvailable", { v: info.latestName })}</p>}
      {pct >= 0 && <div className="bar"><div style={{ width: `${pct}%` }} /></div>}
      {state && <p className="muted">{state}</p>}
    </section>
  );
}

/**
 * Inside the Android app, on any page of the computer's interface: a line
 * saying a new phone app is out, which updates it right there (the
 * connection to the computer stays; Android asks to confirm the install).
 */
export function PhoneUpdateBanner() {
  const up = (window as unknown as { Capacitor?: { Plugins?: { KesherUpdater?: PhoneUpdater } } }).Capacitor?.Plugins?.KesherUpdater;
  const [info, setInfo] = useState<Awaited<ReturnType<PhoneUpdater["check"]>> | null>(null);
  const [pct, setPct] = useState(-1);
  const [msg, setMsg] = useState("");
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem("kesher-phone-update-later") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (up && !hidden) void up.check({ url: PHONE_VERSION_URL }).then(setInfo, () => undefined);
  }, []);
  if (!up || hidden || !info?.available) return null;
  const he = getLocale() === "he";
  const install = async () => {
    if (!info.apkUrl) return;
    setPct(0);
    setMsg("");
    const sub = await up.addListener("progress", (p) => setPct(p.percent));
    try {
      await up.install({ url: info.apkUrl, open: true });
      setMsg(t("phoneUpdateInstalling"));
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === "needs-permission" ? t("phoneUpdatePermission") : m);
    } finally {
      sub.remove();
      setPct(-1);
    }
  };
  return (
    <div className="phone-update row">
      <span className="grow">📱 {he ? `גרסה חדשה לאפליקציה בטלפון: ${info.latestName}` : `A new phone app: ${info.latestName}`}{msg ? ` · ${msg}` : ""}</span>
      {pct >= 0 ? (
        <span className="phone-update-pct"><span className="bar"><span style={{ width: `${Math.max(0, pct)}%` }} /></span> {Math.max(0, pct)}%</span>
      ) : (
        <>
          <button type="button" className="primary" onClick={() => void install()}>{he ? "עדכן עכשיו" : "Update now"}</button>
          <button type="button" onClick={() => { setHidden(true); try { sessionStorage.setItem("kesher-phone-update-later", "1"); } catch { /* fine */ } }}>{he ? "אחר כך" : "Later"}</button>
        </>
      )}
    </div>
  );
}
