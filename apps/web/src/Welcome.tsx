import { BrandMark } from "./ui/BrandMark";
import { useEffect, useState } from "react";
import { RECOMMENDED_MODELS, ROLES, partsForRole, pinsForRoles, type RoleDefinition } from "@kesher/shared";
import { api, isRemote } from "./api";
import { setPinOrder, usePins } from "./Sidebar";
import { getLocale, setLocale, he$ } from "./i18n";
import { refreshParts, setParts, useParts } from "./parts";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const pick = <T,>(v: { en: T; he: T }) => (getLocale() === "he" ? v.he : v.en);

interface Onboarding { done: boolean; role?: string; show: boolean; google: { configured: boolean; connected: boolean }; remote: { enabled: boolean } }

/** Opens the welcome again (Settings → "Show the welcome again"). */
export function openWelcome(): void {
  dispatchEvent(new Event("kesher-welcome"));
}

/** Told when the welcome saves new roles, so the start screen and All tools follow at once. */
const ROLE_EVENT = "kesher-role";

/**
 * The roles picked in the welcome (comma-separated ids, as stored on the computer), kept fresh when the welcome
 * saves new ones. Works on the phone too: the roles live on the computer.
 *
 * @returns The stored value, or undefined until known / when none was picked.
 */
export function useRoleIds(): string | undefined {
  const [role, setRole] = useState<string | undefined>();
  useEffect(() => {
    const load = () => void api<Onboarding>("/api/onboarding").then((o) => setRole(o.role), () => undefined);
    load();
    addEventListener(ROLE_EVENT, load);
    return () => removeEventListener(ROLE_EVENT, load);
  }, []);
  return role;
}

/**
 * The picked roles as one role whose ideas are the starter prompts of all of them, mixed (four in all).
 *
 * @param ids - Role ids.
 * @returns The mixed role, or undefined when none is known.
 */
function mixRoles(ids: string[]): RoleDefinition | undefined {
  const picked = ROLES.filter((r) => ids.includes(r.id));
  if (picked.length <= 1) return picked[0];
  const mix = (k: "en" | "he") => picked.flatMap((r) => r.ideas[k].slice(0, Math.ceil(4 / picked.length))).slice(0, 4);
  return { ...picked[0]!, ideas: { en: mix("en"), he: mix("he") } };
}

/** The roles picked in the welcome, for the start screen's ideas (their ideas mixed). */
export function useRole(): RoleDefinition | undefined {
  return mixRoles((useRoleIds() ?? "").split(","));
}

/** The tool groups of the welcome (the same as the menu's). */
const TOOL_GROUPS: Array<{ id: string; icon: string; title: { en: string; he: string }; parts: string[] }> = [
  { id: "study", icon: "🎓", title: { en: "Study", he: "לימודים" }, parts: ["study"] },
  { id: "create", icon: "🎨", title: { en: "Create", he: "יצירה" }, parts: ["images", "video", "image-editor", "nodes"] },
  { id: "games", icon: "🎮", title: { en: "Game engines", he: "מנועי משחק" }, parts: ["unreal", "unity"] },
  { id: "work", icon: "🧠", title: { en: "Work and knowledge", he: "עבודה וידע" }, parts: ["pages", "knowledge", "day", "compare", "pipelines"] },
  { id: "agent", icon: "🖥", title: { en: "The agent on your computer", he: "הסוכן במחשב שלך" }, parts: ["browser", "watch"] },
  { id: "assistant", icon: "🤖", title: { en: "Voice and community", he: "קול וקהילה" }, parts: ["voice", "community"] },
];

const STEPS = ["hello", "role", "tools", "models", "start"] as const;
type Step = (typeof STEPS)[number];

/**
 * The first-run welcome: what KesherAI is, what fits you (roles, several at
 * once), which tools to start with, a check of this computer with 1–3 models
 * that fit it, and starter prompts (plus, on the computer, connecting a
 * phone). Shows once, on the computer, before the first chat; "Show the
 * welcome again" opens it anywhere, the phone too. Every answer can be
 * changed later (Parts, Settings, All tools).
 */
