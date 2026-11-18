import { useEffect, useState } from "react";
import { STUDY_FIELDS, SETUP_STEPS, type ReadClass, type SetupStep, type StudyCourse, type StudyPrefs } from "@kesher/shared";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The fields offered first (the rest are under "More fields"), with an icon each. */
const FIELD_ICONS: Record<string, string> = { nursing: "🩺", medicine: "⚕️", law: "⚖️", engineering: "📐", cs: "💻", psychology: "🧠", economics: "💼", math: "➗", biology: "🧬", education: "🍎", humanities: "📜", gamedev: "🎮" };
const FIRST_FIELDS = ["nursing", "medicine", "law", "engineering", "cs", "psychology", "economics"];

interface ModelStatus {
  chat: { ready: boolean; name?: string; hebrew: boolean };
  suggest?: { id: string; name: string; sizeGb: number };
  /** With a chat model that is not Dicta's: the Hebrew one, to offer beside it. */
  hebrew?: { id: string; name: string; sizeGb: number };
  stt?: { ready: boolean; busy: boolean; name: string; sizeGb: number; setup: string | null };
}
type Recommended = { id: string; name: string; sizeGb: number; downloaded: boolean; estimate?: { rating: string } };

/**
 * Whether this computer can do Study's work: a chat model (DictaLM, Dicta's Hebrew model, is the best for Hebrew;
 * any chosen chat model works) and speech-to-text for recordings. With no chat model, the largest recommended model
 * that runs well here is suggested; nothing is downloaded until she taps.
 */
export function useModelStatus(on = true): [ModelStatus | null, () => void] {
  const [st, setSt] = useState<ModelStatus | null>(null);
  const load = () => {
    if (!on) return;
    void Promise.all([
      api<{ activeModels?: Record<string, string> }>("/api/settings").catch(() => ({ activeModels: {} as Record<string, string> })),
      api<Array<{ name: string; gguf?: boolean }>>("/api/models/local").catch(() => []),
      api<Recommended[]>("/api/models/recommended").catch(() => []),
      api<Record<string, { ready: boolean; busy?: boolean; name: string; sizeGb: number; setup?: string | null }>>("/api/models/kinds").catch(() => null),
    ]).then(([settings, local, rec, kinds]) => {
      const dicta = local.find((m) => /dictalm/i.test(m.name));
      const active = settings.activeModels?.chat;
      const ready = !!dicta || !!active;
      const rank = (r?: string) => (r === "good" ? 0 : r === "ok" ? 1 : 9);
      const dictaOffer = rec.find((m) => m.id === "dictalm-12b" && !m.downloaded && rank(m.estimate?.rating) < 9);
      // A Hebrew student with no model yet: Dicta's Hebrew model first, when it runs here (a fresh profile was offered
      // gpt-oss 20B, 12 GB, while DictaLM 12B is smaller and writes far better Hebrew; 2026-11-18).
      const pick = (getLocale() === "he" ? dictaOffer : undefined) ?? [...rec].filter((m) => !m.downloaded && rank(m.estimate?.rating) < 9).sort((a, b) => rank(a.estimate?.rating) - rank(b.estimate?.rating) || b.sizeGb - a.sizeGb)[0];
      const stt = kinds?.["speech-to-text"];
      setSt({
        chat: { ready, ...(dicta || active ? { name: dicta?.name ?? active!.split("/").pop()! } : {}), hebrew: !!dicta },
        ...(!ready && pick ? { suggest: { id: pick.id, name: pick.name, sizeGb: pick.sizeGb } } : {}),
        ...(ready && !dicta && dictaOffer ? { hebrew: { id: dictaOffer.id, name: dictaOffer.name, sizeGb: dictaOffer.sizeGb } } : {}),
        ...(stt ? { stt: { ready: stt.ready, busy: !!stt.busy, name: stt.name, sizeGb: stt.sizeGb, setup: stt.setup ?? null } } : {}),
      });
    });
  };
  useEffect(load, [on]);
  return [st, load];
}

