/* global localStorage, document, alert, confirm, crypto, Node */
/**
 * Study on the phone itself, with no computer: courses, lectures (pasted or typed with the keyboard's voice typing),
 * summaries, flashcards on the FSRS schedule, quizzes graded by code, medication calculations and lab values. The
 * model is the one chosen on the phone (Chat tab). Everything is kept on this phone (localStorage).
 * The same shapes as the computer's Study page (packages/shared/src/study.ts), so courses can move to it later.
 */
import { calcCorrect, createEmptyCard, fsrs, jsonIn, LAB_VALUES, practiceProblem, clinicalField, detectField, formatStats, weakLectures, STUDY_FIELDS } from "./vendor/study-core.js";

const KEY = "kesherai-study";
const he = () => (document.documentElement.lang || "he").startsWith("he");
const L = (h, e) => (he() ? h : e);
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
export function renderPhoneStudy(root, ask, search) {
  let db = load();
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
  }

  const back = (to) => el("button", { type: "button", class: "link", onclick: () => go(to) }, L("› חזרה", "‹ Back"));

  function home() {
    const now = Date.now();
    const due = db.courses.reduce((n, c) => n + c.cards.filter((x) => Date.parse(x.due) <= now).length, 0);
    const first = db.courses.find((c) => c.cards.some((x) => Date.parse(x.due) <= now));
    root.append(el("section", { class: "api" },
      el("h2", {}, L("להיום", "Today")),
      first ? el("button", { type: "button", class: "primary", onclick: () => go({ at: "review", course: first.id }) }, L(`חזרה על ${due} כרטיסיות`, `Review ${due} cards`)) : el("p", { class: "muted" }, L("אין כרטיסיות לחזרה עכשיו.", "No cards to review now.")),
      db.courses.some((c) => clinicalField(c.field)) && el("div", { class: "ph-btns" },
        el("button", { type: "button", onclick: () => go({ at: "calc" }) }, L("חישובי תרופות", "Medication calculations")),
        el("button", { type: "button", onclick: () => go({ at: "labs" }) }, L("ערכי מעבדה", "Lab values"))),
      search && el("button", { type: "button", onclick: () => go({ at: "life" }) }, L("שאלה על הלימודים (עם מקורות מהרשת)", "A question about your studies (sources from the web)"))));
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
    const due = c.cards.filter((x) => Date.parse(x.due) <= now).length;
    root.append(back({ at: "home" }), el("h2", { dir: "auto" }, c.name),
      el("div", { class: "ph-btns" },
        el("button", { type: "button", class: "primary", disabled: !due, onclick: () => go({ at: "review", course: c.id }) }, L(`חזרה (${due})`, `Review (${due})`)),
        el("button", { type: "button", disabled: !c.lectures.length, onclick: () => go({ at: "quiz", course: c.id }) }, L("בוחן", "Quiz")),
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
    const title = el("input", { placeholder: L("כותרת ההרצאה", "Lecture title"), dir: "auto", "aria-label": L("כותרת", "Title") });
    const text = el("textarea", { rows: "6", dir: "auto", "aria-label": L("טקסט ההרצאה", "Lecture text"), placeholder: L("הדביקי טקסט, או הקלידי בקול עם המיקרופון של המקלדת.", "Paste text, or type by voice with the keyboard's microphone.") });
    root.append(el("section", { class: "api" },
      el("h2", {}, L("הרצאה חדשה", "New lecture")), title, text,
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
    root.append(back({ at: "course", course: c.id }), el("h2", { dir: "auto" }, l.title),
      el("section", { class: "api" }, el("h2", {}, L("סיכום", "Summary")), l.summary ? el("div", { dir: "auto", style: "white-space: pre-wrap; line-height: 1.6" }, l.summary) : el("p", { class: "muted" }, L("עוד לא סוכם.", "Not summarized yet.")), el("div", { class: "ph-btns", style: "flex-wrap: wrap" }, sum, cards, clinicalField(c.field) && drugBtn(c, l), search && moreBtn(l))),
      l.terms?.length && el("section", { class: "api" }, el("h2", {}, L("מונחים", "Terms")), ...termRows(l.terms)),
      view.more && el("section", { class: "api" }, el("h2", {}, L("סרטונים ומאמרים", "Videos and articles")), ...view.more.map((r) => el("div", { class: "ph-row" }, el("span", {}, el("a", { href: r.url, target: "_blank", rel: "noreferrer" }, r.title), el("br"), el("small", { class: "muted" }, r.snippet))))),
      el("details", {}, el("summary", {}, L("הטקסט המלא", "Full text")), el("div", { dir: "auto", style: "white-space: pre-wrap" }, l.text)));
  }

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

  function review() {
    const c = course();
    if (!c) return go({ at: "home" });
    const now = Date.now();
    const card = c.cards.filter((x) => Date.parse(x.due) <= now).sort((a, b) => Date.parse(a.due) - Date.parse(b.due))[0];
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
      if (commit()) draw();
    };
    const rates = el("div", { class: "ph-btns", hidden: true }, ...[[1, "שוב", "Again"], [2, "קשה", "Hard"], [3, "טוב", "Good"], [4, "קל", "Easy"]].map(([r, h, e]) => el("button", { type: "button", onclick: () => rate(r) }, L(h, e))));
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
      const make = async (licensing, b) => {
        const chosen = c.lectures.slice(-3);
        const material = chosen.map((l, i) => `### Lecture ${i + 1}: ${l.title}\n${(l.summary || l.text).slice(0, 2000)}`).join("\n\n");
        const style = licensing ? " Write them like the Israeli nursing licensing exam: short patient cases asking what the nurse should do first." : "";
        const r = await need([{ role: "system", content: `Write 5 multiple-choice questions from the material, 4 options each, exactly one right.${style} ${LANG} ${ONLY}${hint(c)} Answer with JSON only: [{"q":"...","options":["...","...","...","..."],"answer":0,"explain":"...","lecture":1}]` }, { role: "user", content: material }], b);
        const list = r && jsonIn(r);
        const qs = Array.isArray(list) ? list.filter((x) => x?.q && Array.isArray(x.options) && x.options.length >= 2 && x.answer >= 0 && x.answer < x.options.length) : [];
        if (!qs.length) return r !== undefined && alert(L("המודל לא החזיר שאלות. נסי שוב.", "The model returned no questions. Try again."));
        for (const q of qs) { const lec = chosen[Number(q.lecture) - 1]; if (lec) q.lectureId = lec.id; }
        go({ at: "quiz", course: c.id, quiz: { questions: qs, i: 0, picked: [] } });
      };
      start.onclick = () => make(false, start);
      if (lic) lic.onclick = () => make(true, lic);
      return root.append(el("section", { class: "api" }, el("p", {}, L("בוחן מההרצאות האחרונות. הבדיקה נעשית בקוד.", "A quiz from the latest lectures. Grading is done by code.")), el("div", { class: "ph-btns" }, start, lic)));
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
}