export function Welcome({ onLocale }: { onLocale: () => void }) {
  const [info, setInfo] = useState<Onboarding | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("hello");
  const [roles, setRoles] = useState<string[]>([]);
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const { parts } = useParts();
  const [pins] = usePins();

  useEffect(() => {
    void api<Onboarding>("/api/onboarding").then((o) => {
      setInfo(o);
      if (o.show) setOpen(true);
      if (o.role) setRoles(o.role.split(",").filter(Boolean));
    }, () => undefined);
    const reopen = () => {
      setStep("hello");
      setOpen(true);
    };
    addEventListener("kesher-welcome", reopen);
    return () => removeEventListener("kesher-welcome", reopen);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && void finish(true);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  });

  if (!open || !info) return null;
  const index = STEPS.indexOf(step);
  const go = (s: Step) => setStep(s);
  /** Each role is a toggle: the tools are what all the picked roles need. */
  const toggleRole = (id: string) => {
    const next = roles.includes(id) ? roles.filter((r) => r !== id) : [...roles, id];
    setRoles(next);
    setChoice(next.length ? partsForRole(next) : {});
  };
  /**
   * Saves the answers: the parts, the roles (they order the All tools page), and the roles' pages pinned first in
   * the sidebar (the user's own pins stay after them). Skipping keeps everything as it is now.
   *
   * @param skip - Closed with Skip or Escape.
   * @param ask - A starter prompt to put in the message box on the start screen.
   */
  const finish = async (skip = false, ask?: string) => {
    setSaving(true);
    try {
      if (!skip && Object.keys(choice).length) await setParts({ parts: choice });
      // A new install starts in simple mode (chat, pictures, models, settings); Settings → Parts → Show everything.
      await api("/api/onboarding", { method: "PUT", body: { done: true, simple: true, ...(roles.length ? { role: roles.join(",") } : {}) } });
      if (!skip && roles.length) setPinOrder(pinsForRoles(roles, pins));
      dispatchEvent(new Event(ROLE_EVENT));
      await refreshParts();
    } catch {
      // the welcome closes anyway; Settings has everything
    } finally {
      setSaving(false);
      setOpen(false);
      if (ask) location.hash = `#/?ask=${encodeURIComponent(ask)}`;
      // A student goes straight to Study, where its guided first setup starts (design StudySetupWizard).
      else if (!skip && roles.includes("student")) location.hash = "#/study";
    }
  };
  const gb = parts.filter((p) => choice[p.id]).reduce((n, p) => n + p.downloadGb, 0);
  const google = async () => {
    try {
      const { url } = await api<{ url: string }>("/api/google/connect", { method: "POST", body: {} });
      window.open(url, "_blank", "noopener");
    } catch {
      location.hash = "#/settings/accounts";
    }
  };

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-label={L("ברוכים הבאים ל-KesherAI", "Welcome to KesherAI")}>
      <div className="welcome-card">
        <header className="welcome-top">
          <ol className="welcome-steps" aria-label={L("שלבים", "Steps")}>
            {STEPS.map((s, i) => <li key={s} className={i === index ? "now" : i < index ? "done" : ""} aria-current={i === index ? "step" : undefined} />)}
          </ol>
          <button type="button" className="welcome-lang" onClick={() => { setLocale(getLocale() === "he" ? "en" : "he"); onLocale(); setInfo({ ...info }); }}>{getLocale() === "he" ? "English" : "עברית"}</button>
          <button type="button" className="welcome-skip" onClick={() => void finish(true)}>{L("דלג", "Skip")}</button>
        </header>

        {step === "hello" && (
          <section className="welcome-body welcome-hello">
            <BrandMark size={72} className="welcome-mark" />
            <h1>{L("כל המודלים שלך, במחשב שלך", "All your AI models, on your own computer")}</h1>
            <p className="welcome-lead">{L("צ'אט, קוד, תמונות, קול, מוזיקה ותלת-ממד — במקום אחד, בחינם, והקבצים שלך נשארים אצלך.", "Chat, code, pictures, voice, music and 3D — in one place, free, and your files stay with you.")}</p>
            <ul className="welcome-points">
              <li><b>{L("רץ אצלך", "Runs here")}</b>{L("המודלים רצים על המחשב, גם בלי אינטרנט.", "Models run on this computer, even offline.")}</li>
              <li><b>{L("רק מה שצריך", "Only what you need")}</b>{L("כל כלי הוא חלק שאפשר להדליק ולכבות.", "Every tool is a part you turn on or off.")}</li>
              <li><b>{L("גם מהטלפון", "From your phone too")}</b>{L("ממשיכים מהטלפון כשלא ליד המחשב.", "Carry on from your phone when you are away.")}</li>
            </ul>
            <div className="welcome-actions"><button type="button" className="primary big" onClick={() => go("role")}>{L("בוא נתחיל", "Let's start")}</button></div>
          </section>
        )}

        {step === "role" && (
          <section className="welcome-body">
            <h2>{L("מה מתאים לך?", "What fits you?")}</h2>
            <p className="welcome-lead">{L("לחץ על כל מה שמתאים — אפשר כמה. לפי זה נסדר את הכלים, ובשלב הבא אפשר לשנות.", "Tap everything that fits — more than one is fine. The tools are set from it, and you can change them next.")}</p>
            <div className="welcome-roles">
              {ROLES.map((r) => (
                <button key={r.id} type="button" className={`welcome-role${roles.includes(r.id) ? " on" : ""}`} aria-pressed={roles.includes(r.id)} onClick={() => toggleRole(r.id)}>
                  {roles.includes(r.id) && <span className="welcome-role-check" aria-hidden="true">✓</span>}
                  <span className="welcome-role-icon" aria-hidden="true">{r.icon}</span>
                  <span className="welcome-role-title">{pick(r.title)}</span>
                  <span className="welcome-role-desc">{pick(r.description)}</span>
                </button>
              ))}
            </div>
            <div className="welcome-actions">
              <button type="button" onClick={() => go("hello")}>{L("חזרה", "Back")}</button>
              <span className="grow muted small">{roles.length ? L(`נבחרו ${roles.length}`, `${roles.length} picked`) : ""}</span>
              <button type="button" className="primary" disabled={!roles.length} onClick={() => go("tools")}>{L("המשך", "Continue")}</button>
            </div>
          </section>
        )}

        {step === "tools" && (
          <section className="welcome-body">
            <h2>{L("עם אילו כלים להתחיל?", "Which tools to start with?")}</h2>
            <p className="welcome-lead">{L("כלי כבוי לא נטען ולא תופס זיכרון. מה שצריך הורדה יורד רק כשמשתמשים בו לראשונה.", "A tool that is off does not load or use memory. What needs a download gets it only the first time you use it.")}</p>
            <nav className="welcome-cats" aria-label={L("קטגוריות", "Categories")}>
              {TOOL_GROUPS.map((g) => {
                const n = g.parts.filter((id) => choice[id]).length;
                return (
                  <a key={g.id} href={`#wt-${g.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`wt-${g.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                    <span aria-hidden="true">{g.icon}</span> {pick(g.title)} <small>{n}/{g.parts.length}</small>
                  </a>
                );
              })}
            </nav>
            <div className="welcome-tools-scroll">
              {/* The groups the picked roles turned on come first; the rest stay below, nothing is hidden. */}
              {[...TOOL_GROUPS].sort((a, b) => Number(!a.parts.some((id) => choice[id])) - Number(!b.parts.some((id) => choice[id]))).map((g) => {
                const items = g.parts.map((id) => parts.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
                if (!items.length) return null;
                const allOn = items.every((p) => choice[p.id]);
                return (
                  <section key={g.id} id={`wt-${g.id}`} className="welcome-cat">
                    <header>
                      <h3><span aria-hidden="true">{g.icon}</span> {pick(g.title)}</h3>
                      <button type="button" className="link-btn" onClick={() => setChoice({ ...choice, ...Object.fromEntries(items.map((p) => [p.id, !allOn])) })}>{allOn ? L("כבה הכל", "Turn all off") : L("הפעל הכל", "Turn all on")}</button>
                    </header>
                    <div className="welcome-tools">
                      {items.map((p) => (
                        <label key={p.id} className={`welcome-tool${choice[p.id] ? " on" : ""}`}>
                          <input type="checkbox" checked={!!choice[p.id]} onChange={(e) => setChoice({ ...choice, [p.id]: e.target.checked })} />
                          <span className="welcome-tool-icon" aria-hidden="true">{p.icon}</span>
                          <span className="welcome-tool-text">
                            <b>{pick(p.title)}</b>
                            <small>{pick(p.description)}</small>
                          </span>
                          {p.downloadGb > 0 && <span className="welcome-tool-size">{`\u2066${p.downloadGb < 1 ? `${Math.round(p.downloadGb * 1000)} MB` : `${p.downloadGb} GB`}\u2069`}</span>}
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="welcome-actions">
              <button type="button" onClick={() => go("role")}>{L("חזרה", "Back")}</button>
              <span className="grow muted small">{gb > 0 ? L(`עד כ-\u2066${gb.toFixed(1)} GB\u2069, רק כשמשתמשים`, `Up to about ${gb.toFixed(1)} GB, only when used`) : ""}</span>
              <button type="button" className="primary" onClick={() => go("models")}>{L("המשך", "Continue")}</button>
            </div>
          </section>
        )}

        {step === "models" && <ModelsStep roles={roles} onBack={() => go("tools")} onNext={() => go("start")} />}

        {step === "start" && (
          <section className="welcome-body">
            <h2>{L("מוכן. במה נתחיל?", "Ready. What first?")}</h2>
            <p className="welcome-lead">{L("לחץ על רעיון והוא יחכה לך בתיבת ההודעה. הרעיונות האלה נשארים גם במסך הפתיחה.", "Tap an idea and it waits for you in the message box. These ideas stay on the start screen too.")}</p>
            <div className="welcome-prompts">
              {(mixRoles(roles)?.ideas[getLocale() === "he" ? "he" : "en"] ?? []).map((idea) => (
                <button key={idea} type="button" className="welcome-prompt" dir="auto" disabled={saving} onClick={() => void finish(false, idea)}>{idea}</button>
              ))}
            </div>
            {!isRemote() && (
              <>
                <h3 className="welcome-sub">{L("לעבוד גם מהטלפון?", "Work from your phone too?")}</h3>
                <p className="welcome-lead">{L("אפליקציית הטלפון מתחברת למחשב הזה. חשבון Google עוזר לה למצוא אותו מכל מקום; אפשר גם בלי חשבון, עם קוד QR.", "The phone app connects to this computer. A Google account helps it find it from anywhere; you can also skip the account and use a QR code.")}</p>
                <div className="welcome-options">
                  {info.google.configured && (
                    <button type="button" className="welcome-option" onClick={() => void google()} disabled={info.google.connected}>
                      <span aria-hidden="true">🔐</span>
                      <b>{info.google.connected ? L("מחובר ל-Google", "Signed in with Google") : L("התחבר עם Google", "Sign in with Google")}</b>
                      <small>{L("הטלפון ימצא את המחשב לבד, והפרויקטים יגובו ל-Drive.", "The phone finds this computer by itself, and projects back up to Drive.")}</small>
                    </button>
                  )}
                  <button type="button" className="welcome-option" onClick={() => { void finish().then(() => (location.hash = "#/settings/phone")); }}>
                    <span aria-hidden="true">📱</span>
                    <b>{L("חבר טלפון עכשיו", "Connect a phone now")}</b>
                    <small>{L("פותח את ההגדרות עם קוד QR ואפליקציה להורדה.", "Opens Settings with a QR code and the app to download.")}</small>
                  </button>
                </div>
              </>
            )}
            <div className="welcome-actions">
              <button type="button" onClick={() => go("models")}>{L("חזרה", "Back")}</button>
              <span className="grow" />
              <button type="button" className="primary" disabled={saving} onClick={() => void finish()}>{L("סיום", "Done")}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** GET /api/welcome/check: this computer and the starter models for the picked roles. */
interface WelcomeCheck {
  gpu: { name: string; vramGb: number } | null;
  ramGb: number | null;
  unified: boolean;
  drives: Array<{ id: string; dir: string; freeGb?: number; totalGb?: number; default: boolean }>;
  picks: Array<{ id: string; fit: "gpu" | "partial" | "too-big" | "unknown"; gpuShare: number; why: "best" | "fast" | "hebrew" }>;
}

const gb = (n: number) => `⁦${n < 10 ? n.toFixed(1) : Math.round(n)} GB⁩`;

/**
 * The welcome's hardware step: the graphics card, memory and the drive models go to (the heavy-data drive when
 * there is one), and 1–3 chat models that fit, each with its run mark and a one-tap download. Downloads run in the
 * background (the downloads circle), so the welcome can go on at once. Works from the phone: the computer downloads.
 */
function ModelsStep({ roles, onBack, onNext }: { roles: string[]; onBack: () => void; onNext: () => void }) {
  const [check, setCheck] = useState<WelcomeCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const [have, setHave] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<Record<string, "busy" | "started" | string>>({});
  useEffect(() => {
    void api<WelcomeCheck>(`/api/welcome/check?roles=${encodeURIComponent(roles.join(","))}&lang=${getLocale()}`).then(setCheck, () => setFailed(true));
    void api<Array<{ id: string; downloaded: boolean }>>("/api/models/recommended").then((list) => setHave(Object.fromEntries(list.map((m) => [m.id, m.downloaded]))), () => undefined);
  }, [roles]);
  const drive = check?.drives.find((d) => d.default) ?? check?.drives[0];
  /** Finds the model's file in its repo and starts the download to the default drive (the heavy-data one first). */
  const download = async (id: string) => {
    const m = RECOMMENDED_MODELS.find((x) => x.id === id);
    if (!m) return;
    setState((s) => ({ ...s, [id]: "busy" }));
    try {
      const files = await api<Array<{ path: string }>>(`/api/hub/files?repo=${encodeURIComponent(m.repo)}`);
      const file = files.find((f) => new RegExp(m.filePattern, "i").test(f.path));
      if (!file) throw new Error(L("הקובץ לא נמצא במאגר.", "The file was not found in the repo."));
      await api("/api/downloads", { method: "POST", body: { repo: m.repo, path: file.path, category: "chat", ...(drive ? { drive: drive.id } : {}) } });
      setState((s) => ({ ...s, [id]: "started" }));
    } catch (e) {
      setState((s) => ({ ...s, [id]: (e as Error).message || L("ההורדה לא התחילה.", "The download did not start.") }));
    }
  };
  const why = (w: WelcomeCheck["picks"][number]["why"]) =>
    w === "best" ? L("הכי חזק שמתאים למחשב הזה", "The strongest that suits this computer") : w === "hebrew" ? L("הכי טוב בעברית", "Best in Hebrew") : L("קטן ומהיר, לתשובות זריזות", "Small and quick, for fast answers");
  const mark = (p: WelcomeCheck["picks"][number]) =>
    p.fit === "gpu" ? <span className="pill good hub-fit">🟢 {L("כולו על כרטיס המסך", "Runs fully on GPU")}</span>
      : p.fit === "partial" ? <span className="pill warn hub-fit" title={L(`${Math.round(p.gpuShare * 100)}% בכרטיס, השאר בזיכרון הרגיל`, `${Math.round(p.gpuShare * 100)}% on the GPU, the rest in system memory`)}>🟡 {L("חלקית על הכרטיס (איטי יותר)", "Partly on GPU (slower)")}</span>
      : null;

  return (
    <section className="welcome-body">
      <h2>{L("המחשב שלך, והמודלים שמתאימים לו", "Your computer, and the models that suit it")}</h2>
      {!check && !failed && <p className="welcome-lead" aria-busy="true">{L("בודק את כרטיס המסך, הזיכרון והדיסקים…", "Checking the graphics card, memory and disks…")}</p>}
      {failed && <p className="welcome-lead">{L("לא הצלחתי לבדוק את המחשב. אפשר להוריד מודלים מתי שרוצים בעמוד המודלים.", "Could not check the computer. You can download models any time on the Models page.")}</p>}
      {check && (
        <>
          <ul className="welcome-hw" aria-label={L("המחשב הזה", "This computer")}>
            <li><span aria-hidden="true">🎮</span><b>{check.gpu ? check.gpu.name : check.unified ? L("זיכרון משותף (Apple)", "Shared memory (Apple)") : L("אין כרטיס מסך נפרד", "No separate graphics card")}</b>{check.gpu && <small>{L(`זיכרון גרפי ${gb(check.gpu.vramGb)}`, `${gb(check.gpu.vramGb)} video memory`)}</small>}</li>
            {check.ramGb !== null && <li><span aria-hidden="true">🧠</span><b>{L("זיכרון", "Memory")}</b><small>{gb(check.ramGb)}</small></li>}
            {check.drives.map((d) => (
              <li key={d.id}>
                <span aria-hidden="true">💽</span>
                <b>{d.id === "heavy" ? L("כונן הנתונים הכבדים", "Heavy-data drive") : L("תיקיית ההורדות", "Downloads folder")}{d.default ? ` · ${L("לשם יורד", "saves here")}` : ""}</b>
                <small><span dir="ltr" className="welcome-path">{d.dir}</span>{d.freeGb !== undefined ? ` · ${L(`${gb(d.freeGb)} פנויים`, `${gb(d.freeGb)} free`)}` : ""}</small>
              </li>
            ))}
          </ul>
          {check.picks.length === 0 ? (
            <p className="welcome-lead">{L("המודלים המקומיים כבדים מדי למחשב הזה. אפשר לחבר מודל בענן בהגדרות ← חשבונות.", "Local models are too heavy for this computer. You can connect a cloud model in Settings → Accounts.")}</p>
          ) : (
            <div className="welcome-models">
              {check.picks.map((p) => {
                const m = RECOMMENDED_MODELS.find((x) => x.id === p.id);
                if (!m) return null;
                const st = state[p.id];
                const tooBig = drive?.freeGb !== undefined && drive.freeGb < m.sizeGb + 1;
                return (
                  <div key={p.id} className="welcome-model">
                    <div className="welcome-model-text">
                      <b dir="auto">{m.name}</b>
                      <small className="welcome-model-why">{why(p.why)} · {gb(m.sizeGb)}</small>
                      {mark(p)}
                      <small>{getLocale() === "he" ? (m.note.he ?? m.note.en) : m.note.en}</small>
                    </div>
                    {have[p.id] ? <span className="pill good">{L("כבר במחשב", "On this computer")}</span>
                      : st === "started" ? <span className="pill">{L("יורד ברקע", "Downloading")}</span>
                      : <button type="button" className="primary" disabled={st === "busy" || tooBig} title={tooBig ? L("אין מספיק מקום בדיסק", "Not enough disk space") : undefined} onClick={() => void download(p.id)}>{st === "busy" ? L("מתחיל…", "Starting…") : L("הורד", "Download")}</button>}
                    {st && st !== "busy" && st !== "started" && <small className="error welcome-model-error">{st}</small>}
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted small">{L("ההורדה ממשיכה ברקע; אפשר לעקוב בעיגול ההורדות ולהמשיך כבר עכשיו.", "Downloads go on in the background; follow them in the downloads circle and carry on now.")}</p>
        </>
      )}
      <div className="welcome-actions">
        <button type="button" onClick={onBack}>{L("חזרה", "Back")}</button>
        <span className="grow" />
        <button type="button" className="primary" onClick={onNext}>{L("המשך", "Continue")}</button>
      </div>
    </section>
  );
}
