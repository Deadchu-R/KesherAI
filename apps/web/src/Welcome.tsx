import { useEffect, useState } from "react";
import { ROLES, partsForRole, type RoleDefinition } from "@kesher/shared";
import { api } from "./api";
import { getLocale, setLocale } from "./i18n";
import { setParts, useParts } from "./parts";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const pick = <T,>(v: { en: T; he: T }) => (getLocale() === "he" ? v.he : v.en);

interface Onboarding { done: boolean; role?: string; show: boolean; google: { configured: boolean; connected: boolean }; remote: { enabled: boolean } }

/** Opens the welcome again (Settings → "Show the welcome again"). */
export function openWelcome(): void {
  dispatchEvent(new Event("kesher-welcome"));
}

/** The role picked in the welcome, for the start screen's ideas. */
export function useRole(): RoleDefinition | undefined {
  const [role, setRole] = useState<string | undefined>();
  useEffect(() => {
    void api<Onboarding>("/api/onboarding").then((o) => setRole(o.role), () => undefined);
  }, []);
  return ROLES.find((r) => r.id === role);
}

/** The tool groups of the welcome (the same as the menu's). */
const TOOL_GROUPS: Array<{ id: string; icon: string; title: { en: string; he: string }; parts: string[] }> = [
  { id: "create", icon: "🎨", title: { en: "Create", he: "יצירה" }, parts: ["images", "video", "image-editor", "nodes"] },
  { id: "games", icon: "🎮", title: { en: "Game engines", he: "מנועי משחק" }, parts: ["unreal", "unity"] },
  { id: "work", icon: "🧠", title: { en: "Work and knowledge", he: "עבודה וידע" }, parts: ["pages", "knowledge", "day", "compare", "pipelines"] },
  { id: "agent", icon: "🖥", title: { en: "The agent on your computer", he: "הסוכן במחשב שלך" }, parts: ["browser", "watch"] },
  { id: "assistant", icon: "🤖", title: { en: "Voice and community", he: "קול וקהילה" }, parts: ["voice", "community"] },
];

const STEPS = ["hello", "role", "tools", "phone"] as const;
type Step = (typeof STEPS)[number];

/**
 * The first-run welcome: what KesherAI is, what fits you (a role), which
 * tools to start with, and whether to sign in so the phone can find this
 * computer. Shows once, on the computer, before the first chat; every
 * answer can be changed later (Parts, Settings).
 */
export function Welcome({ onLocale }: { onLocale: () => void }) {
  const [info, setInfo] = useState<Onboarding | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("hello");
  const [role, setRole] = useState<string>("");
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const { parts } = useParts();

  useEffect(() => {
    void api<Onboarding>("/api/onboarding").then((o) => {
      setInfo(o);
      if (o.show) setOpen(true);
      if (o.role) setRole(o.role);
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
  const chooseRole = (id: string) => {
    setRole(id);
    setChoice(partsForRole(id));
    go("tools");
  };
  /** Saves the answers. Skipping keeps everything as it is now. */
  const finish = async (skip = false) => {
    setSaving(true);
    try {
      if (!skip && Object.keys(choice).length) await setParts({ parts: choice });
      await api("/api/onboarding", { method: "PUT", body: { done: true, ...(role ? { role } : {}) } });
    } catch {
      // the welcome closes anyway; Settings has everything
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };
  const gb = parts.filter((p) => choice[p.id]).reduce((n, p) => n + p.downloadGb, 0);
  const google = async () => {
    try {
      const { url } = await api<{ url: string }>("/api/google/connect", { method: "POST", body: {} });
      window.open(url, "_blank", "noopener");
    } catch {
      location.hash = "#/settings";
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
            <div className="welcome-mark" aria-hidden="true">
              <span />
              <span />
            </div>
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
            <h2>{L("מה הכי מתאים לך?", "What fits you best?")}</h2>
            <p className="welcome-lead">{L("זה קובע עם אילו כלים מתחילים ואילו רעיונות יופיעו. אפשר לשנות כל הזמן.", "It sets which tools you start with and the ideas you see. You can change it any time.")}</p>
            <div className="welcome-roles">
              {ROLES.map((r) => (
                <button key={r.id} type="button" className={`welcome-role${role === r.id ? " on" : ""}`} onClick={() => chooseRole(r.id)}>
                  <span className="welcome-role-icon" aria-hidden="true">{r.icon}</span>
                  <span className="welcome-role-title">{pick(r.title)}</span>
                  <span className="welcome-role-desc">{pick(r.description)}</span>
                </button>
              ))}
            </div>
            <div className="welcome-actions"><button type="button" onClick={() => go("hello")}>{L("חזרה", "Back")}</button></div>
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
              {TOOL_GROUPS.map((g) => {
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
              <button type="button" className="primary" onClick={() => go("phone")}>{L("המשך", "Continue")}</button>
            </div>
          </section>
        )}

        {step === "phone" && (
          <section className="welcome-body">
            <h2>{L("לעבוד גם מהטלפון?", "Work from your phone too?")}</h2>
            <p className="welcome-lead">{L("אפליקציית הטלפון מתחברת למחשב הזה. חשבון Google עוזר לה למצוא אותו מכל מקום; אפשר גם בלי חשבון, עם קוד QR.", "The phone app connects to this computer. A Google account helps it find it from anywhere; you can also skip the account and use a QR code.")}</p>
            <div className="welcome-options">
              {info.google.configured && (
                <button type="button" className="welcome-option" onClick={() => void google()} disabled={info.google.connected}>
                  <span aria-hidden="true">🔐</span>
                  <b>{info.google.connected ? L("מחובר ל-Google", "Signed in with Google") : L("התחבר עם Google", "Sign in with Google")}</b>
                  <small>{L("הטלפון ימצא את המחשב לבד, והפרויקטים יגובו ל-Drive.", "The phone finds this computer by itself, and projects back up to Drive.")}</small>
                </button>
              )}
              <button type="button" className="welcome-option" onClick={() => { void finish().then(() => (location.hash = "#/settings")); }}>
                <span aria-hidden="true">📱</span>
                <b>{L("חבר טלפון עכשיו", "Connect a phone now")}</b>
                <small>{L("פותח את ההגדרות עם קוד QR ואפליקציה להורדה.", "Opens Settings with a QR code and the app to download.")}</small>
              </button>
              <button type="button" className="welcome-option" onClick={() => void finish()}>
                <span aria-hidden="true">🖥</span>
                <b>{L("רק במחשב, בינתיים", "Just this computer, for now")}</b>
                <small>{L("אפשר לחבר טלפון מתי שרוצים: הגדרות ← טלפון.", "Connect a phone whenever you like: Settings → Phone.")}</small>
              </button>
            </div>
            <div className="welcome-actions">
              <button type="button" onClick={() => go("tools")}>{L("חזרה", "Back")}</button>
              <span className="grow" />
              <button type="button" className="primary" disabled={saving} onClick={() => void finish()}>{L("סיום", "Done")}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
