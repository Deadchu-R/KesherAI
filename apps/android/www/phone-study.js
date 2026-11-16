/* global localStorage, document, alert, confirm, crypto, Node, navigator, AudioContext, btoa, setInterval, clearInterval, setTimeout, File, URL */
/**
 * Study on the phone itself, with no computer: courses, lectures (pasted or typed with the keyboard's voice typing),
 * summaries, flashcards on the FSRS schedule, quizzes graded by code, medication calculations and lab values. The
 * model is the one chosen on the phone (Chat tab). Everything is kept on this phone (localStorage).
 * The same shapes as the computer's Study page (packages/shared/src/study.ts), so courses can move to it later.
 */
import { calcCorrect, createEmptyCard, fsrs, jsonIn, LAB_VALUES, practiceProblem, clinicalField, detectField, formatStats, weakLectures, STUDY_FIELDS, benefitsFor, mergeCourseData, examPlan, cardsToReview, findPassages, tutorMessages, explainMessages, gradeMessages, gradeLine, cleanScript, MISSED_PROMPT, TRANSLATE_PROMPT, AUDIO_PROMPT, shareCourse, openSharedCourse, parseFlow, studyStreak, studyDays, focusWeek, pastExamStyle, parseSyllabus, syllabusNow, SYLLABUS_PROMPT, dayKey, checkCalcQuestion } from "./vendor/study-core.js";

const KEY = "kesherai-study";
const he = () => (document.documentElement.lang || "he").startsWith("he");
const L = (h, e) => (he() ? (globalThis.kesherHebrew ? globalThis.kesherHebrew(h) : h) : e);
const scheduler = fsrs();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "") || { courses: [] };
  } catch {
    return { courses: [] };
  }
}
function save(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    return true;
  } catch {
    alert(L("אין מקום לשמור בטלפון. מחקי הרצאות ישנות או העבירי אותן למחשב.", "No room to save on the phone. Delete old lectures or move them to the computer."));
    return false;
  }
}

/** Builds an element: el("button", { class: "x", onclick }, "text", child…). */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const LANG = "Write in the same language as the material (usually Hebrew). Keep English medical and scientific terms in English.";
const ONLY = "Use only what the material says.";
const FIELD_HINT = {
  nursing: "This is nursing: favour what the nurse assesses, does and teaches, and patient safety.",
  medicine: "This is medicine: mechanisms, diagnosis and treatment as the material states them.",
  law: "This is law: section numbers, statute and case names exactly as written, and each rule or holding.",
  engineering: "This is engineering: formulas with units; worked examples step by step.",
  cs: "This is computer science: short code, complexity, when to use each structure.",
  math: "This is mathematics or physics: exact definitions and theorems; worked problems step by step.",
  psychology: "This is psychology: theory, researcher, study and finding.",
  economics: "This is economics: definitions, models, what moves each curve.",
  biology: "This is biology or chemistry: processes in order, structures and functions.",
};
const hint = (c) => (c && FIELD_HINT[c.field] ? ` ${FIELD_HINT[c.field]}` : "");
const DRUG_KEYS = [["brands", "שמות מסחריים", "Brand names"], ["drugClass", "קבוצה", "Class"], ["action", "מנגנון פעולה", "How it works"], ["uses", "התוויות", "Uses"], ["sideEffects", "תופעות לוואי", "Side effects"], ["contraindications", "התוויות נגד", "Contraindications"], ["nursing", "תפקיד האחות", "Nursing"], ["teaching", "הדרכת המטופל", "Patient teaching"]];