/** The model check, as a step of the wizard and as items of the checklist. */
function ModelCheck({ st, reload }: { st: ModelStatus | null; reload: () => void }) {
  const [started, setStarted] = useState<string[]>([]);
  if (!st) return <p className="muted">{L("בודק מה יש במחשב…", "Checking this computer…")}</p>;
  const start = async (what: string, url: string) => {
    try {
      await api(url, { method: "POST" });
      setStarted((s) => [...s, what]);
      toast(L("ההורדה התחילה. אפשר להמשיך, היא תמשיך ברקע.", "The download started. You can go on; it continues in the background."));
      window.setTimeout(reload, 4000);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="study-setup-checks">
      <div className={`study-setup-check${st.chat.ready ? " ok" : ""}`}>
        <b>{st.chat.ready ? "✅" : "⬜"} {L("מודל שמבין ועונה", "A model that understands and answers")}</b>
        {st.chat.ready ? (
          <>
            <span className="small" dir="auto">{st.chat.name}{st.chat.hebrew ? L(" — מצוין בעברית", " — excellent in Hebrew") : L(" — עובד.", " — works.")}</span>
            {st.hebrew && <><span className="small">{L(`לעברית הכי טובה: ${st.hebrew.name} של דיקטה · ‏${st.hebrew.sizeGb}GB, ירוץ טוב במחשב הזה.`, `For the best Hebrew: Dicta's ${st.hebrew.name} · ${st.hebrew.sizeGb} GB; it runs well on this computer.`)}</span>
              <button type="button" disabled={started.includes("hebrew")} onClick={() => void start("hebrew", `/api/models/recommended/${st.hebrew!.id}/run`)}>{started.includes("hebrew") ? L("✓ יורד ברקע", "✓ Downloading") : L(`⬇ להוסיף את DictaLM (${st.hebrew.sizeGb}GB)`, `⬇ Add DictaLM (${st.hebrew.sizeGb} GB)`)}</button></>}
          </>
        ) : st.suggest ? (
          <>
            <span className="small">{/dictalm/i.test(st.suggest.id) ? L(`מוצע: ${st.suggest.name} של דיקטה, הכי טוב בעברית · ‏${st.suggest.sizeGb}GB. ירוץ טוב במחשב הזה.`, `Suggested: Dicta's ${st.suggest.name}, the best in Hebrew · ${st.suggest.sizeGb} GB. It runs well on this computer.`) : L(`מוצע: ${st.suggest.name} · ‏${st.suggest.sizeGb}GB. ירוץ טוב במחשב הזה.`, `Suggested: ${st.suggest.name} · ${st.suggest.sizeGb} GB. It runs well on this computer.`)}</span>
            <button type="button" disabled={started.includes("chat")} onClick={() => void start("chat", `/api/models/recommended/${st.suggest!.id}/run`)}>{started.includes("chat") ? L("✓ יורד ברקע", "✓ Downloading") : L(`⬇ להוריד (${st.suggest.sizeGb}GB)`, `⬇ Download (${st.suggest.sizeGb} GB)`)}</button>
          </>
        ) : (
          <a className="small" href="#/models">{L("לבחור מודל בעמוד המודלים ›", "Choose a model on the Models page ›")}</a>
        )}
      </div>
      {st.stt && (
        <div className={`study-setup-check${st.stt.ready ? " ok" : ""}`}>
          <b>{st.stt.ready ? "✅" : "⬜"} {L("תמלול הקלטות", "Transcribing recordings")}</b>
          {st.stt.ready ? <span className="small">{st.stt.name}</span> : st.stt.busy || started.includes("stt") ? <span className="small">{L("✓ יורד ברקע", "✓ Downloading")}</span> : st.stt.setup ? (
            <>
              <span className="small">{L(`כדי להקליט הרצאות ולקבל טקסט. ${st.stt.name} · ‏${Math.round(st.stt.sizeGb * 10) / 10}GB`, `To record lectures and get the text. ${st.stt.name} · ${Math.round(st.stt.sizeGb * 10) / 10} GB`)}</span>
              <button type="button" onClick={() => void start("stt", st.stt!.setup!)}>{L(`⬇ להוריד (${Math.round(st.stt.sizeGb * 10) / 10}GB)`, `⬇ Download (${Math.round(st.stt.sizeGb * 10) / 10} GB)`)}</button>
            </>
          ) : <span className="small muted">{L("לא זמין במחשב הזה; אפשר להעלות קבצים וטקסט.", "Not available on this computer; files and text still work.")}</span>}
        </div>
      )}
      <p className="muted small">{L("ההורדה מתחילה רק כשלוחצים, ואפשר להמשיך בינתיים.", "A download starts only when you tap, and you can go on meanwhile.")}</p>
    </div>
  );
}

/** One tap that starts a model download (its size on the button), then says it is downloading. */
function DownloadButton({ url, sizeGb, onStarted }: { url: string; sizeGb: number; onStarted: () => void }) {
  const [on, setOn] = useState(false);
  if (on) return <span className="small">{L("✓ יורד ברקע", "✓ Downloading")}</span>;
  return <button type="button" onClick={() => void api(url, { method: "POST" }).then(() => { setOn(true); window.setTimeout(onStarted, 4000); }, (e: Error) => toast(e.message))}>{L(`⬇ להוריד (${sizeGb}GB)`, `⬇ Download (${sizeGb} GB)`)}</button>;
}

/**
 * The first visit to Study (design StudySetupWizard, students part 38): four short steps, each saying why it asks:
 * her field, her courses (all from a timetable photo, or the first by name), whether this computer can do the work
 * (models), and the first lecture. Every step can be skipped (it stays on the "Getting started" list); the step is
 * saved, so leaving and coming back resumes there. The goal, the phone and the view are on the list afterwards.
 */
export function StudyWelcome({ prefs, onPrefs, onSkip, onDone }: { prefs: StudyPrefs; onPrefs: (p: StudyPrefs) => void; onSkip: () => void; onDone?: () => void }) {
  const [step, setStepState] = useState(prefs.setupStep);
  const [field, setField] = useState(prefs.field ?? "");
  const [year, setYear] = useState(prefs.year ?? 0);
  const [moreFields, setMoreFields] = useState(!!prefs.field && !FIRST_FIELDS.includes(prefs.field));
  const [name, setName] = useState("");
  const [exam, setExam] = useState("");
  const [busy, setBusy] = useState(false);
  const [courses, setCourses] = useState<StudyCourse[]>([]);
  const [reading, setReading] = useState(false);
  const [models, reloadModels] = useModelStatus();
  useEffect(() => void api<{ courses: StudyCourse[] }>("/api/study").then((r) => setCourses(r.courses), () => undefined), []);
  const save = async (change: Partial<StudyPrefs>) => {
    const next = await api<StudyPrefs>("/api/study/prefs", { method: "PUT", body: change }).catch(() => ({ ...prefs, ...change }));
    onPrefs(next);
    return next;
  };
  const go = (to: number, skipped?: SetupStep) => {
    setStepState(to);
    const list = skipped ? [...new Set([...prefs.setupSkipped, skipped])] : prefs.setupSkipped.filter((s) => s !== SETUP_STEPS[step]);
    void save({ setupStep: Math.min(to, SETUP_STEPS.length - 1), setupSkipped: list });
    // Focus moves to the new step's heading, for the keyboard and screen readers.
    window.setTimeout(() => document.querySelector<HTMLElement>(".study-setup h2")?.focus(), 50);
  };
  const fromPhoto = async (f: File | undefined) => {
    if (!f) return;
    setReading(true);
    try {
      const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => bad(r.error); r.readAsDataURL(f); });
      const { classes } = await api<{ classes: ReadClass[] }>("/api/study/timetable/photo", { method: "POST", body: { image: data, mime: f.type || "image/jpeg" } });
      if (!classes.length) return toast(L("לא נמצאו שיעורים בצילום. נסי צילום מסך מהפורטל, או כתבי קורס אחד.", "No classes were found. Try a screenshot from the portal, or type one course."));
      const made: StudyCourse[] = [];
      for (const n of [...new Set(classes.map((c) => c.name.trim()))].slice(0, 20)) made.push(await api<StudyCourse>("/api/study/courses", { method: "POST", body: { name: n } }));
      const byName = new Map(made.map((c) => [c.name.trim(), c.id]));
      await api("/api/study/timetable", { method: "PUT", body: { slots: classes.map((c, i) => ({ id: `w${i}`, courseId: byName.get(c.name.trim()), day: c.day, start: c.start, end: c.end, ...(c.room ? { room: c.room } : {}), ...(c.kind ? { kind: c.kind } : {}) })) } });
      setCourses((c) => [...c, ...made]);
      toast(L(`נוצרו ${made.length} קורסים ו-${classes.length} שיעורים במערכת`, `${made.length} courses and ${classes.length} classes made`));
      go(2);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  const addCourse = async () => {
    if (!name.trim()) return go(2, courses.length ? undefined : "courses");
    setBusy(true);
    try {
      const c = await api<StudyCourse>("/api/study/courses", { method: "POST", body: { name: name.trim() } });
      if (exam) await api(`/api/study/courses/${c.id}`, { method: "PATCH", body: { examDate: exam } }).catch(() => undefined);
      setCourses((list) => [...list, c]);
      setName("");
      setExam("");
      go(2);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** The end: simple view on, the setup closed, and then where she chose to go. */
  const finish = async (to: "record" | "file" | "later") => {
    setBusy(true);
    await save({ simple: true, welcomed: true, setupStep: 0 });
    setBusy(false);
    const first = courses[0];
    // Staying on Study's home: its course list is reloaded (the hash does not change, so nothing else would; a fresh
    // profile ended on the empty "how it works" page with its new course missing, 2026-11-18).
    if (!first || to === "later") { onDone?.(); location.hash = "#/study"; return; }
    location.hash = to === "record" ? `#/study/${first.id}?record=1` : `#/study/${first.id}`;
  };
  const total = SETUP_STEPS.length;
  const nav = (next: () => void, nextLabel: string, skip: SetupStep, disabled = false) => (
    <div className="row wrap study-setup-nav">
      <button type="button" className="primary" disabled={disabled || busy} onClick={next}>{busy ? "…" : nextLabel}</button>
      {step > 0 && <button type="button" className="link" onClick={() => go(step - 1)}>{L("‹ חזרה", "‹ Back")}</button>}
      <button type="button" className="link study-setup-skip" onClick={() => (step === total - 1 ? void finish("later") : go(step + 1, skip))}>{L("לדלג על השלב (יישאר ברשימה)", "Skip this step (it stays on the list)")}</button>
    </div>
  );
  return (
    <section className="card study-setup" aria-label={L("הגדרה ראשונה של הלימודים", "First setup of Study")}>
      <div className="study-setup-progress">
        <span className="muted small" aria-live="polite">{L(`שלב ${step + 1} מתוך ${total}`, `Step ${step + 1} of ${total}`)}</span>
        <ol aria-hidden="true">{SETUP_STEPS.map((s, i) => <li key={s} className={i <= step ? "on" : ""} />)}</ol>
        <button type="button" className="link small" onClick={onSkip}>{L("לסגור, אסתדר לבד", "Close, I'll find my way")}</button>
      </div>
      {step === 0 && (
        <div className="study-setup-body">
          <h2 tabIndex={-1}>🎓 {L("מה את לומדת?", "What do you study?")}</h2>
          <p className="muted">{L("ככה הכלים והמילים יתאימו לתחום שלך: מחשבוני תרופות לסיעוד, ניתוח מקרים למשפטים, נוסחאות להנדסה.", "So the tools and words fit your field: medication calculators for nursing, case analysis for law, formulas for engineering.")}</p>
          <div className="study-welcome-opts" role="radiogroup" aria-label={L("תחום", "Field")}>
            {STUDY_FIELDS.filter((f) => moreFields || FIRST_FIELDS.includes(f.id) || f.id === field).map((f) => (
              <button type="button" key={f.id} role="radio" aria-checked={field === f.id} className={field === f.id ? "on" : ""} onClick={() => setField(f.id)}>{field === f.id ? "✓ " : ""}{FIELD_ICONS[f.id] ?? "📘"} {getLocale() === "he" ? f.he : f.en}</button>
            ))}
            {!moreFields && <button type="button" className="link" onClick={() => setMoreFields(true)}>{L("עוד תחומים…", "More fields…")}</button>}
          </div>
          <span className="small">{L("באיזו שנה? (לא חובה)", "Which year? (optional)")}</span>
          <div className="study-welcome-opts" role="radiogroup" aria-label={L("שנה", "Year")}>
            {[1, 2, 3, 4].map((y) => <button type="button" key={y} role="radio" aria-checked={year === y} className={year === y ? "on" : ""} onClick={() => setYear(year === y ? 0 : y)}>{year === y ? "✓ " : ""}{L(["א׳", "ב׳", "ג׳", "ד׳ ומעלה"][y - 1]!, ["1st", "2nd", "3rd", "4th+"][y - 1]!)}</button>)}
          </div>
          {nav(() => { void save({ ...(field ? { field } : {}), ...(year ? { year } : {}) }); go(1, field ? undefined : "field"); }, L("הבא ›", "Next ›"), "field")}
        </div>
      )}
      {step === 1 && (
        <div className="study-setup-body">
          <h2 tabIndex={-1}>📚 {L("הקורסים שלך", "Your courses")}</h2>
          <p className="muted">{L("לכל קורס יש הרצאות, כרטיסיות ובוחנים משלו. הכי מהיר: צילום של מערכת השעות.", "Each course has its own lectures, cards and quizzes. Fastest: a photo of your timetable.")}</p>
          <label className={`button primary study-setup-big${reading ? " disabled" : ""}`}>
            {reading ? L("קורא את המערכת… (עד דקה)", "Reading the timetable… (up to a minute)") : L("📷 כל הקורסים מצילום מערכת השעות", "📷 All my courses from a photo of the timetable")}
            <input type="file" accept="image/*" hidden disabled={reading} onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <span className="muted small">{L("צילום מסך מהפורטל או צילום של הדף. כל קורס נפתח לבד, והשיעורים נכנסים למערכת השעות.", "A screenshot from the portal or a photo of the page. Each course is opened for you, and the classes go into the timetable.")}</span>
          <form className="study-setup-or" onSubmit={(e) => { e.preventDefault(); void addCourse(); }}>
            <span className="small">{L("או קורס אחד בכל פעם:", "Or one course at a time:")}</span>
            <label>{L("שם הקורס", "Course name")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={L("למשל: פרמקולוגיה", "e.g. Pharmacology")} dir="auto" /></label>
            <label>{L("מתי המבחן? (לא חובה, בשביל תכנית חזרה)", "When is the exam? (optional, for a review plan)")}<input type="date" value={exam} onChange={(e) => setExam(e.target.value)} /></label>
            {courses.length > 0 && <p className="small">✅ {L(`יש לך ${courses.length} קורסים: `, `You have ${courses.length} courses: `)}<span dir="auto">{courses.slice(0, 6).map((c) => c.name).join(" · ")}{courses.length > 6 ? " …" : ""}</span></p>}
          </form>
          {nav(() => void addCourse(), name.trim() ? L("להוסיף ולהמשיך ›", "Add and go on ›") : L("הבא ›", "Next ›"), "courses", !name.trim() && !courses.length)}
        </div>
      )}
      {step === 2 && (
        <div className="study-setup-body">
          <h2 tabIndex={-1}>💻 {L("האם זה יעבוד במחשב הזה?", "Will it work on this computer?")}</h2>
          {isRemote() && <p className="small">{L("(המחשב שהטלפון מחובר אליו: שם רצים המודלים.)", "(The computer this phone is connected to: the models run there.)")}</p>}
          <p className="muted">{L("הכול רץ במחשב שלך, בלי לשלוח את ההרצאות לשום מקום. צריך מודל שמבין עברית, ומודל שמתמלל הקלטות.", "Everything runs on your computer; your lectures go nowhere. It needs a model that understands Hebrew, and one that transcribes recordings.")}</p>
          <ModelCheck st={models} reload={reloadModels} />
          {nav(() => go(3, models?.chat.ready ? undefined : "model"), L("הבא ›", "Next ›"), "model")}
        </div>
      )}
      {step === 3 && (
        <div className="study-setup-body">
          <h2 tabIndex={-1}>🎙 {L("ההרצאה הראשונה", "Your first lecture")}</h2>
          <p className="muted">{L("מכל הרצאה נעשים סיכום, כרטיסיות לחזרה ובוחן. אפשר להתחיל עכשיו, או בשיעור הבא.", "Each lecture becomes a summary, review cards and a quiz. Start now, or in the next class.")}</p>
          <div className="study-setup-choices">
            <button type="button" className="study-welcome-choice" disabled={busy || !courses.length} onClick={() => void finish("record")}><b>🎙 {L("להקליט עכשיו", "Record now")}</b><span className="muted small">{L("בכיתה או מהמחשב. הגישה למיקרופון נשאלת רק עכשיו.", "In class or from the computer. The microphone is asked only now.")}</span></button>
            <button type="button" className="study-welcome-choice" disabled={busy || !courses.length} onClick={() => void finish("file")}><b>📄 {L("להעלות קובץ או טקסט", "Upload a file or text")}</b><span className="muted small">{L("מצגת, PDF, Word, צילום לוח, סרטון או קישור.", "Slides, PDF, Word, a photo of the board, a video or a link.")}</span></button>
            <button type="button" className="study-welcome-choice" disabled={busy} onClick={() => void finish("later")}><b>🕐 {L("בשיעור הבא", "In the next class")}</b><span className="muted small">{L("הכול מוכן. ברשימת \"מתחילים\" יחכה לך הצעד הבא.", "All set. The \"Getting started\" list keeps the next step for you.")}</span></button>
          </div>
          {!courses.length && <p className="small">{L("כדי להוסיף הרצאה צריך קורס אחד לפחות (שלב 2).", "A lecture needs at least one course (step 2).")}</p>}
          <div className="row wrap study-setup-nav"><button type="button" className="link" onClick={() => go(2)}>{L("‹ חזרה", "‹ Back")}</button></div>
        </div>
      )}
    </section>
  );
}

/**
 * "Getting started" on Study's home (design StudySetupChecklist): what is done and what is left, each with why it
 * helps and one button. Skipped setup steps wait here; it hides itself when all is done, or when she hides it.
 */
export function StudySetupChecklist({ prefs, onPrefs, courses }: { prefs: StudyPrefs; onPrefs: (p: StudyPrefs) => void; courses: Array<{ id: string; lectures: number }> }) {
  const [models, reloadModels] = useModelStatus(!prefs.checklistHidden);
  const [goalOn, setGoalOn] = useState<boolean | null>(null);
  const [phones, setPhones] = useState<number | null>(null);
  const [fieldOpen, setFieldOpen] = useState(false);
  useEffect(() => {
    if (prefs.checklistHidden) return;
    void api<{ on: boolean }>("/api/study/goal").then((g) => setGoalOn(!!g.on), () => setGoalOn(null));
    void api<{ devices: unknown[] }>("/api/remote/devices").then((d) => setPhones(d.devices.length), () => setPhones(null));
  }, [prefs.checklistHidden]);
  if (prefs.checklistHidden || !models) return null;
  const set = (change: Partial<StudyPrefs>) => void api<StudyPrefs>("/api/study/prefs", { method: "PUT", body: change }).then(onPrefs, (e: Error) => toast(e.message));
  const firstLecture = courses.some((c) => c.lectures > 0);
  const items: Array<{ id: string; done: boolean; title: string; why: string; act?: React.ReactNode }> = [
    { id: "field", done: !!prefs.field, title: prefs.field ? L(`התחום: ${STUDY_FIELDS.find((f) => f.id === prefs.field)?.he ?? ""}`, `Field: ${STUDY_FIELDS.find((f) => f.id === prefs.field)?.en ?? ""}`) : L("התחום שלך", "Your field"), why: L("כלים ומילים שמתאימים לתחום", "Tools and words that fit your field"), act: <button type="button" onClick={() => setFieldOpen((v) => !v)}>{L("לבחור", "Choose")}</button> },
    { id: "courses", done: courses.length > 0, title: L("הקורסים", "Your courses"), why: L("לכל קורס הרצאות וכרטיסיות משלו", "Each course has its own lectures and cards") },
    { id: "model", done: models.chat.ready, title: L("מודל שמבין ועונה", "A model that answers"), why: models.suggest ? L(`בלעדיו אין סיכום, כרטיסיות ובוחן. מוצע: ${models.suggest.name}`, `Without it there is no summary, cards or quiz. Suggested: ${models.suggest.name}`) : L("בלעדיו אין סיכום, כרטיסיות ובוחן", "Without it there is no summary, cards or quiz"),
      act: models.suggest ? <DownloadButton url={`/api/models/recommended/${models.suggest.id}/run`} sizeGb={models.suggest.sizeGb} onStarted={reloadModels} /> : <a className="button" href="#/models">{L("לבחור", "Choose")}</a> },
    ...(models.stt && (models.stt.ready || models.stt.setup || models.stt.busy) ? [{ id: "stt", done: models.stt.ready, title: L("תמלול הקלטות", "Transcribing recordings"), why: L("כדי להקליט הרצאה ולקבל טקסט", "To record a lecture and get the text"),
      act: models.stt.busy ? <span className="small">{L("✓ יורד ברקע", "✓ Downloading")}</span> : models.stt.setup ? <DownloadButton url={models.stt.setup} sizeGb={Math.round(models.stt.sizeGb * 10) / 10} onStarted={reloadModels} /> : undefined }] : []),
    { id: "lecture", done: firstLecture, title: L("ההרצאה הראשונה", "The first lecture"), why: L("ממנה נעשים סיכום, כרטיסיות ובוחן", "It becomes a summary, cards and a quiz"), ...(courses[0] ? { act: <a className="button" href={`#/study/${courses[0].id}`}>{L("להוסיף", "Add")}</a> } : {}) },
    ...(phones !== null && !isRemote() ? [{ id: "phone", done: phones > 0, title: L("לחבר את הטלפון", "Connect the phone"), why: L("ללמוד ולהקליט מהטלפון, גם מחוץ לבית", "Study and record from the phone, also away from home"), act: <a className="button" href="#/settings/phone">{L("QR לחיבור", "Connect with a QR")}</a> }] : []),
    ...(goalOn !== null ? [{ id: "goal", done: goalOn, title: L("יעד יומי ותזכורת", "A daily goal and reminder"), why: L("10–15 דקות ביום מספיקות לחזרה", "10–15 minutes a day is enough for review"), act: <button type="button" onClick={() => void api("/api/study/goal", { method: "PUT", body: { on: true, targets: { minutes: 15, cards: 0 }, remind: "20:30" } }).then(() => setGoalOn(true), (e: Error) => toast(e.message))}>{L("15 דקות, תזכורת ב־20:30", "15 minutes, reminder at 20:30")}</button> }] : []),
  ];
  const done = items.filter((i) => i.done).length;
  // All done: hidden for good, so the model check (a hardware and disk scan) does not run on every visit.
  if (done === items.length) {
    if (goalOn !== null && phones !== null) set({ checklistHidden: true });
    return null;
  }
  return (
    <section className="card study-setup-list" aria-label={L("מתחילים", "Getting started")}>
      <div className="row">
        <h2 className="grow">🧭 {L(`מתחילים: ${done} מתוך ${items.length}`, `Getting started: ${done} of ${items.length}`)}</h2>
        <button type="button" className="link small" onClick={() => set({ checklistHidden: true })}>{L("להסתיר", "Hide")}</button>
      </div>
      <div className="study-setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-label={L("התקדמות", "Progress")}><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ul className="study-setup-items">
        {items.map((i) => (
          <li key={i.id} className={i.done ? "done" : ""}>
            <span aria-hidden="true">{i.done ? "✅" : "⬜"}</span>
            <span className="grow"><b dir="auto">{i.title}</b>{!i.done && <span className="muted small"> — {i.why}</span>}<span className="sr-only">{i.done ? L(" (נעשה)", " (done)") : L(" (עוד לא)", " (not yet)")}</span></span>
            {!i.done && i.act}
          </li>
        ))}
      </ul>
      {fieldOpen && (
        <div className="study-welcome-opts" role="radiogroup" aria-label={L("תחום", "Field")}>
          {STUDY_FIELDS.map((f) => <button type="button" key={f.id} role="radio" aria-checked={prefs.field === f.id} className={prefs.field === f.id ? "on" : ""} onClick={() => { set({ field: f.id }); setFieldOpen(false); }}>{FIELD_ICONS[f.id] ?? "📘"} {getLocale() === "he" ? f.he : f.en}</button>)}
        </div>
      )}
      {items.some((i) => (i.id === "model" || i.id === "stt") && !i.done) && <p className="muted small">{L("הורדה מתחילה רק כשלוחצים, וממשיכה ברקע.", "A download starts only when you tap, and goes on in the background.")}</p>}
    </section>
  );
}
