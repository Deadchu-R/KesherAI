import { useEffect, useState } from "react";
import { api, ApiError, isRemote } from "../api";
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
      <WhatsNew />
      <UpdateFeed />
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
  const apply = async (force = false) => {
    setError("");
    try {
      setProgress(await api<UpdateProgress>("/api/updates/apply", { method: "POST", body: { force } }));
      // From the phone (or a browser): the computer's app installs and restarts; wait for it and reconnect.
      if (!desktop()?.restart) void reconnect({ update: true });
    } catch (e) {
      // Chats are working: the update would stop them in the middle (they can continue afterwards).
      if (e instanceof ApiError && e.code === "chats-working" && !force) {
        const ok = confirm(getLocale() === "he" ? `יש צ'אטים שעובדים עכשיו. העדכון יפעיל מחדש את KesherAI ויעצור אותם (אפשר להמשיך אותם אחרי העדכון).\n\n${e.message}\n\nלעדכן בכל זאת?` : `${e.message}\n\nUpdate anyway?`);
        if (ok) return apply(true);
        return;
      }
      setError((e as Error).message);
    }
  };

  // Is the computer free for the restart, and is the install waiting for that.
  const [ready, setReady] = useState<{ chats: number; selfWork: boolean; downloads: number; updating: boolean; study?: number; whenFree: boolean } | null>(null);
  const loadReady = () => void api<NonNullable<typeof ready>>("/api/updates/ready").then(setReady, () => undefined);
  useEffect(loadReady, []);
  useEffect(() => {
    if (!ready?.whenFree) return;
    const timer = setInterval(loadReady, 10_000);
    return () => clearInterval(timer);
  }, [ready?.whenFree]);
  const setWhenFree = async (on: boolean) => {
    setError("");
    try {
      await api("/api/updates/when-free", { method: "POST", body: { on } });
      loadReady();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const he = getLocale() === "he";
  const showReady = !!ready && !progress?.running && (ready.whenFree || (check?.newCommits.length ?? 0) > 0);

  return (
    <section className="card stack">
      <h2>{t("version")}</h2>
      {showReady && ready && (
        <div className="update-ready stack">
          <div className="ready-checks">
            <span className={ready.chats ? "busy" : "free"}>{ready.chats ? (he ? `${ready.chats} צ׳אטים עובדים` : `${ready.chats} chats working`) : he ? "אין צ׳אט שעובד" : "No chat working"}</span>
            <span className={ready.selfWork ? "busy" : "free"}>{ready.selfWork ? (he ? "עבודה עצמית רצה" : "Self-work running") : he ? "עבודה עצמית לא רצה" : "Self-work not running"}</span>
            <span className={ready.downloads ? "busy" : "free"}>{ready.downloads ? (he ? `${ready.downloads} הורדות` : `${ready.downloads} downloads`) : he ? "אין הורדה" : "No download"}</span>
            {!!ready.study && <span className="busy">{he ? "לימודים: המודל כותב סיכום או בוחן" : "Study: the model is writing a summary or quiz"}</span>}
          </div>
          {ready.whenFree ? (
            <div className="row">
              <span className="grow small">{he ? "העדכון יותקן לבד כשכל אלה יתפנו." : "The update installs by itself once all of these are free."}</span>
              <button type="button" onClick={() => void setWhenFree(false)}>{he ? "בטל המתנה" : "Stop waiting"}</button>
            </div>
          ) : (
            <button type="button" className="primary" style={{ alignSelf: "flex-start" }} onClick={() => void setWhenFree(true)}>{he ? "התקן כשהמחשב פנוי" : "Install when the computer is free"}</button>
          )}
        </div>
      )}
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


/** What's new: the last releases and their notes, the installed one marked (as in the redesign). */
function WhatsNew() {
  const he = getLocale() === "he";
  const [list, setList] = useState<Array<{ version: string; date?: string; notes: string[] }> | null>(null);
  const [mine, setMine] = useState("");
  useEffect(() => {
    void api<{ releases: Array<{ version: string; date?: string; notes: string[] }> }>("/api/updates/history").then((r) => setList(r.releases), () => setList([]));
    void api<{ version: string }>("/api/version").then((v) => setMine(v.version), () => undefined);
  }, []);
  if (!list?.length) return null;
  return (
    <section className="card stack">
      <h2>{he ? "מה חדש" : "What's new"}</h2>
      <div className="releases">
        {list.map((r) => (
          <div key={r.version} className="release">
            <h3>
              {r.version}
              <small>{r.date ? new Date(r.date).toLocaleDateString(he ? "he-IL" : undefined) : ""}{r.version === mine ? (he ? " · מותקנת" : " · installed") : ""}</small>
            </h3>
            {r.notes.length > 0 && <ul dir="auto">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Updates without GitHub: what this computer passes on to my other computers (the installer it last downloaded and
 * checked, or one it built), and the folder of a build made here.
 */
function UpdateFeed() {
  const he = getLocale() === "he";
  const [st, setSt] = useState<{ serving: { version: string; built: boolean } | null; buildFolder: string | null } | null>(null);
  const [folder, setFolder] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => void api<NonNullable<typeof st>>("/api/updates/feed-status").then((x) => { setSt(x); setFolder(x.buildFolder ?? ""); }, () => undefined);
  useEffect(load, []);
  const save = async (value: string) => {
    setMsg("");
    try {
      await api("/api/updates/build-folder", { method: "POST", body: { folder: value } });
      load();
      setMsg(he ? "נשמר" : "Saved");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!st) return null;
  return (
    <section className="card stack">
      <h2>{he ? "עדכונים בלי GitHub" : "Updates without GitHub"}</h2>
      <p className="muted small">{he ? "כשמחשב אחר שלי (ב\"המכשירים שלי\") מחזיק גרסה חדשה יותר מ־GitHub, העדכון מגיע ממנו, ונבדק באותה טביעת sha512." : "When another of my computers (in My devices) has a newer version than GitHub, the update comes from it, checked with the same sha512."}</p>
      <p className="small">
        {st.serving
          ? he ? `המחשב הזה מעביר הלאה את ${st.serving.version} (${st.serving.built ? "בנייה מהמחשב הזה" : "ההתקנה האחרונה שהורדה"}).` : `This computer passes on ${st.serving.version} (${st.serving.built ? "a build made here" : "the last installer it downloaded"}).`
          : he ? "למחשב הזה אין עדיין גרסה להעביר הלאה. אחרי העדכון הבא מ־GitHub היא תישמר כאן." : "This computer has no version to pass on yet. After the next update from GitHub it is kept here."}
      </p>
      {!isRemote() && (
        <div className="stack">
          <label className="small" htmlFor="build-folder">{he ? "תיקיית בנייה במחשב הזה (הפלט של pnpm dist, עם latest.yml)" : "A build folder on this computer (pnpm dist's output, with latest.yml)"}</label>
          <div className="row">
            <input id="build-folder" className="grow" dir="ltr" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="…\KesherAI\apps\desktop\out" />
            <button type="button" onClick={() => void save(folder)}>{he ? "שמור" : "Save"}</button>
            {st.buildFolder && <button type="button" onClick={() => void save("")}>{he ? "הסר" : "Remove"}</button>}
          </div>
        </div>
      )}
      {msg && <p className="muted small">{msg}</p>}
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
export function PhoneAppUpdates() {
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