/** Cuts long material for a small model. */
function pieces(text, size = 6000) {
  const out = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = rest.lastIndexOf(". ", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Draws the study page into a section.
 *
 * @param root - The section.
 * @param ask - Asks the phone's chosen model: (messages) => Promise<string | undefined> (undefined: no model ready).
 */
/** Sends a course to a classmate as a file: the phone's share sheet, or a download. */
async function shareFile(c) {
  const f = new File([JSON.stringify(shareCourse(toData(c)))], `${c.name}.kesherai-course.json`, { type: "application/json" });
  if (navigator.canShare?.({ files: [f] })) return navigator.share({ files: [f], title: c.name }).catch(() => undefined);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(f);
  a.download = f.name;
  a.click();
}

/** A phone course (one object) as the computer's course file, for syncing. */
function toData(c) {
  const { lectures = [], cards = [], reviews = [], quizzes = [], drugs, removed, focus, pastExams, syllabus, ...course } = c;
  return { course, lectures, cards, reviews, quizzes, ...(drugs ? { drugs } : {}), ...(removed ? { removed } : {}), ...(focus ? { focus } : {}), ...(pastExams ? { pastExams } : {}), ...(syllabus ? { syllabus } : {}) };
}
/** The computer's course file as a phone course. */
function fromData(d) {
  return { ...d.course, lectures: d.lectures || [], cards: d.cards || [], reviews: d.reviews || [], quizzes: d.quizzes || [], ...(d.drugs ? { drugs: d.drugs } : {}), ...(d.removed ? { removed: d.removed } : {}), ...(d.focus ? { focus: d.focus } : {}), ...(d.pastExams ? { pastExams: d.pastExams } : {}), ...(d.syllabus ? { syllabus: d.syllabus } : {}) };
}

/**
 * The Study tab.
 *
 * @param root - Where it is drawn.
 * @param ask - Asks the phone's model (returns undefined when none is chosen).
 * @param search - A web search, when there is one.
 * @param speech - On-phone speech to text, when there is one.
 * @param sync - Sends `{ courses, removedCourses }` to the paired computer and returns its answer (undefined when
 *   no computer is paired).
 * @param extract - Sends a file (`{ name, data }`, base64) to the paired computer and returns `{ title, text }`
 *   (slides, PDF, Word and photos are read there); undefined when no computer is paired.
 * @param say - Reads text aloud with the phone's voice (resolves when done); `say.stop()` stops it.
 */
export function renderPhoneStudy(root, ask, search, speech, sync, extract, say) {
  let db = load();
  let syncNote = "";
  /** Two-way: the computer merges the phone's courses with its own and sends every course back. */
  const syncNow = async (quiet) => {
    if (!sync) return;
    syncNote = L("מסנכרן עם המחשב…", "Syncing with the computer…");
    if (view.at === "home") draw();
    try {
      const r = await sync({ courses: db.courses.map(toData), removedCourses: db.removedCourses || [] });
      if (!r) {
        syncNote = quiet ? "" : L("אין מחשב מחובר. התחברי פעם אחת למחשב (לשונית מחשב) כדי לסנכרן.", "No computer paired. Connect to your computer once (Computer tab) to sync.");
      } else {
        // Changes made here while the answer was on its way are merged in, not lost.
        const theirs = new Map(r.courses.map((d) => [d.course.id, d]));
        const gone = new Set(r.removedCourses || []);
        const courses = r.courses.map((d) => { const mine = db.courses.find((c) => c.id === d.course.id); return fromData(mine ? mergeCourseData(d, toData(mine)) : d); });
        for (const c of db.courses) if (!theirs.has(c.id) && !gone.has(c.id)) courses.push(c);
        db = { ...db, courses, removedCourses: [] };
        syncNote = save(db) ? L(`מסונכרן עם המחשב · ${db.courses.length} קורסים`, `Synced with the computer · ${db.courses.length} courses`) : "";
      }
    } catch (e) {
      syncNote = quiet ? L("המחשב לא זמין כרגע; הסנכרון יקרה בפעם הבאה.", "The computer is not reachable now; it will sync next time.") : L("הסנכרון נכשל: ", "Sync failed: ") + (e?.message || e);
    }
    if (view.at === "home") draw();
  };
  let view = { at: "home" };
  const go = (v) => {
    view = v;
    draw();
  };
  const course = () => db.courses.find((c) => c.id === view.course);
  const commit = () => save(db);
  const need = async (msgs, busyBtn) => {
    const old = busyBtn?.textContent;
    if (busyBtn) {
      busyBtn.disabled = true;
      busyBtn.textContent = L("עובד… (בטלפון זה לוקח זמן)", "Working… (this takes a while on a phone)");
    }
    try {
      const r = await ask(msgs);
      if (r === undefined) alert(L("קודם בחרי מודל בלשונית צ'אט, ואז חזרי לכאן.", "First pick a model in the Chat tab, then come back."));
      return r;
    } catch (e) {
      alert(String(e?.message || e));
      return undefined;
    } finally {
      if (busyBtn) {
        busyBtn.disabled = false;
        busyBtn.textContent = old;
      }
    }
  };

  function draw() {
    root.replaceChildren();
    root.onpointerup = null;
    root.ontouchend = null;
    root.append(el("p", { class: "intro" }, L("לימודים בטלפון, בלי מחשב: הכול נשמר בטלפון. מודל קטן ואיטי יותר מהמחשב; כשתתחברי למחשב, עמוד הלימודים שם חזק יותר.", "Study on the phone, no computer: everything stays on this phone. A small model, slower than the computer's; connected to the computer, its Study page is stronger.")));
    if (view.at === "home") home();
    else if (view.at === "course") courseView();
    else if (view.at === "lecture") lectureView();
    else if (view.at === "review") review();
    else if (view.at === "quiz") quiz();
    else if (view.at === "calc") calc();
    else if (view.at === "labs") labs();
    else if (view.at === "terms") terms();
    else if (view.at === "drugs") drugs();
    else if (view.at === "progress") progress();
    else if (view.at === "life") life();
    else if (view.at === "record") record();
    else if (view.at === "benefits") benefits();
    else if (view.at === "ask") askView();
  }

  const back = (to) => el("button", { type: "button", class: "link", onclick: () => go(to) }, L("› חזרה", "‹ Back"));

  /**
   * The focus timer (25 or 50 minutes, or her own), tied to a course, with her study streak (a day counts when she
   * focused or reviewed; one missed day a week is allowed) and this week's minutes. The end time is kept, so the
   * session still counts when the screen was off.
   */
  function focusCard() {
    const KEYF = "kesherai-focus-running";
    let run = null;
    try { run = JSON.parse(localStorage.getItem(KEYF) || "null"); } catch { run = null; }
    const datas = db.courses.map(toData);
    const streak = studyStreak(studyDays(datas));
    const week = focusWeek(datas);
    const max = Math.max(25, ...week.map((w) => w.minutes));
    const alarm = globalThis.Capacitor?.Plugins?.KesherNotify;
    const finish = (r, early) => {
      localStorage.removeItem(KEYF);
      if (early) alarm?.focusAlarmCancel?.().catch?.(() => undefined);
      const done = Math.round((Math.min(Date.now(), r.end) - r.start) / 60000);
      const c = db.courses.find((x) => x.id === r.course);
      if (c && (!early || done >= 5)) {
        (c.focus ??= []).push({ t: Date.now(), minutes: Math.max(1, done) });
        commit();
        if (!early) { navigator.vibrate?.([200, 100, 200]); alert(L(`כל הכבוד! ${done} דקות ריכוז. הפסקה קצרה.`, `Well done! ${done} minutes of focus. Take a short break.`)); }
      }
      draw();
    };
    if (run && Date.now() >= run.end) { setTimeout(() => finish(run, false), 0); run = null; }
    const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(he() ? "he-IL" : "en-GB", { weekday: "narrow" });
    const bars = el("div", { class: "ph-week", "aria-label": L("דקות ריכוז השבוע", "Focus minutes this week") }, ...week.map((w) => el("span", { title: `${w.minutes}` }, el("i", { style: `height: ${Math.round((w.minutes / max) * 28) + 2}px` }), day(w.day))));
    const note = streak.days ? L(`רצף: ${streak.days} ימים${streak.today ? "" : " · עוד לא היום"}${streak.shield ? " · יום חופש נוצל השבוע" : ""}`, `Streak: ${streak.days} days${streak.today ? "" : " · not yet today"}${streak.shield ? " · this week's free day used" : ""}`) : L("כל יום שלומדים בו (ריכוז או חזרה) נכנס לרצף. יום אחד בשבוע מותר לפספס.", "Every day you study (focus or review) joins the streak. One missed day a week is allowed.");
    const sec = el("section", { class: "api" }, el("div", { class: "ph-row" }, el("span", {}, el("h2", { style: "margin: 0" }, L("טיימר ריכוז", "Focus timer")), el("small", { class: "muted" }, note)), bars));
    if (run) {
      const clock = el("strong", { class: "ph-clock" }, "");
      const paint = () => {
        // Stops when the page was drawn again without it (the first paint is before it is on the page).
        if (t && !document.body.contains(clock)) return clearInterval(t);
        const left = Math.max(0, run.end - Date.now());
        clock.textContent = `${String(Math.floor(left / 60000)).padStart(2, "0")}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
        if (!left) { clearInterval(t); finish(run, false); }
      };
      let t = 0;
      paint();
      t = setInterval(paint, 1000);
      sec.append(el("div", { class: "ph-row" }, clock, el("span", { class: "muted small" }, db.courses.find((c) => c.id === run.course)?.name ?? ""), el("button", { type: "button", onclick: () => { clearInterval(t); finish(run, true); } }, L("עצירה", "Stop"))));
    } else {
      let minutes = 25;
      const pick = el("select", { "aria-label": L("קורס", "Course") }, ...db.courses.map((c) => el("option", { value: c.id }, c.name)));
      const preset = [25, 50].map((m) => el("button", { type: "button", class: m === 25 ? "primary" : "", onclick: () => { minutes = m; preset.forEach((b, i) => (b.className = [25, 50][i] === m ? "primary" : "")); } }, L(`${m} דק׳`, `${m} min`)));
      sec.append(el("div", { class: "ph-btns" }, pick, ...preset, el("button", { type: "button", onclick: () => {
        const now = Date.now();
        localStorage.setItem(KEYF, JSON.stringify({ course: pick.value, start: now, end: now + minutes * 60000 }));
        // "Time's up" also with the app closed or the screen off.
        alarm?.focusAlarm?.({ at: now + minutes * 60000, title: L("הזמן נגמר: הפסקה קצרה", "Time's up: take a short break"), body: L(`${minutes} דקות ריכוז על ${pick.selectedOptions[0]?.textContent ?? ""}. פתחי את KesherAI כדי לרשום אותן.`, `${minutes} minutes of focus on ${pick.selectedOptions[0]?.textContent ?? ""}. Open KesherAI to record them.`) }).catch?.(() => undefined);
        draw();
      } }, L("התחלה", "Start"))));
    }
    return sec;
  }

  /**
   * The course's syllabus: what is next (exam, assignments, this week's topic), or add it from a file or photo; the
   * phone's model reads it, she confirms, and the next exam becomes the exam date when none is set.
   */
  function syllabusCard(c) {
    const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(he() ? "he-IL" : "en-GB", { day: "numeric", month: "numeric" });
    const sec = el("section", { class: "api" }, el("h2", {}, L("סילבוס", "Syllabus")));
    const draft = view.syllabusDraft;
    if (draft) {
      const list = (title, items, line) => items.length ? [el("b", {}, title), ...items.map(line)] : [];
      sec.append(el("p", {}, L("זה מה שמצאתי בסילבוס. נכון?", "This is what I found in the syllabus. Right?")),
        ...list(L("מבחנים", "Exams"), draft.exams, (e) => el("div", { dir: "auto" }, `${fmt(e.date)} · ${e.title}`)),
        ...list(L("מטלות", "Assignments"), draft.assignments, (e) => el("div", { dir: "auto" }, `${fmt(e.date)} · ${e.title}`)),
        ...list(L("נושאים לפי שבוע", "Topics by week"), draft.weeks, (w) => el("div", { dir: "auto" }, `${L(`שבוע ${w.week}`, `Week ${w.week}`)}${w.date ? ` (${fmt(w.date)})` : ""} · ${w.topic}`)),
        el("div", { class: "ph-btns", style: "margin-top: 8px" },
          el("button", { type: "button", class: "primary", onclick: () => {
            c.syllabus = draft;
            const next = draft.exams.find((e) => e.date >= dayKey(Date.now()));
            if (next && (!c.examDate || c.examDate < dayKey(Date.now()))) c.examDate = next.date;
            delete view.syllabusDraft;
            if (commit()) draw();
          } }, L("שמירה", "Save")),
          el("button", { type: "button", onclick: () => { delete view.syllabusDraft; draw(); } }, L("ביטול", "Cancel"))));
      return sec;
    }
    const now = syllabusNow(c.syllabus);
    if (c.syllabus) {
      if (now.week) sec.append(el("p", { dir: "auto" }, L(`השבוע (שבוע ${now.week.week}): `, `This week (week ${now.week.week}): `), el("b", {}, now.week.topic)));
      if (now.nextExam) sec.append(el("p", { dir: "auto" }, L(`המבחן הבא: ${now.nextExam.title} · ${fmt(now.nextExam.date)} (בעוד ${now.nextExam.daysLeft} ימים)`, `Next exam: ${now.nextExam.title} · ${fmt(now.nextExam.date)} (in ${now.nextExam.daysLeft} days)`)));
      for (const a of now.due) sec.append(el("p", { class: "small", dir: "auto" }, L(`להגשה: ${a.title} · ${fmt(a.date)}`, `Due: ${a.title} · ${fmt(a.date)}`)));
      if (!now.week && !now.nextExam && !now.due.length) sec.append(el("p", { class: "muted" }, L("אין משהו קרוב בסילבוס.", "Nothing coming up in the syllabus.")));
    } else sec.append(el("p", { class: "muted" }, L("הוסיפי את הסילבוס ותקבלי את המבחנים, המטלות ונושא כל שבוע.", "Add the syllabus to get its exams, assignments and each week's topic.")));
    const note = el("p", { class: "muted small", "aria-live": "polite" });
    const pick = el("input", { type: "file", hidden: true, accept: ".pdf,.docx,.pptx,.txt,image/*", onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      note.textContent = L("קורא את הסילבוס…", "Reading the syllabus…");
      let text = "";
      try {
        if (/\.(pdf|docx|pptx|txt)$/i.test(f.name)) text = ((await (await import("./vendor/docs-core.js")).phoneDocumentText(new Uint8Array(await f.arrayBuffer()), f.name)) || "").trim();
        if (!text && extract) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          text = ((await extract({ name: f.name, data: btoa(bin) }))?.text || "").trim();
        }
      } catch (err) {
        note.textContent = L("לא הצלחתי לקרוא: ", "Could not read it: ") + (err?.message || err);
        return;
      }
      if (!text) { note.textContent = L("אין בקובץ טקסט שאפשר לקרוא כאן.", "The file has no text that can be read here."); return; }
      note.textContent = L("מחפש מבחנים, מטלות ונושאים… (בטלפון זה לוקח זמן)", "Finding exams, assignments and topics… (this takes a while on a phone)");
      const r = await ask([{ role: "system", content: SYLLABUS_PROMPT(dayKey(Date.now())) }, { role: "user", content: text.slice(0, 12000) }]);
      const s = r && parseSyllabus(r);
      if (!s) { note.textContent = r === undefined ? L("קודם בחרי מודל בלשונית צ'אט.", "First pick a model in the Chat tab.") : L("לא נמצאו תאריכים או נושאים.", "No dates or topics were found."); return; }
      view.syllabusDraft = s;
      draw();
    } });
    sec.append(el("div", { class: "ph-btns", style: "flex-wrap: wrap" },
      el("button", { type: "button", onclick: () => pick.click() }, c.syllabus ? L("סילבוס חדש", "A new syllabus") : L("הוספת סילבוס", "Add the syllabus")),
      c.syllabus && el("button", { type: "button", onclick: () => { delete c.syllabus; if (commit()) draw(); } }, L("הסרה", "Remove"))), pick, note);
    return sec;
  }

  /**
   * Reminders from the syllabuses: a notification at 18:00 the day before each exam and assignment (the phone's own
   * alarms, also with the app closed). Ones no longer in a syllabus are cancelled.
   */
  function scheduleReminders() {
    const N = globalThis.Capacitor?.Plugins?.KesherNotify;
    if (!N?.remind) return;
    const KEYR = "kesherai-study-reminders";
    let before = [];
    try { before = JSON.parse(localStorage.getItem(KEYR) || "[]"); } catch { before = []; }
    const now = Date.now();
    const want = [];
    for (const c of db.courses) {
      for (const [kind, list] of [["exam", c.syllabus?.exams ?? []], ["due", c.syllabus?.assignments ?? []]]) {
        for (const x of list) {
          const at = new Date(`${x.date}T18:00:00`).getTime() - 86_400_000;
          if (at <= now) continue;
          const id = `${c.id.slice(0, 8)}-${x.date}-${[...x.title].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36)}`;
          want.push(id);
          N.remind({ id, at, title: kind === "exam" ? L(`מחר מבחן: ${x.title}`, `Exam tomorrow: ${x.title}`) : L(`מחר להגשה: ${x.title}`, `Due tomorrow: ${x.title}`), body: c.name }).catch?.(() => undefined);
        }
      }
    }
    for (const id of before) if (!want.includes(id)) N.remindCancel?.({ id }).catch?.(() => undefined);
    localStorage.setItem(KEYR, JSON.stringify(want));
  }

  function home() {
    scheduleReminders();
    if (db.courses.length) root.append(focusCard());
    const now = Date.now();
    const due = db.courses.reduce((n, c) => n + cardsToReview(toData(c), now).length, 0);
    const first = db.courses.find((c) => cardsToReview(toData(c), now).length);
    root.append(el("section", { class: "api" },
      el("h2", {}, L("להיום", "Today")),
      first ? el("button", { type: "button", class: "primary", onclick: () => go({ at: "review", course: first.id }) }, L(`חזרה על ${due} כרטיסיות`, `Review ${due} cards`)) : el("p", { class: "muted" }, L("אין כרטיסיות לחזרה עכשיו.", "No cards to review now.")),
      db.courses.some((c) => clinicalField(c.field)) && el("div", { class: "ph-btns" },
        el("button", { type: "button", onclick: () => go({ at: "calc" }) }, L("חישובי תרופות", "Medication calculations")),
        el("button", { type: "button", onclick: () => go({ at: "labs" }) }, L("ערכי מעבדה", "Lab values"))),
      el("button", { type: "button", onclick: () => go({ at: "benefits" }) }, L("הטבות לסטודנטים", "Student benefits")),
      search && el("button", { type: "button", onclick: () => go({ at: "life" }) }, L("שאלה על הלימודים (עם מקורות מהרשת)", "A question about your studies (sources from the web)")),
      sync && el("div", { class: "ph-row" },
        el("span", { class: "muted small", "aria-live": "polite" }, syncNote || L("הקורסים, ההרצאות והחזרות מסתנכרנים עם המחשב כשהוא מחובר.", "Courses, lectures and reviews sync with the computer when it is connected.")),
        el("button", { type: "button", onclick: () => void syncNow(false) }, L("סנכרן עכשיו", "Sync now")))));
    const imp = el("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      let d;
      try { d = openSharedCourse(JSON.parse(await f.text()), uid, (now) => JSON.parse(JSON.stringify(createEmptyCard(now)))); } catch { d = undefined; }
      if (!d) return alert(L("זה לא קובץ קורס של KesherAI.", "This is not a KesherAI course file."));
      db.courses.unshift(fromData(d));
      if (commit()) go({ at: "course", course: d.course.id });
    } });
    root.append(el("p", { class: "muted small" }, L("קיבלת קורס מחבר/ה? ", "Got a course from a classmate? "), el("button", { type: "button", class: "link", onclick: () => imp.click() }, L("לפתוח קובץ קורס", "Open a course file")), imp));
    if (!db.courses.length) root.append(el("section", { class: "api" },
      el("h2", {}, L("איך זה עובד", "How it works")),
      el("ol", { class: "ph-steps" },
        el("li", {}, el("b", {}, L("פותחים קורס", "Open a course")), " ", L("למטה, בשם שלו. התחום מזוהה לבד.", "below, by its name. Its field is recognised by itself.")),
        el("li", {}, el("b", {}, L("מוסיפים הרצאה", "Add a lecture")), " ", L("בהקלטה, בהדבקת טקסט, ממצגת או בצילום של הלוח.", "by recording, pasting text, from slides or a photo of the board.")),
        el("li", {}, el("b", {}, L("מקבלים חומר ללמידה", "Get material to study")), " ", L("סיכום, מושגים, כרטיסיות לחזרה בזמן הנכון ומבחן תרגול.", "a summary, terms, flashcards at the right time and a practice test."))),
      el("p", { class: "muted small" }, L("הכול נשמר בטלפון, ומסתנכרן עם המחשב כשהוא מחובר.", "Everything stays on the phone, and syncs with the computer when it is connected."))));
    const name = el("input", { placeholder: L("שם קורס חדש", "New course name"), "aria-label": L("שם קורס", "Course name"), dir: "auto" });
    root.append(el("section", { class: "api" },
      el("h2", {}, L("הקורסים שלי", "My courses")),
      el("div", { class: "ph-filter" }, name, el("button", { type: "button", onclick: () => {
        const n = name.value.trim();
        if (!n) return;
        const c = { id: uid(), name: n, createdAt: Date.now(), field: detectField(n, ""), lectures: [], cards: [], reviews: [], quizzes: [] };
        db.courses.unshift(c);
        if (commit()) go({ at: "course", course: c.id });
      } }, L("+ קורס", "+ Course"))),
      ...db.courses.map((c) => el("div", { class: "ph-row" },
        el("span", {}, el("b", { dir: "auto" }, c.name), el("br"), el("small", { class: "muted" }, L(`${c.lectures.length} הרצאות · ${c.cards.length} כרטיסיות`, `${c.lectures.length} lectures · ${c.cards.length} cards`))),
        el("button", { type: "button", onclick: () => go({ at: "course", course: c.id }) }, L("פתח", "Open"))))));
  }

  function courseView() {
    const c = course();
    if (!c) return go({ at: "home" });
    const now = Date.now();
    const due = cardsToReview(toData(c), now).length;
    const plan = examPlan(toData(c), now);
    root.append(back({ at: "home" }), el("h2", { dir: "auto" }, c.name),
      el("div", { class: "ph-btns" },
        el("button", { type: "button", class: "primary", disabled: !due, onclick: () => go({ at: "review", course: c.id }) }, L(`חזרה (${due})`, `Review (${due})`)),
        el("button", { type: "button", disabled: !c.lectures.length, onclick: () => go({ at: "quiz", course: c.id }) }, L("בוחן", "Quiz")),
        el("button", { type: "button", disabled: !c.lectures.length, onclick: () => go({ at: "ask", course: c.id }) }, L("שאלי את הקורס", "Ask the course")),
        el("button", { type: "button", onclick: () => void shareFile(c) }, L("שיתוף הקורס", "Share the course")),
        el("button", { type: "button", onclick: () => go({ at: "terms", course: c.id }) }, L("מילון", "Glossary")),
        clinicalField(c.field) && el("button", { type: "button", onclick: () => go({ at: "drugs", course: c.id }) }, L("תרופות", "Drugs")),
        el("button", { type: "button", onclick: () => go({ at: "progress", course: c.id }) }, L("מה עובד בשבילי", "What works for me"))),
      el("label", { class: "ph-filter" }, L("תחום: ", "Field: "), (() => {
        const sel = el("select", { onchange: (e) => { const v = e.target.value; if (v) { c.field = v; c.fieldChosen = true; } else { delete c.fieldChosen; c.field = detectField(c.name, c.lectures.map((x) => `${x.title} ${x.text.slice(0, 3000)}`).join(" ")); } if (commit()) draw(); } },
          el("option", { value: "" }, c.field && !c.fieldChosen ? L("זוהה: ", "Recognised: ") + (STUDY_FIELDS.find((f) => f.id === c.field)?.[he() ? "he" : "en"] ?? "") : L("לזהות לבד", "Recognise by itself")),
          ...STUDY_FIELDS.map((f) => el("option", { value: f.id }, he() ? f.he : f.en)));
        sel.value = c.fieldChosen ? c.field : "";
        return sel;
      })()));
    const exam = el("input", { type: "date", value: c.examDate || "", "aria-label": L("תאריך המבחן", "Exam date"), onchange: (e) => { const v = e.target.value; if (v) c.examDate = v; else delete c.examDate; if (commit()) draw(); } });
    root.append(el("label", { class: "ph-filter" }, L("מבחן: ", "Exam: "), exam));
    root.append(syllabusCard(c));
    if (plan) root.append(el("section", { class: "api" },
      el("h2", {}, plan.daysLeft === 0 ? L("המבחן היום", "The exam is today") : plan.daysLeft === 1 ? L("המבחן מחר", "The exam is tomorrow") : L(`המבחן בעוד ${plan.daysLeft} ימים`, `The exam is in ${plan.daysLeft} days`)),
      el("p", {}, plan.perDay ? L(`${plan.perDay} כרטיסיות ביום עד המבחן.`, `${plan.perDay} cards a day until the exam.`) : L("אין כרטיסיות לחזרה עד המבחן.", "No cards to review before the exam.")),
      plan.notReady.length > 0 && el("p", { class: "muted small", dir: "auto" }, L("עוד אין מה ללמוד מ: ", "Nothing to study from yet: ") + plan.notReady.slice(0, 6).map((l) => l.title).join(" · ")),
      plan.testWeek && el("button", { type: "button", onclick: () => go({ at: "quiz", course: c.id }) }, L("שבוע מבחן: מבחן תרגול", "Exam week: a practice test"))));
    if (speech) root.append(el("button", { type: "button", class: "primary", style: "display: block; width: 100%; min-height: 52px; margin: 8px 0", onclick: () => go({ at: "record", course: c.id }) }, L("🎙 הקלט הרצאה (בטלפון)", "🎙 Record a lecture (on the phone)")));
    const title = el("input", { placeholder: L("כותרת ההרצאה", "Lecture title"), dir: "auto", "aria-label": L("כותרת", "Title") });
    const text = el("textarea", { rows: "6", dir: "auto", "aria-label": L("טקסט ההרצאה", "Lecture text"), placeholder: L("הדביקי טקסט, הקלידי בקול עם המיקרופון של המקלדת, או הוסיפי מצגת או צילומים.", "Paste text, type by voice with the keyboard's microphone, or add slides or photos.") });
    const fileNote = el("p", { class: "muted small", "aria-live": "polite" });
    /** A file or photo adds to the text: text, slides, Word and PDF here on the phone; scans and photos on the computer. */
    const fromFile = async (input) => {
      const f = input.files?.[0];
      input.value = "";
      if (!f) return;
      if (!title.value) title.value = f.name.replace(/\.[^.]+$/, "");
      const add = (t) => { text.value = text.value.trim() ? `${text.value}\n\n${t}` : t; };
      if (/\.(txt|md|srt|vtt)$/i.test(f.name)) return add(await f.text());
      // Slides, Word and PDF with text are read here on the phone (no computer); scans and photos need one.
      if (/\.(pptx|docx|pdf)$/i.test(f.name) && f.size <= 50 * 1024 * 1024) {
        fileNote.textContent = L("קורא את הקובץ בטלפון…", "Reading the file on the phone…");
        try {
          const { phoneDocumentText } = await import("./vendor/docs-core.js");
          const t = (await phoneDocumentText(new Uint8Array(await f.arrayBuffer()), f.name))?.trim();
          if (t) {
            add(t);
            fileNote.textContent = L("✓ נוסף (נקרא בטלפון). אפשר להוסיף עוד או לשמור.", "✓ Added (read on the phone). Add more, or save.");
            return;
          }
          if (!extract) return (fileNote.textContent = L("אין בקובץ טקסט (כנראה סריקה). סריקות וצילומים נקראים במחשב: התחברי פעם אחת למחשב.", "The file has no text (probably a scan). Scans and photos are read on the computer: connect to it once."));
        } catch (e) {
          if (!extract) return (fileNote.textContent = L("לא הצלחתי לקרוא את הקובץ: ", "Could not read the file: ") + (e?.message || e));
        }
      }
      if (!extract) return (fileNote.textContent = L("צילומים נקראים במחשב: התחברי פעם אחת למחשב (לשונית מחשב).", "Photos are read on the computer: connect to it once (Computer tab)."));
      if (f.size > 50 * 1024 * 1024) return (fileNote.textContent = L("הקובץ גדול מ-50MB.", "The file is larger than 50 MB."));
      fileNote.textContent = L("קורא את הקובץ…", "Reading the file…");
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const r = await extract({ name: f.name, data: btoa(bin) });
        if (!r) fileNote.textContent = L("לקריאת צילום: בחרי בטלפון את Gemma 4 או מודל דרך האינטרנט (הם רואים תמונות), או התחברי למחשב.", "To read a photo: choose Gemma 4 or a model over the internet on the phone (they see pictures), or connect to the computer.");
        else { add(r.text); fileNote.textContent = L("✓ נוסף. אפשר להוסיף עוד צילום או לשמור.", "✓ Added. Add another photo, or save."); }
      } catch (e) {
        fileNote.textContent = L("לא הצלחתי לקרוא את הקובץ: ", "Could not read the file: ") + (e?.message || e);
      }
    };
    const pick = el("input", { type: "file", accept: ".pdf,.pptx,.docx,.txt,.md,.srt,.vtt,image/*", hidden: true, onchange: (e) => void fromFile(e.target) });
    const shoot = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: (e) => void fromFile(e.target) });
    root.append(el("section", { class: "api" },
      el("h2", {}, L("הרצאה חדשה", "New lecture")), title, text,
      el("div", { class: "ph-btns" },
        el("button", { type: "button", onclick: () => pick.click() }, L("מקובץ: מצגת, PDF, Word", "From a file: slides, PDF, Word")),
        el("button", { type: "button", onclick: () => shoot.click() }, L("📷 צילום לוח או מחברת", "📷 Photo of the board or notebook"))),
      pick, shoot, fileNote,
      el("button", { type: "button", class: "primary", onclick: () => {
        if (!text.value.trim()) return;
        const l = { id: uid(), title: title.value.trim() || String(c.lectures.length + 1), date: new Date().toISOString().slice(0, 10), text: text.value.slice(0, 200000) };
        c.lectures.push(l);
        c.field = c.fieldChosen ? c.field : detectField(c.name, c.lectures.map((x) => `${x.title} ${x.text.slice(0, 3000)}`).join(" ")) || c.field;
        if (commit()) go({ at: "lecture", course: c.id, lecture: l.id });
      } }, L("שמור הרצאה", "Save lecture"))));
    root.append(el("section", { class: "api" }, el("h2", {}, L("הרצאות", "Lectures")),
      ...[...c.lectures].reverse().map((l) => el("div", { class: "ph-row" },
        el("span", { dir: "auto" }, l.title, el("br"), el("small", { class: "muted" }, l.summary ? L("✓ סוכם", "✓ Summarized") : L("לא סוכם", "Not summarized"))),
        el("button", { type: "button", onclick: () => go({ at: "lecture", course: c.id, lecture: l.id }) }, L("פתח", "Open")))),
      el("button", { type: "button", class: "link", onclick: () => {
        if (!confirm(L(`למחוק את "${c.name}" מהטלפון? אי אפשר לבטל.`, `Delete "${c.name}" from the phone? This cannot be undone.`))) return;
        db.courses = db.courses.filter((x) => x.id !== c.id);
        db.removedCourses = [...(db.removedCourses || []), c.id].slice(-2000);
        if (commit()) go({ at: "home" });
      } }, L("מחק קורס", "Delete course"))));
  }

  function lectureView() {
    const c = course();
    const l = c?.lectures.find((x) => x.id === view.lecture);
    if (!c || !l) return go({ at: "home" });
    const sum = el("button", { type: "button", class: l.summary ? "" : "primary" }, l.summary ? L("סכם מחדש", "Summarize again") : L("סכם", "Summarize"));
    sum.onclick = async () => {
      const notes = [];
      for (const p of pieces(l.text)) {
        const r = await need([{ role: "system", content: `Summarise this part of a lecture in short bullet lines: main ideas, terms, numbers. ${LANG} ${ONLY}${hint(c)}` }, { role: "user", content: p }], sum);
        if (r === undefined) return;
        notes.push(r);
      }
      l.summary = notes.join("\n").slice(0, 60000);
      // The terms, from the summary (short, so a small model can do it).
      const t = await need([{ role: "system", content: `List the key terms of these notes. ${LANG} ${ONLY} Answer with JSON only: [{"term":"...","en":"English name if any","explain":"one sentence"}]` }, { role: "user", content: l.summary.slice(0, 6000) }], sum);
      const list = t && jsonIn(t);
      if (Array.isArray(list)) l.terms = list.filter((x) => x?.term && x?.explain).slice(0, 60).map((x) => ({ term: String(x.term).slice(0, 120), ...(x.en ? { en: String(x.en).slice(0, 120) } : {}), explain: String(x.explain).slice(0, 400) }));
      if (commit()) draw();
    };
    // The spoken review (audio overview), made once on the phone's model, read with the phone's voice.
    const listen = say && el("button", { type: "button" }, L("🎧 האזנה לסקירה", "🎧 Listen to a review"));
    if (listen) listen.onclick = async () => {
      if (listen.dataset.on) { say.stop?.(); delete listen.dataset.on; listen.textContent = L("🎧 האזנה לסקירה", "🎧 Listen to a review"); return; }
      if (!l.audio) {
        const r = await need([{ role: "system", content: `${AUDIO_PROMPT}${hint(c)}` }, { role: "user", content: `Lecture: ${l.title}\n\n${(l.summary || l.text).slice(0, 6000)}` }], listen);
        if (r === undefined) return;
        l.audio = String(r).replace(/[#*_`>|]/g, "").trim().slice(0, 20000);
        commit();
      }
      listen.dataset.on = "1";
      listen.textContent = L("⏹ עצירה", "⏹ Stop");
      await say(l.audio);
      delete listen.dataset.on;
      listen.textContent = L("🎧 האזנה לסקירה", "🎧 Listen to a review");
    };
    // The lecture's main process as boxes and arrows (made here on demand, or brought from the computer).
    const flowBtn = !l.diagram && el("button", { type: "button" }, L("תרשים תהליך", "Process diagram"));
    if (flowBtn) flowBtn.onclick = async () => {
      const r = await need([{ role: "system", content: `Draw the main process or mechanism of this lecture as a Mermaid flowchart: "graph TD" and lines like A[step] --> B[next step], at most 10 boxes, labels in the lecture's language. ${ONLY} If the lecture has no process, answer only NONE.` }, { role: "user", content: (l.summary || l.text).slice(0, 6000) }], flowBtn);
      if (r === undefined) return;
      const src = String(r).replace(/^[\s\S]*?```(?:mermaid)?\s*|```[\s\S]*$/g, "").trim();
      if (!parseFlow(src)) return alert(L("אין בהרצאה הזו תהליך לתרשים.", "This lecture has no process to draw."));
      l.diagram = src.slice(0, 8000);
      if (commit()) draw();
    };
    const cards = el("button", { type: "button" }, L("צור 8 כרטיסיות", "Make 8 cards"));
    cards.onclick = async () => {
      const r = await need([{ role: "system", content: `Write 8 flashcards from the lecture. Each tests one fact; the front is a question, the back a short answer. ${LANG} ${ONLY}${hint(c)} Answer with JSON only: [{"front":"...","back":"..."}]` }, { role: "user", content: (l.summary || l.text).slice(0, 6000) }], cards);
      const list = r && jsonIn(r);
      if (!Array.isArray(list)) return r !== undefined && alert(L("המודל לא החזיר כרטיסיות. נסי שוב.", "The model returned no cards. Try again."));
      const now = new Date();
      let n = 0;
      for (const x of list) {
        if (!x?.front || !x?.back) continue;
        const e = createEmptyCard(now);
        c.cards.push({ id: uid(), front: String(x.front).slice(0, 1000), back: String(x.back).slice(0, 3000), format: "text", lectureId: l.id, createdAt: now.getTime(), due: e.due.toISOString(), fsrs: JSON.parse(JSON.stringify(e)) });
        n++;
      }
      if (commit()) alert(L(`נוצרו ${n} כרטיסיות`, `${n} cards made`));
    };
    // "Explain this": select words in the summary or the full text, then explain, simpler, example, or make a card.
    const explainBox = el("section", { class: "api ph-why", hidden: true, "aria-live": "polite" });
    let picked = "";
    const showPick = () => {
      const t = (globalThis.getSelection?.()?.toString() ?? "").trim();
      if (t.length < 3 || t === picked) return;
      picked = t.slice(0, 3000);
      const out = el("p", { dir: "auto", style: "white-space: pre-wrap" });
      const explain = async (kind, b) => {
        const r = await need(explainMessages({ selection: picked, lecture: l, kind, hint: hint(c).trim() || undefined }), b);
        if (r === undefined) return;
        out.textContent = cleanScript(String(r).trim(), /[\u0590-\u05ff]/.test(picked));
        cardBtn.hidden = false;
      };
      const cardBtn = el("button", { type: "button", hidden: true, onclick: () => {
        const e = createEmptyCard(new Date());
        c.cards.push({ id: uid(), front: L(`מה המשמעות של: "${picked.slice(0, 200)}"?`, `What does this mean: "${picked.slice(0, 200)}"?`), back: out.textContent.slice(0, 3000), format: "text", lectureId: l.id, createdAt: Date.now(), due: e.due.toISOString(), fsrs: JSON.parse(JSON.stringify(e)) });
        if (commit()) alert(L("נוספה כרטיסייה", "Card added"));
      } }, L("לכרטיסייה", "To a card"));
      explainBox.replaceChildren(
        el("small", { class: "muted", dir: "auto" }, L("נבחר: ", "Selected: ") + `“${picked.length > 120 ? `${picked.slice(0, 120)}…` : picked}”`),
        el("div", { class: "ph-btns", style: "flex-wrap: wrap; margin-top: 6px" },
          el("button", { type: "button", class: "primary", onclick: (e) => void explain("explain", e.currentTarget) }, L("הסבר", "Explain")),
          el("button", { type: "button", onclick: (e) => void explain("simple", e.currentTarget) }, L("בפשטות", "Simpler")),
          el("button", { type: "button", onclick: (e) => void explain("example", e.currentTarget) }, L("דוגמה", "Example")),
          cardBtn),
        out);
      explainBox.hidden = false;
    };
    // One handler at a time (draw() clears them for the other pages).
    root.onpointerup = () => setTimeout(showPick, 30);
    root.ontouchend = () => setTimeout(showPick, 60);
    root.append(back({ at: "course", course: c.id }), el("h2", { dir: "auto" }, l.title), explainBox,
      el("section", { class: "api" }, el("h2", {}, L("סיכום", "Summary")), l.summary ? el("div", { dir: "auto", style: "white-space: pre-wrap; line-height: 1.6" }, l.summary) : el("p", { class: "muted" }, L("עוד לא סוכם.", "Not summarized yet.")), l.summary || l.text ? el("small", { class: "muted" }, L("טיפ: סמני מילים בסיכום או בטקסט המלא לקבלת הסבר.", "Tip: select words in the summary or full text for an explanation.")) : "", el("div", { class: "ph-btns", style: "flex-wrap: wrap" }, sum, listen, cards, flowBtn, clinicalField(c.field) && drugBtn(c, l), search && moreBtn(l))),
      flowView(l.diagram),
      l.terms?.length && el("section", { class: "api" }, el("h2", {}, L("מונחים", "Terms")), ...termRows(l.terms)),
      view.more && el("section", { class: "api" }, el("h2", {}, L("סרטונים ומאמרים", "Videos and articles")), ...view.more.map((r) => el("div", { class: "ph-row" }, el("span", {}, el("a", { href: r.url, target: "_blank", rel: "noreferrer" }, r.title), el("br"), el("small", { class: "muted" }, r.snippet))))),
      el("details", {}, el("summary", {}, L("הטקסט המלא", "Full text")), el("div", { dir: "auto", style: "white-space: pre-wrap" }, l.text)));
  }

  /** A lecture's diagram as boxes and arrows, the same reading as the computer's (Mermaid flowchart text). */
  const flowView = (src) => {
    const flow = src && parseFlow(src);
    if (!flow) return null;
    const label = (id) => flow.nodes.find((n) => n.id === id)?.label ?? id;
    const order = [];
    const visit = (id) => { if (order.includes(id)) return; order.push(id); flow.edges.filter((e) => e.from === id).forEach((e) => visit(e.to)); };
    flow.nodes.forEach((n) => visit(n.id));
    return el("section", { class: "api" }, el("h2", {}, L("תרשים", "Diagram")),
      el("div", { class: "ph-flow", role: "img", "aria-label": flow.edges.map((e) => `${label(e.from)} → ${label(e.to)}`).join(", ") },
        ...order.flatMap((id, i) => {
          const into = flow.edges.find((e) => e.to === id && order.indexOf(e.from) === i - 1);
          return [i > 0 ? el("span", { class: "ph-flow-arrow", "aria-hidden": "true" }, into?.label ? `${into.label} ↓` : "↓") : null, el("span", { class: "ph-flow-box", dir: "auto" }, label(id))];
        })));
  };
  const termRows = (list) => list.map((t) => el("div", { class: "ph-row" }, el("span", { dir: "auto" }, el("b", {}, t.term), t.en && t.en !== t.term ? el("small", { class: "muted", dir: "ltr" }, " · " + t.en) : null, el("br"), el("small", {}, t.explain))));

  function drugBtn(c, l) {
    const b = el("button", { type: "button" }, L("כרטיסי תרופות", "Drug cards"));
    b.onclick = async () => {
      const r = await need([{ role: "system", content: `Make nursing drug cards for every drug in the material; fill only what it says, never guess doses. ${LANG} Answer with JSON only: [{"name":"generic","brands":"","drugClass":"","action":"","uses":"","sideEffects":"","contraindications":"","nursing":"","teaching":""}]` }, { role: "user", content: l.text.slice(0, 6000) }], b);
      const list = r && jsonIn(r);
      if (!Array.isArray(list)) return r !== undefined && alert(L("המודל לא החזיר תרופות. נסי שוב.", "The model returned no drugs. Try again."));
      c.drugs ??= [];
      for (const x of list) {
        const name = String(x?.name ?? "").trim().slice(0, 120);
        if (!name) continue;
        const d = { id: uid(), name, lectureId: l.id };
        for (const [k] of DRUG_KEYS) if (typeof x[k] === "string" && x[k].trim()) d[k] = x[k].trim().slice(0, 1500);
        const i = c.drugs.findIndex((g) => g.name.toLowerCase() === name.toLowerCase());
        if (i >= 0) c.drugs[i] = { ...c.drugs[i], ...d, id: c.drugs[i].id };
        else c.drugs.push(d);
      }
      if (commit()) go({ at: "drugs", course: c.id });
    };
    return b;
  }

  function moreBtn(l) {
    const b = el("button", { type: "button" }, L("סרטונים ומאמרים", "Videos and articles"));
    b.onclick = async () => {
      b.disabled = true;
      try {
        const q = `${l.title} ${(l.terms ?? []).slice(0, 3).map((t) => t.en || t.term).join(" ")}`;
        const [vids, arts] = await Promise.all([search(`${q} youtube`).catch(() => []), search(q).catch(() => [])]);
        view.more = [...vids.slice(0, 3), ...arts.slice(0, 3)];
        draw();
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }

  function terms() {
    const c = course();
    if (!c) return go({ at: "home" });
    const all = c.lectures.flatMap((l) => l.terms ?? []).sort((a, b) => a.term.localeCompare(b.term, "he"));
    root.append(back({ at: "course", course: c.id }), el("section", { class: "api" }, el("h2", {}, L("מילון", "Glossary")), ...(all.length ? termRows(all) : [el("p", { class: "muted" }, L("המילון מתמלא מכל הרצאה שסוכמה.", "The glossary fills from every summarized lecture."))])));
  }

  function drugs() {
    const c = course();
    if (!c) return go({ at: "home" });
    root.append(back({ at: "course", course: c.id }), el("p", { class: "muted" }, L("נכתב מההרצאות שלך בלבד. מינונים — תמיד לפי ההוראה ובית המרקחת.", "From your lectures only. Doses: always by the order and the pharmacy.")),
      ...(c.drugs ?? []).map((d) => el("details", { class: "api" }, el("summary", {}, el("b", { dir: "ltr" }, d.name), d.drugClass ? ` · ${d.drugClass}` : ""),
        ...DRUG_KEYS.filter(([k]) => d[k]).map(([k, h, e]) => el("p", { dir: "auto" }, el("small", { class: "muted" }, L(h, e)), el("br"), d[k])))));
    if (!c.drugs?.length) root.append(el("p", { class: "muted" }, L("עוד אין כרטיסי תרופות. בעמוד ההרצאה: \"כרטיסי תרופות\".", "No drug cards yet. On a lecture: \"Drug cards\".")));
  }

  function progress() {
    const c = course();
    if (!c) return go({ at: "home" });
    const f = formatStats(c.reviews ?? []);
    const w = weakLectures(c.quizzes ?? []);
    root.append(back({ at: "course", course: c.id }), el("p", { class: "muted" }, L("לפי מה שזכרת בחזרות אחרי יום ויותר. לא \"סגנון למידה\" — התוצאות שלך.", "From what you remembered a day or more later. Not a \"learning style\" — your own results.")),
      el("section", { class: "api" }, el("h2", {}, L("כמה זכרת", "How much you remembered")), ...(f.length ? f.map((x) => el("div", { class: "ph-row" }, el("span", {}, x.format), el("span", { dir: "ltr" }, `${Math.round(x.recall * 100)}% · ${x.n}`))) : [el("p", { class: "muted" }, L("עוד אין מספיק חזרות.", "Not enough reviews yet."))])),
      w.length && el("section", { class: "api" }, el("h2", {}, L("נושאים חלשים", "Weak topics")), ...w.map((x) => el("div", { class: "ph-row" }, el("span", { dir: "auto" }, c.lectures.find((l) => l.id === x.lectureId)?.title ?? ""), el("span", {}, `${Math.round(x.correct * 100)}%`)))));
  }

  function life() {
    const qs = [["אילו חיסונים צריך סטודנט/ית לסיעוד בישראל לפני התנסות קלינית, ואיפה קובעים תור?", "Which vaccinations does a nursing student in Israel need before clinical practice, and where to book?"], ["אילו מסמכים צריך לפני התנסות קלינית בבית חולים?", "Which documents are needed before clinical practice at a hospital?"], ["איך מגישים בקשה למועד מיוחד בבחינה?", "How do I apply for a special exam date?"]];
    const input = el("textarea", { rows: "3", dir: "auto", "aria-label": L("השאלה", "The question") });
    if (view.ask) input.value = view.ask;
    const out = el("div", {});
    const btn = el("button", { type: "button", class: "primary" }, L("חפש וענה", "Search and answer"));
    btn.onclick = async () => {
      const q = input.value.trim();
      if (!q) return;
      btn.disabled = true;
      try {
        const results = await search(q).catch(() => []);
        const sources = results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.snippet}`).join("\n");
        const a = await need([{ role: "system", content: `Answer the student's practical question from these web results only, in short lines, and say which source [n] each line comes from. Prefer official sources (gov.il, the Ministry of Health, health funds, the school). If they differ between schools, say what to check with the programme. ${LANG}` }, { role: "user", content: `${q}\n\n${sources}` }], btn);
        out.replaceChildren(el("p", { dir: "auto", style: "white-space: pre-wrap" }, a ?? ""), ...results.map((r, i) => el("p", {}, el("a", { href: r.url, target: "_blank", rel: "noreferrer" }, `[${i + 1}] ${r.title}`))), el("p", { class: "muted" }, L(`נבדק ב-${new Date().toLocaleDateString("he-IL")}`, `Checked ${new Date().toLocaleDateString()}`)));
      } finally {
        btn.disabled = false;
      }
    };
    root.append(back({ at: "home" }), el("section", { class: "api" }, el("h2", {}, L("שאלה על הלימודים", "A question about your studies")),
      ...qs.map(([h, e]) => el("button", { type: "button", style: "display: block; width: 100%; text-align: start; margin: 4px 0", onclick: () => { input.value = L(h, e); } }, L(h, e))), input, btn, out));
  }

  /** 16-bit mono WAV, base64 (for the phone's speech engine). */
  function wavBase64(chunks, rate) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    let o = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  const mmss = (sec) => `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}]`;

  async function record() {
    const c = course();
    if (!c) return go({ at: "home" });
    root.append(back({ at: "course", course: c.id }));
    const box = el("section", { class: "api" });
    root.append(box);
    if (!(await speech.available())) return box.append(el("p", {}, L("בגרסה הזאת של האפליקציה אין מנוע דיבור. עדכני את האפליקציה.", "This build of the app has no speech engine. Update the app.")));
    if (!(await speech.hasModel())) {
      const dl = el("button", { type: "button", class: "primary" }, L(`הורד מודל דיבור (${speech.sizeMb}MB)`, `Download the speech model (${speech.sizeMb} MB)`));
      dl.onclick = async () => {
        dl.disabled = true;
        try {
          await speech.download((pct) => (dl.textContent = L(`מוריד ${pct}%`, `Downloading ${pct}%`)));
          draw();
        } catch (e) {
          dl.disabled = false;
          dl.textContent = L("נסי שוב", "Try again");
          alert(String(e?.message || e));
        }
      };
      return box.append(el("p", {}, L("כדי לתמלל בטלפון, צריך מודל דיבור פעם אחת (מומלץ ב-Wi-Fi).", "To transcribe on the phone, download a speech model once (Wi-Fi is best).")), dl);
    }
    const clock = el("p", { style: "font-size: 40px; font-weight: 700; direction: ltr; text-align: center; margin: 8px 0" }, "00:00");
    const text = el("div", { dir: "auto", style: "white-space: pre-wrap; min-height: 120px; line-height: 1.6" }, L("התמלול יופיע כאן אחרי חצי הדקה הראשונה.", "The transcript shows here after the first half minute."));
    const lines = [];
    // Live translation of each half minute by the phone's model (the lecture keeps the original).
    const transTo = el("select", { "aria-label": L("תרגום חי", "Live translation") }, el("option", { value: "" }, L("בלי", "Off")), el("option", { value: "en" }, L("לאנגלית", "To English")), el("option", { value: "he" }, L("לעברית", "To Hebrew")));
    const trans = el("div", { dir: "auto", hidden: true, style: "white-space: pre-wrap; line-height: 1.6; opacity: .85; border-inline-start: 3px solid var(--accent); padding-inline-start: 8px; margin-top: 8px" });
    const translated = [];
    const startBtn = el("button", { type: "button", class: "primary", style: "width: 100%; min-height: 52px" }, L("התחל הקלטה", "Start recording"));
    box.append(el("p", { class: "muted" }, L("כל חצי דקה הופכת לטקסט בטלפון עצמו. השאירי את המסך דלוק. לפני שמקליטים שיעור, כדאי לוודא שהמרצה מסכים/ה.", "Every half minute becomes text on the phone itself. Keep the screen on. Before recording a class, make sure the lecturer agrees.")), el("label", { class: "ph-filter" }, L("תרגום חי: ", "Live translation: "), transTo), clock, text, trans, startBtn);
    startBtn.onclick = async () => {
      let mic;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, autoGainControl: true } });
      } catch {
        return alert(L("אין גישה למיקרופון.", "No access to the microphone."));
      }
      const lock = await navigator.wakeLock?.request("screen").catch(() => undefined);
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(mic);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      const began = Date.now();
      let chunks = [];
      let peak = 0;
      let pieceAt = 0;
      let queue = Promise.resolve();
      const now = () => (Date.now() - began) / 1000;
      const flush = () => {
        const b64 = chunks.length && peak > 0.015 ? wavBase64(chunks, ctx.sampleRate) : undefined;
        const at = pieceAt;
        chunks = [];
        peak = 0;
        pieceAt = now();
        if (!b64) return;
        queue = queue.then(async () => {
          try {
            const t = (await speech.transcribe(b64, "auto")).trim();
            if (t) {
              lines.push(`${mmss(at)} ${t}`);
              text.textContent = lines.slice(-6).join("\n");
              if (transTo.value) {
                trans.hidden = false;
                const to = transTo.value;
                // Not awaited: transcription goes on while the phone's model translates.
                void Promise.resolve(ask([{ role: "system", content: TRANSLATE_PROMPT(to) }, { role: "user", content: t }])).then((r) => {
                  if (!r) return;
                  translated.push(`${mmss(at)} ${cleanScript(String(r).trim(), to === "he")}`);
                  trans.textContent = translated.slice(-6).join("\n");
                }, () => undefined);
              }
            }
          } catch (e) {
            text.textContent = String(e?.message || e);
          }
        });
      };
      node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]));
        if (now() - pieceAt >= 30) flush();
      };
      const tick = setInterval(() => { const sec = now(); clock.textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`; }, 500);
      const star = el("button", { type: "button", onclick: () => lines.push(`${mmss(now())} ⭐ ${L("חשוב", "Important")}`) }, L("⭐ חשוב", "⭐ Important"));
      const stop = el("button", { type: "button", class: "primary", style: "background: #f08a8a; min-height: 52px" }, L("סיים הקלטה", "Finish recording"));
      stop.onclick = async () => {
        stop.disabled = true;
        stop.textContent = L("מסיים את התמלול…", "Finishing the transcript…");
        clearInterval(tick);
        flush();
        node.disconnect();
        mic.getTracks().forEach((t) => t.stop());
        void ctx.close();
        void lock?.release?.();
        await queue;
        if (!lines.length) return alert(L("לא נשמע דיבור בהקלטה.", "No speech was heard."));
        const l = { id: uid(), title: L(`הרצאה ${c.lectures.length + 1}`, `Lecture ${c.lectures.length + 1}`), date: new Date().toISOString().slice(0, 10), text: lines.join("\n") };
        c.lectures.push(l);
        if (commit()) go({ at: "lecture", course: c.id, lecture: l.id });
      };
      startBtn.replaceWith(el("div", { class: "ph-btns" }, star, stop));
    };
  }

  function benefits() {
    root.append(back({ at: "home" }), el("p", { class: "muted" }, L("הטבות משתנות: בכל אחת כתוב מתי נבדקה. תמיד לאשר בעמוד הרשמי.", "Benefits change: each says when it was checked. Always confirm on the official page.")));
    if (search) root.append(el("button", { type: "button", class: "primary", onclick: () => go({ at: "life", ask: L("אילו הטבות לסטודנטים בישראל קיימות עכשיו, ואיך מפעילים כל אחת?", "Which student benefits exist in Israel now, and how is each turned on?") }) }, L("בדוק מה חדש עכשיו", "Check what is new now")));
    for (const b of benefitsFor(db.courses.map((c) => c.field))) {
      root.append(el("details", { class: "api" }, el("summary", {}, el("b", {}, he() ? b.name.he : b.name.en), el("br"), el("small", { class: "muted" }, he() ? b.what.he : b.what.en)),
        el("ol", {}, ...(he() ? b.how.he : b.how.en).map((h) => el("li", {}, h))),
        b.note && el("p", { class: "muted" }, he() ? b.note.he : b.note.en),
        el("p", {}, el("a", { href: b.url, target: "_blank", rel: "noreferrer" }, L("לעמוד הרשמי", "Official page")), " · ", el("small", { class: "muted" }, L(`נבדק ${b.checked.split("-").reverse().join(".")}`, `Checked ${b.checked}`)))));
    }
  }

  /** The course's tutor on the phone's own model: answers only from her lectures, naming each lecture. */
  const tutor = new Map();
  /** The last missed card and why its answer is right (while the explanation is being written: no text yet). */
  let missed;
  /** The tutor's way per course: "ask" (she asks) or "study" (the tutor asks her). */
  const tutorMode = new Map();
  function askView() {
    const c = course();
    if (!c) return go({ at: "home" });
    const mode = tutorMode.get(c.id) || "ask";
    const key = `${c.id}:${mode}`;
    const turns = tutor.get(key) || [];
    tutor.set(key, turns);
    const list = el("div", { class: "ph-ask", "aria-live": "polite" }, ...turns.map((t) => el("div", { class: `ph-ask-turn ${t.role}`, dir: "auto" }, t.content, t.sources?.length ? el("small", { class: "muted" }, el("br"), L("מתוך: ", "From: ") + t.sources.join(" · ")) : "")));
    const study = mode === "study";
    const homework = mode === "homework";
    // An empty box takes its direction from the page (dir=auto would show the Hebrew example left to right).
    const q = el("input", { dir: he() ? "rtl" : "auto", "aria-label": study ? L("התשובה שלך", "Your answer") : homework ? L("התרגיל או הצעד שלך", "The exercise or your step") : L("שאלה", "Question"), placeholder: homework ? (turns.length ? L("הצעד שעשית, או שאלה", "Your step, or a question") : L("התרגיל (הדביקי את הנוסח)", "The exercise (paste it)")) : study ? L("התשובה שלך, או \"רמז\"", "Your answer, or \"hint\"") : L("למשל: מה ההבדל בין סוג 1 לסוג 2?", "e.g. What is the difference between type 1 and type 2?") });
    const btn = el("button", { type: "submit", class: "primary" }, study ? L("שליחת תשובה", "Answer") : homework ? L("שליחה", "Send") : L("שאלי", "Ask"));
    /** One turn, the same messages as the computer's tutor (shared). An empty question starts study mode. */
    const send = async (question, busyBtn) => {
      const heb = /[\u0590-\u05ff]/.test(`${question} ${c.lectures[0]?.text.slice(0, 400) ?? ""}`);
      const asked = [...turns].reverse().find((t) => t.role === "assistant")?.content;
      if (question) turns.push({ role: "user", content: question });
      // Study mode, her answer: a plain verdict first (by her lecture, in our words), then the next question.
      if (study && question && asked) {
        const g = gradeMessages({ lectures: c.lectures, tutorQuestion: asked, answer: question, budget: 4000 });
        const raw = await need(g.messages, busyBtn);
        if (raw === undefined) { turns.pop(); return; }
        const line = gradeLine(String(raw), heb);
        if (line) {
          const next = tutorMessages({ lectures: c.lectures, question: "", history: [...turns, { role: "assistant", content: line }], mode, hint: hint(c).trim() || undefined, budget: 4000 });
          const q2 = await need(next.messages, busyBtn);
          turns.push({ role: "assistant", content: `${line}${q2 ? `\n\n${cleanScript(String(q2).trim(), heb)}` : ""}`, sources: [...new Set(g.passages.map((p) => p.title))] });
          return draw();
        }
      }
      const { messages, passages } = tutorMessages({ lectures: c.lectures, question, history: turns.slice(0, question ? -1 : undefined), mode, hint: hint(c).trim() || undefined, budget: 5000 });
      const r = await need(messages, busyBtn);
      if (r === undefined) { if (question) turns.pop(); return; }
      turns.push({ role: "assistant", content: cleanScript(String(r).trim(), heb), sources: [...new Set(passages.map((p) => p.title))] });
      draw();
    };
    const form = el("form", { class: "ph-filter", onsubmit: (e) => {
      e.preventDefault();
      const question = q.value.trim();
      if (question) void send(question, btn);
    } }, q, btn);
    const seg = el("div", { class: "ph-btns", role: "tablist" }, ...[["ask", "השאלות שלי", "My questions"], ["study", "מצב תרגול", "Study mode"], ["homework", "שיעורי בית", "Homework"]].map(([m, h, e]) =>
      el("button", { type: "button", role: "tab", "aria-selected": String(m === mode), class: m === mode ? "primary" : "", onclick: () => { tutorMode.set(c.id, m); draw(); } }, L(h, e))));
    const startBtn = study && !turns.length ? el("button", { type: "button", class: "primary", style: "width: 100%; min-height: 48px", onclick: (e) => void send("", e.currentTarget) }, L("התחילי תרגול", "Start practising")) : "";
    root.append(back({ at: "course", course: c.id }), el("h2", {}, L("שאלי את הקורס", "Ask the course")), seg,
      el("p", { class: "muted small" }, homework ? L("הדביקי את התרגיל. המורה עוזרת צעד אחר צעד: כתבי כל צעד שעשית והיא תבדוק, בקשי רמז כשנתקעת, ופתרון מלא כשתרצי.", "Paste the exercise. The tutor helps step by step: write each step and it checks it, ask for a hint when stuck, and for the full solution when you want it.") : study ? L("המורה שואלת שאלה אחת מההרצאות שלך, מחכה לתשובה, אומרת אם צדקת ומסבירה, וממשיכה. אפשר לבקש רמז.", "The tutor asks one question from your lectures, waits for your answer, says whether it is right and explains, then goes on. You can ask for a hint.") : L("התשובות רק מההרצאות שלך, עם שם ההרצאה. כשהן לא מכסות שאלה, זה ייאמר.", "Answers come only from your lectures, naming each lecture. When they do not cover a question, it says so.")),
      startBtn, list,
      homework && turns.length ? el("div", { class: "ph-btns" },
        el("button", { type: "button", onclick: (e) => void send(L("רמז, בבקשה", "A hint, please"), e.currentTarget) }, L("רמז", "Hint")),
        el("button", { type: "button", onclick: (e) => void send(L("הראי לי את הפתרון המלא, צעד אחר צעד", "Show me the full solution, step by step"), e.currentTarget) }, L("פתרון מלא", "Full solution"))) : "",
      form);
    if (!startBtn) q.focus();
  }


  function review() {
    const c = course();
    if (!c) return go({ at: "home" });
    const now = Date.now();
    const card = cardsToReview(toData(c), now, 1)[0];
    root.append(back({ at: "course", course: c.id }));
    if (!card) return root.append(el("p", {}, L("סיימת! אין עוד כרטיסיות לחזרה עכשיו.", "Done! No more cards to review now.")));
    const answer = el("p", { dir: "auto", hidden: true, style: "white-space: pre-wrap" }, card.back);
    const rate = (r) => {
      const f = card.fsrs;
      const before = { ...f, due: new Date(f.due), ...(f.last_review ? { last_review: new Date(f.last_review) } : {}) };
      const elapsedDays = before.last_review ? Math.floor((Date.now() - before.last_review.getTime()) / 86400000) : 0;
      const next = scheduler.next(before, new Date(), r).card;
      card.fsrs = JSON.parse(JSON.stringify(next));
      card.due = next.due.toISOString();
      c.reviews.push({ cardId: card.id, t: Date.now(), rating: r, format: card.format, elapsedDays });
      // "Again": a line on why the answer is right, from the phone's model (shown above the next card).
      missed = r === 1 ? { front: card.front } : undefined;
      if (missed) {
        const mine = missed;
        const passage = findPassages(c.lectures.filter((l) => !card.lectureId || l.id === card.lectureId), `${card.front} ${card.back}`, 2000).map((p) => p.text).join("\n");
        void Promise.resolve(ask([{ role: "system", content: MISSED_PROMPT + hint(c) }, { role: "user", content: `Card: ${card.front}\nAnswer: ${card.back}${passage ? `\n\nLecture passage:\n${passage}` : ""}` }])).then((t) => {
          if (missed !== mine) return;
          if (!t) missed = undefined;
          else mine.text = String(t).trim();
          if (view.at === "review") draw();
        }, () => { if (missed === mine) missed = undefined; });
      }
      if (commit()) draw();
    };
    const rates = el("div", { class: "ph-btns", hidden: true }, ...[[1, "שוב", "Again"], [2, "קשה", "Hard"], [3, "טוב", "Good"], [4, "קל", "Easy"]].map(([r, h, e]) => el("button", { type: "button", onclick: () => rate(r) }, L(h, e))));
    if (missed) root.append(el("div", { class: "ph-why", "aria-live": "polite", dir: "auto" }, el("strong", {}, L("למה? ", "Why? ")), missed.front, el("p", {}, missed.text ?? L("מסביר… (בטלפון זה לוקח זמן)", "Explaining… (this takes a while on a phone)"))));
    root.append(el("section", { class: "api" },
      el("p", { dir: "auto", style: "font-size: 18px" }, card.front), answer,
      el("button", { type: "button", class: "primary", onclick: (ev) => { answer.hidden = false; rates.hidden = false; ev.currentTarget.hidden = true; } }, L("הצג תשובה", "Show answer")), rates));
  }

  function quiz() {
    const c = course();
    if (!c) return go({ at: "home" });
    root.append(back({ at: "course", course: c.id }));
    const z = view.quiz;
    if (!z) {
      const start = el("button", { type: "button", class: "primary" }, L("כתוב 5 שאלות", "Write 5 questions"));
      const lic = clinicalField(c.field) && c.field === "nursing" && el("button", { type: "button" }, L("בסגנון בחינת הרישוי", "Licensing-exam style"));
      const past = (c.pastExams ?? []).length > 0 && el("button", { type: "button" }, L("בסגנון המבחנים הקודמים", "Like the past exams"));
      const make = async (licensing, b, likePast) => {
        const chosen = c.lectures.slice(-3);
        const material = chosen.map((l, i) => `### Lecture ${i + 1}: ${l.title}\n${(l.summary || l.text).slice(0, 2000)}`).join("\n\n");
        const style = licensing ? " Write them like the Israeli nursing licensing exam: short patient cases asking what the nurse should do first." : likePast ? `\n${pastExamStyle(c.pastExams, 3000)}\n` : "";
        const r = await need([{ role: "system", content: `Write 5 multiple-choice questions from the material, 4 options each, exactly one right.${style} ${LANG} ${ONLY}${hint(c)} Answer with JSON only: [{"q":"...","options":["...","...","...","..."],"answer":0,"explain":"...","lecture":1}]` }, { role: "user", content: material }], b);
        const list = r && jsonIn(r);
        // Calculation questions are checked against their own working (a wrong option marked right is fixed or dropped).
        const qs = Array.isArray(list) ? list.filter((x) => x?.q && Array.isArray(x.options) && x.options.length >= 2 && x.answer >= 0 && x.answer < x.options.length).map((x) => checkCalcQuestion({ ...x, options: x.options.map(String) })).filter(Boolean) : [];
        if (!qs.length) return r !== undefined && alert(L("המודל לא החזיר שאלות. נסי שוב.", "The model returned no questions. Try again."));
        for (const q of qs) { const lec = chosen[Number(q.lecture) - 1]; if (lec) q.lectureId = lec.id; }
        go({ at: "quiz", course: c.id, quiz: { questions: qs, i: 0, picked: [] } });
      };
      start.onclick = () => make(false, start);
      if (lic) lic.onclick = () => make(true, lic);
      if (past) past.onclick = () => make(false, past, true);
      // Past exams: read on the phone (text, Word, PDF; a photo with a model that sees pictures, or the computer).
      const note = el("p", { class: "muted small", "aria-live": "polite" });
      const pick = el("input", { type: "file", hidden: true, accept: ".pdf,.docx,.pptx,.txt,image/*", onchange: async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        note.textContent = L("קורא את המבחן…", "Reading the exam…");
        let text = "";
        try {
          if (/\.(pdf|docx|pptx|txt)$/i.test(f.name)) text = ((await (await import("./vendor/docs-core.js")).phoneDocumentText(new Uint8Array(await f.arrayBuffer()), f.name)) || "").trim();
          if (!text && extract) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            text = ((await extract({ name: f.name, data: btoa(bin) }))?.text || "").trim();
          }
        } catch (err) {
          note.textContent = L("לא הצלחתי לקרוא: ", "Could not read it: ") + (err?.message || err);
          return;
        }
        if (!text) { note.textContent = L("אין במבחן טקסט שאפשר לקרוא כאן.", "The exam has no text that can be read here."); return; }
        (c.pastExams ??= []).push({ id: uid(), title: f.name.replace(/\.[^.]+$/, "").slice(0, 200), text: text.slice(0, 200000), t: Date.now() });
        if (commit()) draw();
      } });
      const exams = el("section", { class: "api" }, el("h2", {}, L("מבחנים קודמים", "Past exams")),
        ...(c.pastExams ?? []).map((x) => el("div", { class: "ph-row" }, el("span", { dir: "auto" }, x.title), el("button", { type: "button", "aria-label": L("הסרה", "Remove"), onclick: () => { c.pastExams = c.pastExams.filter((y) => y.id !== x.id); c.removed = [...(c.removed ?? []), x.id]; if (commit()) draw(); } }, "✕"))),
        el("button", { type: "button", onclick: () => pick.click() }, L("הוספת מבחן קודם (PDF, Word או צילום)", "Add a past exam (PDF, Word or photo)")), pick, note,
        el("p", { class: "muted small" }, L("השאלות נכתבות מההרצאות שלך באותו סגנון, אורך ורמת קושי.", "Questions are written from your lectures in the same style, length and difficulty.")));
      return root.append(el("section", { class: "api" }, el("p", {}, L("בוחן מההרצאות האחרונות. הבדיקה נעשית בקוד.", "A quiz from the latest lectures. Grading is done by code.")), el("div", { class: "ph-btns", style: "flex-wrap: wrap" }, start, lic, past)), exams);
    }
    if (z.i >= z.questions.length) {
      const score = z.questions.filter((q, k) => z.picked[k] === q.answer).length;
      if (!z.saved) {
        z.saved = true;
        c.quizzes ??= [];
        c.quizzes.push({ id: uid(), t: Date.now(), questions: z.questions, answers: z.picked, score });
        commit();
      }
      return root.append(el("section", { class: "api" }, el("h2", {}, L(`${score} מתוך ${z.questions.length}`, `${score} of ${z.questions.length}`)), el("button", { type: "button", class: "primary", onclick: () => go({ at: "quiz", course: c.id }) }, L("בוחן נוסף", "Another quiz"))));
    }
    const q = z.questions[z.i];
    const picked = z.picked[z.i];
    root.append(el("section", { class: "api" },
      el("p", { class: "muted" }, L(`שאלה ${z.i + 1} מתוך ${z.questions.length}`, `Question ${z.i + 1} of ${z.questions.length}`)),
      el("p", { dir: "auto", style: "font-size: 17px" }, q.q),
      ...q.options.map((o, k) => el("button", { type: "button", dir: "auto", style: "display: block; width: 100%; text-align: start; margin: 6px 0; min-height: 48px; " + (picked === undefined ? "" : k === q.answer ? "border-color: #6fd3a5" : k === picked ? "border-color: #f08a8a" : ""), disabled: picked !== undefined, onclick: () => { z.picked[z.i] = k; draw(); } }, String(o))),
      picked !== undefined && el("p", { dir: "auto" }, (picked === q.answer ? L("✓ נכון. ", "✓ Right. ") : L("לא נכון. ", "Not right. ")) + String(q.explain || "")),
      picked !== undefined && el("button", { type: "button", class: "primary", onclick: () => { z.i++; draw(); } }, L("הבא", "Next"))));
  }

  function calc() {
    root.append(back({ at: "home" }), el("p", { class: "muted" }, L("התשובה מחושבת בקוד, לא במודל. תמיד לבדוק מול הוראות המחלקה.", "The answer is computed by code, not a model. Always check against your ward's rules.")));
    const kinds = [["volume", "נפח למתן", "Volume"], ["tablets", "טבליות", "Tablets"], ["weight", "לפי משקל", "By weight"], ["rate", "קצב משאבה", "Pump rate"], ["drops", "טיפות לדקה", "Drops/min"], ["infusion", "mcg/kg/min", "mcg/kg/min"]];
    const kind = view.kind || "volume";
    const p = view.problem || practiceProblem(kind);
    view.problem = p;
    const v = p.values;
    const iso = (n, u) => `⁨${n} ${u}⁩`;
    const qText = {
      volume: L(`הוראה: ${iso(v.doseMg, "mg")}. בבקבוקון ${iso(v.haveMg, "mg")} ב-${iso(v.perMl, "mL")}. כמה mL לתת?`, `Ordered ${v.doseMg} mg; vial ${v.haveMg} mg in ${v.perMl} mL. How many mL?`),
      tablets: L(`הוראה: ${iso(v.doseMg, "mg")}. טבליה ${iso(v.tabletMg, "mg")}. כמה טבליות?`, `Ordered ${v.doseMg} mg; tablet ${v.tabletMg} mg. How many tablets?`),
      weight: L(`הוראה: ${iso(v.mgPerKg, "mg/kg")}, משקל ${iso(v.kg, "kg")}. כמה mg?`, `Ordered ${v.mgPerKg} mg/kg, weight ${v.kg} kg. How many mg?`),
      rate: L(`${iso(v.volumeMl, "mL")} במשך ${v.hours} שעות במשאבה. מה הקצב ב-mL/h?`, `${v.volumeMl} mL over ${v.hours} h by pump. Rate in mL/h?`),
      drops: L(`${iso(v.volumeMl, "mL")} במשך ${v.minutes} דקות, סט של ${v.dropFactor} טיפות ל-mL. כמה טיפות לדקה?`, `${v.volumeMl} mL over ${v.minutes} min, ${v.dropFactor} drops/mL. Drops per minute?`),
      infusion: L(`הוראה: ${iso(v.mcgPerKgMin, "mcg/kg/min")}, משקל ${iso(v.kg, "kg")}. בשקית ${iso(v.drugMg, "mg")} ב-${iso(v.bagMl, "mL")}. קצב ב-mL/h?`, `${v.mcgPerKgMin} mcg/kg/min, ${v.kg} kg; bag ${v.drugMg} mg in ${v.bagMl} mL. Rate in mL/h?`),
    }[kind];
    const input = el("input", { inputmode: "decimal", dir: "ltr", "aria-label": L("התשובה שלך", "Your answer"), style: "width: 110px" });
    const out = el("div", {});
    root.append(el("div", { class: "ph-filter", style: "flex-wrap: wrap" }, ...kinds.map(([k, h, e]) => el("button", { type: "button", class: k === kind ? "primary" : "", onclick: () => go({ at: "calc", kind: k }) }, L(h, e)))),
      el("section", { class: "api" }, el("p", { dir: "auto", style: "font-size: 17px" }, qText),
        el("div", { class: "ph-filter" }, input, el("span", { dir: "ltr", class: "muted" }, p.result.unit), el("button", { type: "button", class: "primary", onclick: () => {
          const ok = calcCorrect(Number(input.value.replace(",", ".")), p.result);
          out.replaceChildren(el("p", {}, ok ? L("✓ נכון. הדרך:", "✓ Right. The way:") : L(`לא נכון. התשובה: ${p.result.value} ${p.result.unit}. הדרך:`, `Not right: ${p.result.value} ${p.result.unit}. The way:`)), el("ol", { dir: "ltr" }, ...p.result.steps.map((s) => el("li", {}, s))));
        } }, L("בדוק", "Check"))), out,
        el("button", { type: "button", onclick: () => go({ at: "calc", kind }) }, L("תרגיל נוסף", "Another problem"))));
  }

  function labs() {
    root.append(back({ at: "home" }), el("p", { class: "muted" }, L("ערכים תקינים למבוגרים כפי שמלמדים בדרך כלל. לכל מעבדה טווחים משלה.", "Normal adult values as usually taught. Every lab has its own ranges.")),
      el("section", { class: "api" }, ...LAB_VALUES.map((v) => el("div", { class: "ph-row" }, el("span", {}, v.he, " ", el("small", { class: "muted", dir: "ltr" }, v.name)), el("span", { dir: "ltr" }, `${v.range} ${v.unit}`)))));
  }

  draw();
  void syncNow(true);
}
