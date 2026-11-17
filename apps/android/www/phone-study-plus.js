/* global localStorage, fetch, alert, navigator, document, setInterval, clearInterval, confirm, AudioContext, Blob, URL */
/**
 * The phone's own Study, part two (Roee: "everything that can work alone on the phone should"): the features the
 * computer's Study page gained in students parts 25–34, here with no computer — the feed, hard cards and the card
 * timer, cards from notes, reading in portions, the days before an exam, grades with the degree and Moed B, where a
 * term appears, the course web, the memory palace, the two-voice podcast, what to learn from a quiz, a similar
 * problem, letters to the lecturer, academic English, presentation rehearsal and papers. The same shared code as the
 * computer (vendor/study-core.js), the phone's own model, and the same course data, so all of it syncs.
 */
import { goalToday, weekRecap, studyBadges, topicMastery, studyStreak, studyDays, backlogPlan, cleanStudyPrefs, SETUP_STEPS, STUDY_FIELDS, fsrs, recentMistakes, cardsToReview, createEmptyCard, findPassages, jsonIn, leechCards, LEECH_PROMPT, noteCards, readingPortion, studyFeed, courseWeb, whereTerm, QUIZ_TALK_PROMPT, QUESTION_CHECK_PROMPT, parseQuestionCheck, SIMILAR_MARK, PALACE_PROMPT, PALACE_SPOTS_HE, cleanPalace, PODCAST_PROMPT, parsePodcast, letterPrompt, parseLetter, ENGLISH_PROMPT, cleanEnglish, REHEARSE_PROMPT, speechStats, PAPERS_PROMPT, parseOpenAlex, cleanDoi, cleanSources, apaRef, apaCite, chicagoRef, chicagoCite, parseBibtex, parseRis, toBibtex, toRis, cleanGrades, rowGrade, weightedAverage, degreeProgress, moedB, mockMinutes, mockTime, mockResult, TEACH_BACK_PROMPT, parseTeachBack, cleanHighlights, WRITING_PROMPT, parseWritingFeedback, OPEN_QUIZ_PROMPT, parseOpenQuestions, openGradeMessages, openMark, checkCalcQuestion, detectField, cleanTimetable, classNow, classesOn, freeSlots, planPrompt, checkPlan, TIMETABLE_PHOTO_PROMPT, cleanReadClasses } from "./vendor/study-core.js";

const GRADES_KEY = "kesherai-grades";
const TIMER_KEY = "kesherai-card-timer";
const TABLE_KEY = "kesherai-timetable";
const PLANS_KEY = "kesherai-plans";
const SETUP_KEY = "kesherai-study-setup";
const GOAL_KEY = "kesherai-goal";
const DAYS = [["א׳", "Sun"], ["ב׳", "Mon"], ["ג׳", "Tue"], ["ד׳", "Wed"], ["ה׳", "Thu"], ["ו׳", "Fri"], ["ש׳", "Sat"]];

/**
 * The extra study views and pieces, drawn with the phone page's own helpers.
 *
 * @param x - The page's helpers: root, el, L, he, go, back, need, commit, course, view, draw, uid, toData, db, say,
 *   speech, extract.
 */
export function studyPlus(x) {
  const { el, L, go, back, need, commit, uid } = x;
  const newCard = (c, front, back, lectureId) => {
    const e = createEmptyCard(new Date());
    c.cards.push({ id: uid(), front: String(front).slice(0, 2000), back: String(back).slice(0, 6000), format: "text", ...(lectureId ? { lectureId } : {}), createdAt: Date.now(), due: e.due.toISOString(), fsrs: JSON.parse(JSON.stringify(e)) });
  };
  const section = (title, ...kids) => el("section", { class: "api" }, title ? el("h2", {}, title) : "", ...kids);
  const btns = (...b) => el("div", { class: "ph-btns", style: "flex-wrap: wrap" }, ...b);
  const daysTo = (date) => Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);

  // ---------- the course's extra buttons, and the days before the exam ----------
  /** The buttons for the extra views on the course page. */
  function courseButtons(c) {
    return btns(
      el("button", { type: "button", onclick: () => go({ at: "practice", course: c.id, mode: "quick" }) }, L("⚡ 5 דקות", "⚡ 5 minutes")),
      el("button", { type: "button", onclick: () => go({ at: "practice", course: c.id, mode: "mistakes" }) }, L("🔁 הטעויות שלי", "🔁 My mistakes")),
      el("button", { type: "button", onclick: () => go({ at: "match", course: c.id }) }, L("🧩 התאמה", "🧩 Match")),
      el("button", { type: "button", onclick: () => go({ at: "occlusion", course: c.id }) }, L("🖼 כרטיסיות מתמונה", "🖼 Cards from a picture")),
      el("button", { type: "button", onclick: () => go({ at: "mock", course: c.id }) }, L("📝 מבחן דמה", "📝 Mock exam")),
      el("button", { type: "button", onclick: () => go({ at: "feed", course: c.id }) }, L("📱 פיד", "📱 Feed")),
      el("button", { type: "button", onclick: () => go({ at: "web", course: c.id }) }, L("🕸 מפת הקורס", "🕸 Course web")),
      el("button", { type: "button", onclick: () => go({ at: "palace", course: c.id }) }, L("🏛 ארמון זיכרון", "🏛 Memory palace")),
      el("button", { type: "button", onclick: () => go({ at: "papers", course: c.id }) }, L("📚 מאמרים ומקורות", "📚 Papers and sources")),
      x.speech && el("button", { type: "button", onclick: () => go({ at: "rehearse", course: c.id }) }, L("🎤 חזרה על הצגה", "🎤 Rehearse a talk")),
      el("button", { type: "button", onclick: () => go({ at: "writing", course: c.id }) }, L("✍️ מאמן כתיבה", "✍️ Writing coach")),
      el("button", { type: "button", onclick: () => go({ at: "letter", course: c.id }) }, L("✉️ מכתב למרצה", "✉️ Letter to the lecturer")));
  }

  /** From two days before the exam date: what to do first, a checklist for the day, a minute of calm breathing. */
  function examEve(c) {
    if (!c.examDate) return "";
    const d = daysTo(c.examDate);
    if (d < 0 || d > 2) return "";
    const key = `kesherai-eve-${c.id}-${c.examDate}`;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(key) || "[]"); } catch { done = []; }
    const items = [["תעודת זהות או כרטיס סטודנט", "ID or student card"], ["מחשבון / דף נוסחאות אם מותר", "Calculator / formula sheet if allowed"], ["עטים, מים ומשהו לאכול", "Pens, water and a snack"], ["לבדוק כיתה ושעה", "Check the room and time"], ["לישון 7 שעות", "Sleep 7 hours"]];
    const breath = el("p", { class: "muted small", "aria-live": "polite" });
    let timer = 0;
    const breathe = (b) => {
      if (timer) { clearInterval(timer); timer = 0; breath.textContent = ""; b.textContent = L("🫁 דקה של נשימה רגועה", "🫁 A minute of calm breathing"); return; }
      let s = 0;
      b.textContent = L("לעצור", "Stop");
      timer = setInterval(() => {
        const k = s % 14;
        breath.textContent = k < 4 ? L("שאיפה…", "Breathe in…") : k < 8 ? L("להחזיק…", "Hold…") : L("נשיפה ארוכה…", "Long breath out…");
        if (++s > 60) breathe(b);
      }, 1000);
    };
    return section(d === 0 ? L("🎯 המבחן היום. בהצלחה!", "🎯 The exam is today. Good luck!") : d === 1 ? L("🎯 המבחן מחר", "🎯 The exam is tomorrow") : L("🎯 המבחן בעוד יומיים", "🎯 The exam is in two days"),
      d > 0 ? btns(
        el("button", { type: "button", class: "primary", onclick: () => go({ at: "review", course: c.id }) }, L("1. הכרטיסיות הקשות קודם", "1. Hard cards first")),
        el("button", { type: "button", onclick: () => go({ at: "quiz", course: c.id }) }, L("2. בוחן קצר", "2. A short quiz")),
        el("button", { type: "button", onclick: () => go({ at: "summary", course: c.id }) }, L("3. סיכום הקורס", "3. The course summary"))) : "",
      ...items.map(([h, e], i) => {
        const cb = el("input", { type: "checkbox", onchange: () => { done = done.includes(i) ? done.filter((y) => y !== i) : [...done, i]; try { localStorage.setItem(key, JSON.stringify(done)); } catch { /* a convenience */ } } });
        cb.checked = done.includes(i);
        return el("label", { class: "ph-row", style: "justify-content: flex-start; gap: 8px" }, cb, L(h, e));
      }),
      el("button", { type: "button", onclick: (e) => breathe(e.currentTarget) }, L("🫁 דקה של נשימה רגועה", "🫁 A minute of calm breathing")), breath);
  }

  // ---------- review: hard cards and the card timer ----------
  /** Hard cards (forgotten three times or more) with a fix by the phone's model: simpler, split, or a memory hook. */
  function hardCards(c) {
    const list = leechCards(c.cards, c.reviews).slice(0, 20);
    if (!list.length) return "";
    const fix = async (card, how, b) => {
      const passage = findPassages(c.lectures.filter((l) => !card.lectureId || l.id === card.lectureId), `${card.front} ${card.back}`, 2000).map((p) => p.text).join("\n");
      const r = await need([{ role: "system", content: LEECH_PROMPT[how] }, { role: "user", content: `Card: ${card.front}\nAnswer: ${card.back}${passage ? `\n\nLecture passage:\n${passage}` : ""}` }], b);
      const made = (Array.isArray(r && jsonIn(r)) ? jsonIn(r) : []).filter((y) => y?.front && y?.back).slice(0, how === "split" ? 4 : 1);
      if (!made.length) return r !== undefined && alert(L("המודל לא כתב כרטיסייה. נסי שוב.", "The model wrote no card. Try again."));
      const i = c.cards.findIndex((k) => k.id === card.id);
      if (i < 0) return;
      c.cards.splice(i, 1);
      c.removed = [...(c.removed ?? []), card.id].slice(-5000);
      for (const m of made) newCard(c, m.front, m.back, card.lectureId);
      if (commit()) { alert(made.length > 1 ? L(`פוצל ל-${made.length} כרטיסיות`, `Split into ${made.length} cards`) : L("הכרטיסייה תוקנה", "The card was fixed")); x.draw(); }
    };
    return el("details", { class: "api" }, el("summary", {}, L(`🧱 ${list.length} כרטיסיות קשות (נשכחו 3 פעמים ויותר)`, `🧱 ${list.length} hard cards (forgotten 3+ times)`)),
      ...list.map(({ card, lapses }) => el("div", { class: "ph-row", style: "flex-direction: column; align-items: stretch" },
        el("b", { dir: "auto" }, card.front), el("small", { class: "muted" }, L(`נשכחה ${lapses} פעמים`, `forgotten ${lapses} times`)),
        btns(
          el("button", { type: "button", onclick: (e) => void fix(card, "simpler", e.currentTarget) }, L("✏️ פשוט יותר", "✏️ Simpler")),
          el("button", { type: "button", onclick: (e) => void fix(card, "split", e.currentTarget) }, L("✂️ לפצל", "✂️ Split")),
          el("button", { type: "button", onclick: (e) => void fix(card, "hook", e.currentTarget) }, L("🪝 דרך לזכור", "🪝 A memory hook"))))));
  }

  /** The card timer (0 = off): the answer shows by itself when the seconds run out. */
  function cardTimer(show) {
    let limit = 0;
    try { limit = Number(localStorage.getItem(TIMER_KEY)) || 0; } catch { limit = 0; }
    const sel = el("select", { "aria-label": L("טיימר לכרטיסייה", "Timer per card"), onchange: (e) => { try { localStorage.setItem(TIMER_KEY, e.target.value); } catch { /* a convenience */ } x.draw(); } },
      ...[0, 5, 10, 20, 30, 60].map((n) => el("option", { value: String(n) }, n ? L(`${n} שניות`, `${n} s`) : L("כבוי", "Off"))));
    sel.value = String(limit);
    const bar = el("div", { style: "height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 80%, transparent); transition: width 1s linear; width: 100%" });
    let left = limit;
    const t = limit ? setInterval(() => {
      if (!bar.isConnected) return clearInterval(t);
      left--;
      bar.style.width = `${Math.max(0, (left / limit) * 100)}%`;
      if (left <= 0) { clearInterval(t); show(); }
    }, 1000) : 0;
    return el("div", {}, el("label", { class: "ph-filter" }, L("⏱ טיימר: ", "⏱ Timer: "), sel), limit ? bar : "");
  }

  // ---------- lecture: cards from notes, portions, podcast, where a term appears ----------
  /** "term :: meaning" lines in her notes into cards. */
  function noteCardsBtn(c, l) {
    const n = noteCards(l.notes || "").length;
    if (!n) return el("small", { class: "muted" }, L("טיפ: שורה כמו \"ברדיקרדיה :: דופק מתחת ל-60\" בהערות הופכת לכרטיסייה.", "Tip: a line like \"bradycardia :: a pulse under 60\" in your notes becomes a card."));
    return el("button", { type: "button", onclick: () => {
      const have = new Set(c.cards.map((k) => k.front.trim().toLowerCase()));
      let added = 0;
      for (const m of noteCards(l.notes || "")) if (!have.has(m.front.toLowerCase())) { newCard(c, m.front, m.back, l.id); have.add(m.front.toLowerCase()); added++; }
      if (commit()) alert(added ? L(`נוספו ${added} כרטיסיות`, `${added} cards added`) : L("כל השורות כבר כרטיסיות", "Every line is a card already"));
    } }, L(`📇 ${n} שורות עם :: לכרטיסיות`, `📇 Cards from ${n} lines with ::`));
  }

  /** Reading a long text in portions (about ten minutes each), her place kept; cards from the portion read. */
  function portions(c, l) {
    if (l.text.length <= 12000) return "";
    const p = readingPortion(l.text, l.readPos || 0);
    const cardsBtn = el("button", { type: "button" }, L("📇 כרטיסיות מהמנה", "📇 Cards from this portion"));
    cardsBtn.onclick = async () => {
      const r = await need([{ role: "system", content: "Write 5 flashcards from this part of a lecture. Each tests one fact; the front is a question, the back a short answer. Write in the same language as the material. Use only what it says. Answer with JSON only: [{\"front\":\"...\",\"back\":\"...\"}]" }, { role: "user", content: l.text.slice(p.from, p.to).slice(0, 6000) }], cardsBtn);
      const list = r && jsonIn(r);
      if (!Array.isArray(list)) return r !== undefined && alert(L("המודל לא החזיר כרטיסיות. נסי שוב.", "The model returned no cards. Try again."));
      let n = 0;
      for (const m of list) if (m?.front && m?.back) { newCard(c, m.front, m.back, l.id); n++; }
      if (commit()) alert(L(`נוצרו ${n} כרטיסיות`, `${n} cards made`));
    };
    const move = (to) => { l.readPos = Math.max(0, Math.min(to, l.text.length)); if (commit()) x.draw(); };
    return el("details", { class: "api", open: !!l.readPos }, el("summary", {}, L(`📖 קריאה במנות · מנה ${p.part} מתוך ${p.parts}`, `📖 Read in portions · ${p.part} of ${p.parts}`)),
      el("div", { dir: "auto", style: "white-space: pre-wrap; line-height: 1.8; max-height: 60vh; overflow-y: auto" }, l.text.slice(p.from, p.to)),
      btns(
        p.to < l.text.length ? el("button", { type: "button", class: "primary", onclick: () => move(p.to) }, L("✓ סיימתי, למנה הבאה", "✓ Done, next portion")) : el("button", { type: "button", class: "primary", onclick: () => move(l.text.length) }, L("✓ סיימתי", "✓ Done")),
        cardsBtn,
        p.part > 1 ? el("button", { type: "button", onclick: () => move(readingPortion(l.text, p.from - 1).from) }, L("למנה הקודמת", "Previous")) : ""));
  }

  /** The lecture as a talk between two hosts, each with its own voice (pitch), written once by the phone's model. */
  function podcastBtn(c, l) {
    if (!x.say) return "";
    const b = el("button", { type: "button" }, L("🎙 פודקאסט בשני קולות", "🎙 A two-voice podcast"));
    const line = el("p", { class: "muted small", dir: "auto", "aria-live": "polite" });
    let on = false;
    b.onclick = async () => {
      if (on) { on = false; x.say.stop?.(); b.textContent = L("🎙 פודקאסט בשני קולות", "🎙 A two-voice podcast"); line.textContent = ""; return; }
      if (!l.podcast) {
        const heb = /[֐-׿]/.test(l.text.slice(0, 2000));
        const r = await need([{ role: "system", content: `${PODCAST_PROMPT}${heb ? " Write the whole talk in Hebrew (עברית), every line. The hosts are נועה (A) and איתי (B). The first line looks like: A: שלום! היום נדבר על …" : ""}` }, { role: "user", content: `${heb ? "כתבו את כל השיחה בעברית.\n\n" : ""}Lecture: ${l.title}\n\n${(l.summary || l.text).slice(0, 5000)}${heb ? "\n\nהשיחה (בעברית):\nA:" : ""}` }], b);
        if (r === undefined) return;
        const text = String(r).trim().replace(/^(?![AB]\s*:)/, "A: ");
        if (parsePodcast(text).length < 4) return alert(L("המודל לא כתב שיחה בין שני מגישים. נסי שוב.", "The model did not write a two-host talk. Try again."));
        l.podcast = text.slice(0, 20000);
        commit();
      }
      on = true;
      b.textContent = L("⏹ עצירה", "⏹ Stop");
      for (const p of parsePodcast(l.podcast)) {
        if (!on || !b.isConnected) break;
        line.textContent = `${p.host ? L("איתי", "Itai") : L("נועה", "Noa")}: ${p.text}`;
        await x.say(p.text, { pitch: p.host ? 1.35 : 0.95 });
      }
      on = false;
      b.textContent = L("🎙 פודקאסט בשני קולות", "🎙 A two-voice podcast");
      line.textContent = "";
    };
    return el("span", {}, b, line);
  }

  /** A term's other places in the course (with page and minute), shown under it. */
  function whereBtn(c, t) {
    const out = el("div", { class: "small" });
    return el("span", {}, el("button", { type: "button", class: "link", onclick: () => {
      if (out.childNodes.length) return out.replaceChildren();
      const places = whereTerm(c.lectures, t.term, t.en);
      out.replaceChildren(...(places.length ? places.map((p) => el("div", { dir: "auto", style: "margin: 4px 0" },
        el("button", { type: "button", class: "link", onclick: () => go({ at: "lecture", course: c.id, lecture: p.lectureId }) }, `${p.title} · ${L(`${p.count} פעמים`, `${p.count} times`)}`),
        ...p.spots.map((s) => el("div", { class: "muted" }, `${s.page ? L(`עמ׳ ${s.page} · `, `p. ${s.page} · `) : ""}${s.text}`)))) : [el("span", { class: "muted" }, L("לא מופיע בטקסט של ההרצאות.", "Not in the lectures' text."))]));
    } }, L("🔎 איפה עוד", "🔎 Where else")), out);
  }

  // ---------- quizzes and homework ----------
  /** After a quiz: what to learn from the questions she missed. */
  function quizTalk(c, z) {
    const missed = z.questions.filter((q, i) => !q.dropped && z.picked[i] !== q.answer);
    if (!missed.length) return "";
    const out = el("p", { dir: "auto", style: "white-space: pre-wrap" });
    const b = el("button", { type: "button" }, L("💬 מה ללמוד מזה?", "💬 What should I learn from this?"));
    b.onclick = async () => {
      const text = missed.map((q) => `- ${q.q}\n  Her answer: ${q.options[z.picked[z.questions.indexOf(q)]] ?? "(none)"}\n  Right: ${q.options[q.answer]}. ${q.explain || ""}${q.lectureId ? `\n  Lecture: ${c.lectures.find((l) => l.id === q.lectureId)?.title ?? ""}` : ""}`).join("\n");
      const r = await need([{ role: "system", content: QUIZ_TALK_PROMPT }, { role: "user", content: `Score: ${z.questions.filter((q) => !q.dropped).length - missed.length} of ${z.questions.filter((q) => !q.dropped).length}.\nQuestions she missed:\n${text}` }], b);
      if (r !== undefined) { out.textContent = String(r).trim(); b.hidden = true; }
    };
    return el("div", {}, b, out);
  }

  /**
   * "This question looks wrong" under a missed question (design QuestionCheckPhone): the phone's model checks it against
   * its lecture and fixes the key or takes the question out of the score; or she says her answer is the right one.
   */
  function questionCheck(c, q, picked, after) {
    if (q.fixed || q.dropped) return el("p", { class: "muted small", dir: "auto" }, q.checkNote || (q.dropped ? L("השאלה הוצאה מהציון.", "The question is out of the score.") : q.fixed.by === "her" ? L("✎ תוקן לפי התשובה שלך", "✎ Fixed to your answer") : L("✎ תוקן לפי ההרצאה", "✎ Fixed by the lecture")));
    if (q.checkNote) return el("p", { class: "muted small", dir: "auto" }, q.checkNote);
    const box = el("div", { class: "api", "aria-live": "polite", hidden: true });
    const done = (note) => { q.checkNote = note; after?.(); x.draw(); };
    const check = el("button", { type: "button", class: "primary" }, L("🔎 לבדוק מול ההרצאה", "🔎 Check against the lecture"));
    check.onclick = async () => {
      const l = c.lectures.find((y) => y.id === q.lectureId) ?? (c.lectures.length === 1 ? c.lectures[0] : undefined);
      if (!l) return done(L("אין לשאלה הזאת הרצאה לבדוק מולה.", "This question has no lecture to check it against."));
      const user = `Question: ${q.q}\nOptions:\n${q.options.map((o, k) => `${k + 1}. ${o}`).join("\n")}\nAnswer key: ${q.answer + 1}${picked >= 0 ? `\nShe answered: ${picked + 1}` : ""}\n\n### Lecture: ${l.title}\n${l.text.slice(0, 12000)}`;
      const r = await need([{ role: "system", content: QUESTION_CHECK_PROMPT }, { role: "user", content: user }], check);
      if (r === undefined) return;
      const got = parseQuestionCheck(String(r), q.options.length, q.answer);
      if (!got) return done(L("המודל לא נתן תשובה ברורה. אפשר לנסות שוב או להחליט בעצמך.", "The model gave no clear answer. Try again, or decide yourself."));
      const why = [got.quote ? `"${got.quote}"` : "", got.explain].filter(Boolean).join(" ");
      if (got.verdict === "fix") { q.fixed = { was: q.answer, by: "model" }; q.answer = got.answer; if (got.explain) q.explain = got.explain; }
      if (got.verdict === "broken") q.dropped = true;
      done(got.verdict === "right" ? L(`המפתח נכון לפי ההרצאה. ${why}`, `The key is right by the lecture. ${why}`)
        : got.verdict === "broken" ? L(`השאלה לא טובה, אז היא לא נספרת בציון. ${why}`, `The question is not a good one, so it does not count. ${why}`)
        : L(`צדקת: תיקנתי את המפתח. ${why}`, `You were right: the key is fixed. ${why}`));
    };
    const mine = el("button", { type: "button", onclick: () => { q.fixed = { was: q.answer, by: "her" }; q.answer = picked; done(L("סימנתי את התשובה שלך כנכונה.", "Your answer is marked right.")); } }, L("✓ התשובה שלי נכונה", "✓ My answer is right"));
    box.append(el("p", { class: "small" }, L("המודל יכול לטעות. בודקים מול ההרצאה, או מסמנים שהתשובה שלך היא הנכונה.", "The model can be wrong. Check it against the lecture, or mark your answer as the right one.")), el("div", { class: "ph-btns", style: "flex-wrap: wrap" }, check, picked >= 0 && mine));
    const open = el("button", { type: "button", onclick: () => { open.hidden = true; box.hidden = false; } }, L("⚠️ נראה לי שהשאלה שגויה", "⚠️ I think this question is wrong"));
    return el("div", {}, open, box);
  }

  /** Homework: a similar problem to practise, and the exercise from a photo. */
  function homeworkExtras(send, q) {
    const shot = x.extract && el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      try {
        const r = await x.extract({ name: "problem.jpg", data: globalThis.btoa(bin) });
        if (!r) return alert(L("לקריאת צילום: בחרי מודל שרואה תמונות (כמו Gemma 4), או התחברי למחשב.", "To read a photo: choose a model that sees pictures (like Gemma 4), or connect to the computer."));
        q.value = String(r.text).replace(/\s*\n+\s*/g, " ").trim().slice(0, 4000);
      } catch (err) {
        alert(String(err?.message || err));
      }
    } });
    return { similar: (b) => void send(`${SIMILAR_MARK} ${L("תרגיל דומה לתרגול, בבקשה (בלי הפתרון)", "A similar problem to practice, please (without the solution)")}`, b), photo: shot ? el("span", {}, shot, el("button", { type: "button", "aria-label": L("צילום התרגיל", "Photo of the exercise"), onclick: () => shot.click() }, "📷")) : "" };
  }

  // ---------- whole views ----------
  /** The study feed: one bite per screen, swiped up. */
  function feed(c) {
    const items = studyFeed(x.toData(c), Math.floor(Date.now() / 86400000));
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("📱 פיד", "📱 Feed")));
    if (!items.length) return x.root.append(el("p", { class: "muted" }, L("הפיד מתמלא מהמונחים, הכרטיסיות, הבחנים והסיכומים. סכמי הרצאה כדי להתחיל.", "The feed fills from terms, cards, quizzes and summaries. Summarize a lecture to start.")));
    const tag = { term: L("מונח", "Term"), card: L("כרטיסייה", "Card"), question: L("שאלה", "Question"), line: L("מהסיכום", "From the summary") };
    x.root.append(el("div", { class: "ph-feed" }, ...items.map((it, i) => {
      const body = [];
      if (it.kind === "term") {
        let saved = false;
        body.push(el("b", { dir: "auto", style: "font-size: 24px" }, it.term), it.en && it.en !== it.term ? el("span", { class: "muted", dir: "ltr" }, it.en) : "", el("p", { dir: "auto" }, it.explain),
          el("button", { type: "button", onclick: (e) => { if (saved) return; newCard(c, it.term, it.explain); if (commit()) { saved = true; e.currentTarget.textContent = L("✓ בכרטיסיות", "✓ In your cards"); } } }, L("💾 לכרטיסיות", "💾 To my cards")));
      } else if (it.kind === "card") {
        const backText = el("p", { dir: "auto", hidden: true }, it.back);
        body.push(el("b", { dir: "auto", style: "font-size: 22px" }, it.front), backText, el("button", { type: "button", onclick: (e) => { backText.hidden = false; e.currentTarget.hidden = true; } }, L("להפוך", "Flip")));
      } else if (it.kind === "question") {
        const why = el("p", { class: "muted small", dir: "auto" });
        const opts = it.options.map((o, k) => el("button", { type: "button", dir: "auto", style: "display: block; width: 100%; text-align: start; margin: 4px 0", onclick: () => { opts.forEach((b, j) => { b.disabled = true; if (j === it.answer) b.style.borderColor = "#6fd3a5"; else if (j === k) b.style.borderColor = "#f08a8a"; }); why.textContent = `${k === it.answer ? L("✓ נכון. ", "✓ Right. ") : L("✗ לא נכון. ", "✗ Not right. ")}${it.explain || ""}`; } }, o));
        body.push(el("b", { dir: "auto" }, it.q), ...opts, why);
      } else body.push(el("p", { dir: "auto", style: "font-size: 20px; line-height: 1.6" }, it.text));
      return el("section", { class: "ph-bite" }, el("small", { class: "muted" }, `${tag[it.kind]}${it.lecture ? ` · ${it.lecture}` : ""} · ${i + 1}/${items.length}`), ...body, i === 0 ? el("small", { class: "muted" }, L("↑ לגלול למעלה לפריט הבא", "↑ Swipe up for the next")) : "");
    }), el("section", { class: "ph-bite" }, el("b", {}, L("🎉 זהו להיום!", "🎉 That's it for today!")))));
  }

  /** The course as a web: lectures joined by the terms they share. */
  function web(c) {
    const w = courseWeb(c.lectures);
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("🕸 מפת הקורס", "🕸 Course web")));
    if (w.nodes.length < 2 || !w.edges.length) return x.root.append(el("p", { class: "muted" }, L("המפה נבנית כשיש לפחות שתי הרצאות עם מונחים משותפים.", "The web appears with at least two lectures that share terms.")));
    const title = (id) => w.nodes.find((n) => n.id === id)?.title ?? "";
    x.root.append(section("", ...w.nodes.map((n) => {
      const links = w.edges.filter((e) => e.a === n.id || e.b === n.id);
      return el("div", { class: "ph-row", style: "flex-direction: column; align-items: stretch" },
        el("button", { type: "button", class: "link", dir: "auto", style: "text-align: start; font-weight: 700", onclick: () => go({ at: "lecture", course: c.id, lecture: n.id }) }, n.title),
        ...(links.length ? links.map((e) => el("small", { dir: "auto" }, `↔ ${title(e.a === n.id ? e.b : e.a)} · ${e.terms.join(", ")}`)) : [el("small", { class: "muted" }, L("אין מונחים משותפים עם הרצאות אחרות", "No shared terms with other lectures"))]));
    })));
  }

  /** The memory palace: spots in a place she knows, each holding a term in a vivid scene; then walk and recall. */
  function palace(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("🏛 ארמון זיכרון", "🏛 Memory palace")));
    const terms = c.lectures.flatMap((l) => l.terms ?? []);
    if (terms.length < 2) return x.root.append(el("p", { class: "muted" }, L("ארמון זיכרון נבנה מהמונחים של ההרצאות. סכמי הרצאה אחת לפחות.", "A palace is built from the lectures' terms. Summarize a lecture first.")));
    const v = x.view;
    if (v.walk !== undefined && c.palace) {
      const it = c.palace.items[v.walk];
      if (!it) return x.root.append(section(L(`זכרת ${v.got} מתוך ${c.palace.items.length}`, `You recalled ${v.got} of ${c.palace.items.length}`), btns(el("button", { type: "button", class: "primary", onclick: () => go({ ...v, walk: 0, got: 0, shown: false }) }, L("עוד הליכה", "Walk again")), el("button", { type: "button", onclick: () => go({ at: "palace", course: c.id }) }, L("לראות את הארמון", "See the palace")))));
      return x.root.append(section(`📍 ${it.spot}`, el("p", { class: "muted" }, L("איזה מונח מחכה כאן?", "Which term waits here?")),
        v.shown ? el("div", {}, el("p", { dir: "auto" }, it.scene), el("b", { dir: "auto" }, it.term), el("p", { dir: "auto", class: "small" }, it.explain),
          btns(el("button", { type: "button", class: "primary", onclick: () => go({ ...v, walk: v.walk + 1, got: v.got + 1, shown: false }) }, L("זכרתי ✓", "Recalled ✓")), el("button", { type: "button", onclick: () => go({ ...v, walk: v.walk + 1, shown: false }) }, L("לא זכרתי", "I did not"))))
          : el("button", { type: "button", class: "primary", onclick: () => go({ ...v, shown: true }) }, L("לגלות", "Reveal"))));
    }
    if (c.palace && !v.build) {
      return x.root.append(section(`🏛 ${c.palace.place}`, ...c.palace.items.map((it) => el("p", { dir: "auto" }, el("b", {}, `📍 ${it.spot} ← ${it.term}`), el("br"), it.scene)),
        btns(el("button", { type: "button", class: "primary", onclick: () => go({ ...v, walk: 0, got: 0, shown: false }) }, L("ללכת ולהיזכר", "Walk and recall")), el("button", { type: "button", onclick: () => go({ ...v, build: true }) }, L("ארמון חדש", "New palace")))));
    }
    const place = el("input", { dir: "auto", value: L("הבית שלי", "My home"), "aria-label": L("המקום", "The place") });
    const spots = el("textarea", { rows: "6", dir: "auto", "aria-label": L("הפינות", "The spots") });
    spots.value = PALACE_SPOTS_HE.slice(0, 8).join("\n");
    const b = el("button", { type: "button", class: "primary" }, L("לבנות ארמון", "Build the palace"));
    b.onclick = async () => {
      const sp = spots.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 12);
      const pairs = sp.map((spot, i) => terms[i] && { spot, term: terms[i].term, explain: terms[i].explain }).filter(Boolean);
      if (pairs.length < 2) return alert(L("צריך לפחות שתי פינות.", "At least two spots."));
      const r = await need([{ role: "system", content: PALACE_PROMPT }, { role: "user", content: pairs.map((p, i) => `${i + 1}. Spot: ${p.spot}\n   Term: ${p.term}\n   Meaning: ${p.explain}`).join("\n") }], b);
      const list = r && jsonIn(r);
      const p = cleanPalace({ place: place.value, items: pairs.map((q, i) => ({ ...q, scene: Array.isArray(list) ? list[i]?.scene : undefined })), t: Date.now() });
      if (!p || p.items.length < pairs.length) return r !== undefined && alert(L("המודל לא כתב סצנה לכל פינה. נסי שוב.", "The model did not write a scene for every spot. Try again."));
      c.palace = p;
      if (commit()) go({ at: "palace", course: c.id });
    };
    x.root.append(section("", el("p", { class: "muted small" }, L("כל מונח נקשר לפינה במקום שאת מכירה, בסצנה מוזרה ומצחיקה. אחר כך הולכים בדמיון והמונחים חוזרים.", "Each term is tied to a spot you know, in a funny scene; walk it in your mind and they come back.")),
      el("label", { class: "ph-filter" }, L("המקום: ", "Place: "), place), el("small", { class: "muted" }, L("הפינות, שורה לכל אחת, לפי הסדר:", "The spots, one a line, in order:")), spots, b));
  }

  /** A letter to the lecturer or the secretariat, drafted by the phone's model; she sends it herself. */
  function letter(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("✉️ מכתב למרצה", "✉️ Letter to the lecturer")));
    const kind = el("select", { "aria-label": L("סוג המכתב", "Kind of letter") }, ...[["extension", "⏳ בקשת הארכה", "⏳ An extension"], ["reserve", "🎖 התאמות אחרי מילואים", "🎖 Reserve-duty accommodations"], ["appeal", "📝 ערעור על ציון", "📝 A grade appeal"], ["special", "📅 מועד מיוחד", "📅 A special exam date"], ["other", "✉️ משהו אחר", "✉️ Something else"]].map(([k, h, e]) => el("option", { value: k }, L(h, e))));
    const to = el("input", { dir: "auto", placeholder: L("אל: ד״ר כהן / מזכירות", "To: Dr Cohen / the office") });
    const name = el("input", { dir: "auto", placeholder: L("השם שלך", "Your name") });
    // Her name is kept for the next letter (t144).
    try { name.value = localStorage.getItem("kesherai-letter-name") || ""; } catch { /* none */ }
    name.addEventListener("input", () => { try { localStorage.setItem("kesherai-letter-name", name.value.slice(0, 80)); } catch { /* full */ } });
    const details = el("textarea", { rows: "3", dir: "auto", placeholder: L("הפרטים: מה ולמה", "The details: what and why") });
    const subject = el("input", { dir: "auto", hidden: true, "aria-label": L("נושא", "Subject") });
    const body = el("textarea", { rows: "10", dir: "auto", hidden: true, "aria-label": L("המכתב", "The letter") });
    const out = el("div", { hidden: true }, btns(
      el("button", { type: "button", onclick: () => void navigator.clipboard?.writeText(`${subject.value}\n\n${body.value}`).then(() => alert(L("הועתק", "Copied"))) }, L("העתקה", "Copy")),
      el("a", { class: "button", href: "#", onclick: (e) => { e.currentTarget.href = `mailto:?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`; } }, L("לפתוח במייל", "Open in mail"))),
      el("small", { class: "muted" }, L("זו טיוטה: כדאי לקרוא ולתקן לפני השליחה. האפליקציה לא שולחת בשבילך.", "A draft: read and fix it first. The app does not send it for you.")));
    const b = el("button", { type: "button", class: "primary" }, L("לכתוב טיוטה", "Write a draft"));
    b.onclick = async () => {
      const r = await need([{ role: "system", content: letterPrompt(kind.value) }, { role: "user", content: `Course: ${c.name}\nTo: ${to.value || "(the lecturer)"}\nHer name: ${name.value || "(not given)"}\nHer details: ${details.value || "(none)"}` }], b);
      if (r === undefined) return;
      const p = parseLetter(String(r));
      subject.value = p.subject;
      body.value = p.body;
      subject.hidden = body.hidden = out.hidden = false;
    };
    x.root.append(section("", kind, to, name, details, b, subject, body, out));
  }

  /**
   * 🎤 Ask by voice (like Gemini Notebook's voice conversations): tap, speak, tap again; transcribed on the phone and
   * handed to `onText`. Nothing is kept. Hidden when the app has no speech engine.
   */
  function micButton(onText) {
    if (!x.speech?.transcribe) return "";
    let rec = null;
    const b = el("button", { type: "button", "aria-label": L("לשאול בקול", "Ask by voice"), title: L("לשאול בקול", "Ask by voice") }, "🎤");
    b.onclick = async () => {
      if (rec) { const r = rec; rec = null; return r.stop(); }
      if (!(await x.speech.available?.().catch(() => false))) return alert(L("בגרסה הזאת של האפליקציה אין מנוע דיבור. עדכני את האפליקציה.", "This build of the app has no speech engine. Update the app."));
      if (!(await x.speech.hasModel().catch(() => false))) return alert(L("קודם הכיני את זיהוי הדיבור בטלפון: הקליטי הרצאה פעם אחת (🎙 הקלט הרצאה) והאפליקציה תוריד אותו.", "First set up speech on the phone: record a lecture once (🎙 Record a lecture) and the app downloads it."));
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return alert(L("אין גישה למיקרופון.", "No microphone access.")); }
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(node);
      node.connect(ctx.destination);
      b.textContent = "⏹";
      b.setAttribute("aria-label", L("סיימתי לדבר", "Done speaking"));
      rec = { stop: async () => {
        node.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
        b.textContent = "…";
        b.disabled = true;
        const text = (await x.speech.transcribe(x.wavBase64(chunks, ctx.sampleRate), "auto").catch(() => "")).trim();
        b.textContent = "🎤";
        b.disabled = false;
        b.setAttribute("aria-label", L("לשאול בקול", "Ask by voice"));
        if (!text) return alert(L("לא נשמע דיבור.", "No speech was heard."));
        onText(text);
      } };
    };
    return b;
  }

  /** 🔊 Reads one of the tutor's answers aloud (the phone's voice); a second tap stops it. */
  function sayButton(text) {
    if (!x.say) return "";
    let on = false;
    const b = el("button", { type: "button", class: "link", "aria-label": L("להקריא", "Read aloud") }, "🔊");
    b.onclick = async () => {
      if (on) { on = false; x.say.stop?.(); b.textContent = "🔊"; return; }
      on = true;
      b.textContent = "⏹";
      try { await x.say(text.replace(/\[(?:Lecture|הרצאה)[^\]]*\]/g, "")); } finally { on = false; b.textContent = "🔊"; }
    };
    return b;
  }

  /** Presentation rehearsal: recorded on the phone, transcribed on the phone, numbers and the model's notes. */
  function rehearse(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("🎤 חזרה על הצגה", "🎤 Rehearse a talk")));
    const target = el("select", {}, ...[2, 3, 5, 7, 10, 15].map((n) => el("option", { value: String(n) }, L(`${n} דק׳`, `${n} min`))));
    target.value = "5";
    const state = el("p", { class: "muted small", "aria-live": "polite" });
    const result = el("div");
    let rec = null;
    const b = el("button", { type: "button", class: "primary" }, L("🎙 להתחיל", "🎙 Start"));
    b.onclick = async () => {
      if (rec) { const r = rec; rec = null; return r.stop(); }
      if (!(await x.speech.available?.().catch(() => false))) return alert(L("בגרסה הזאת של האפליקציה אין מנוע דיבור. עדכני את האפליקציה.", "This build of the app has no speech engine. Update the app."));
      if (!(await x.speech.hasModel().catch(() => false))) return alert(L("קודם הכיני את זיהוי הדיבור בטלפון: הקליטי הרצאה פעם אחת (🎙 הקלט הרצאה) והאפליקציה תוריד אותו.", "First set up speech on the phone: record a lecture once (🎙 Record a lecture) and the app downloads it."));
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return alert(L("אין גישה למיקרופון.", "No microphone access.")); }
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(node);
      node.connect(ctx.destination);
      const began = Date.now();
      b.textContent = L("⏹ סיימתי", "⏹ Done");
      state.textContent = L("מקליט… דברי כמו מול הכיתה.", "Recording… talk as in front of the class.");
      rec = { stop: async () => {
        node.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const seconds = Math.max(1, Math.round((Date.now() - began) / 1000));
        await ctx.close();
        b.textContent = L("🎙 להתחיל", "🎙 Start");
        state.textContent = L("מתמלל בטלפון…", "Transcribing on the phone…");
        const text = (await x.speech.transcribe(x.wavBase64(chunks, ctx.sampleRate), "")).trim();
        state.textContent = "";
        if (!text) return alert(L("לא נשמע דיבור.", "No speech was heard."));
        const s = speechStats(text, seconds);
        const mm = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        const notes = el("p", { dir: "auto", style: "white-space: pre-wrap" });
        const ask = el("button", { type: "button", class: "primary" }, L("💬 הערות על התוכן והמבנה", "💬 Notes on content and structure"));
        ask.onclick = async () => {
          const passages = findPassages(c.lectures, text.slice(0, 2000), 3000).map((p) => `[${p.title}]\n${p.text}`).join("\n\n");
          const r = await need([{ role: "system", content: REHEARSE_PROMPT }, { role: "user", content: `Seconds: ${seconds} (her time: ${target.value} minutes). Words: ${s.words}. Words a minute: ${s.wpm}. Filler words: ${s.fillers.map((f) => `${f.word} ×${f.n}`).join(", ") || "none"} (${s.fillerShare}%).\n\nHer talk:\n${text.slice(0, 6000)}\n\nLecture passages:\n${passages || "(none)"}` }], ask);
          if (r !== undefined) { notes.textContent = String(r).trim(); ask.hidden = true; }
        };
        result.replaceChildren(section("",
          el("p", {}, el("b", {}, mm), " · ", L(`${s.wpm} מילים לדקה`, `${s.wpm} words a minute`), " · ", L(`${s.fillerShare}% מילות מילוי`, `${s.fillerShare}% filler words`)),
          s.fillers.length ? el("p", { class: "small" }, s.fillers.slice(0, 5).map((f) => `${f.word} ×${f.n}`).join(", ")) : el("p", { class: "small" }, L("בלי מילות מילוי 👏", "No filler words 👏")),
          el("details", {}, el("summary", {}, L("מה נשמע", "What was heard")), el("p", { dir: "auto", class: "small" }, text)), ask, notes));
      } };
    };
    x.root.append(section("", el("p", { class: "muted small" }, L("אומרים את ההצגה כמו מול הכיתה. התמלול נעשה בטלפון, וההקלטה לא נשמרת.", "Give the talk as in front of the class. It is transcribed on the phone and not kept.")), el("label", { class: "ph-filter" }, L("הזמן שהוקצב: ", "Your time: "), target), b, state), result);
  }

  /** Papers: OpenAlex over the phone's internet, "what the studies say" by the phone's model, the course's sources. */
  function papers(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("📚 מאמרים ומקורות", "📚 Papers and sources")));
    const q = el("input", { type: "search", dir: "auto", placeholder: L("נושא באנגלית, או DOI", "A topic, or a DOI") });
    const found = el("div");
    const save = (p) => {
      c.sources ??= [];
      if (c.sources.some((s) => (p.doi && s.doi === p.doi) || s.title.toLowerCase() === p.title.toLowerCase())) return alert(L("כבר במקורות", "Already in your sources"));
      c.sources.push({ ...p, id: `s${uid().slice(0, 8)}`, t: Date.now() });
      if (commit()) x.draw();
    };
    const go2 = el("button", { type: "button", class: "primary" }, L("חיפוש", "Search"));
    go2.onclick = async () => {
      const doi = cleanDoi(q.value);
      const sel = "id,doi,title,display_name,publication_year,authorships,primary_location,biblio,open_access,best_oa_location,abstract_inverted_index,cited_by_count";
      go2.disabled = true;
      try {
        const r = await fetch(doi ? `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=${sel}` : `https://api.openalex.org/works?search=${encodeURIComponent(q.value.trim().slice(0, 300))}&per-page=10&select=${sel}`);
        const list = r.ok ? parseOpenAlex(await r.json()) : [];
        const withAbs = list.filter((p) => p.abstract).slice(0, 8);
        const say = el("button", { type: "button" }, L("💡 מה המחקרים אומרים?", "💡 What do the studies say?"));
        const answer = el("p", { dir: "auto", style: "white-space: pre-wrap" });
        say.onclick = async () => {
          const material = withAbs.map((p, i) => `[${i + 1}] ${p.title} (${p.year ?? "n.d."})\n${p.abstract.slice(0, 1200)}`).join("\n\n");
          const heb = /[֐-׿]/.test(q.value);
          const a = await need([{ role: "system", content: `${PAPERS_PROMPT}${heb ? " Write the whole answer in Hebrew (עברית)." : ""}` }, { role: "user", content: `Question: ${q.value}\n\nPapers:\n${material}` }], say);
          if (a !== undefined) answer.textContent = String(a).trim();
        };
        found.replaceChildren(...(list.length ? [withAbs.length > 1 ? el("div", {}, say, answer) : "", ...list.map((p) => el("div", { class: "ph-row", style: "flex-direction: column; align-items: stretch" },
          el("b", { dir: "auto" }, `${withAbs.includes(p) ? `[${withAbs.indexOf(p) + 1}] ` : ""}${p.title}`), el("small", { class: "muted", dir: "auto" }, [p.authors.slice(0, 3).join(", "), p.year, p.venue].filter(Boolean).join(" · ")),
          btns(el("button", { type: "button", onclick: () => save(p) }, L("שמירה למקורות", "Save to sources")), p.pdf ? el("a", { class: "button", href: p.pdf, target: "_blank", rel: "noreferrer" }, "PDF ↗") : "")))] : [el("p", { class: "muted" }, L("לא נמצאו מאמרים (צריך אינטרנט). נסי מילים אחרות.", "No papers found (needs internet). Try other words."))]));
      } catch {
        found.replaceChildren(el("p", { class: "muted" }, L("אין חיבור לאינטרנט.", "No internet connection.")));
      } finally {
        go2.disabled = false;
      }
    };
    let style = "apa";
    try { style = localStorage.getItem("kesherai-cite-style") === "chicago" ? "chicago" : "apa"; } catch { /* a convenience */ }
    const ref = style === "chicago" ? chicagoRef : apaRef;
    const cite = style === "chicago" ? chicagoCite : apaCite;
    const src = cleanSources(c.sources ?? []).sort((a, b) => ref(a).localeCompare(ref(b)));
    // A BibTeX or RIS file from Zotero, Mendeley or EndNote: its sources join the course's (same DOI or title skipped).
    const pick = el("input", { type: "file", accept: ".bib,.ris,.txt,text/plain", hidden: true, onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      const text = await f.text();
      const found = /^\s*TY {2}- /m.test(text) ? parseRis(text) : parseBibtex(text);
      c.sources ??= [];
      let added = 0;
      for (const p of found) {
        if (c.sources.length >= 500 || c.sources.some((s) => (p.doi && s.doi === p.doi) || s.title.toLowerCase() === p.title.toLowerCase())) continue;
        c.sources.push({ ...p, id: `s${uid().slice(0, 8)}`, t: Date.now() });
        added++;
      }
      if (commit()) { alert(L(`נוספו ${added} מקורות (מתוך ${found.length} בקובץ)`, `${added} sources added (of ${found.length} in the file)`)); x.draw(); }
    } });
    const styleSel = el("select", { "aria-label": L("סגנון ציטוט", "Citation style"), onchange: (e) => { try { localStorage.setItem("kesherai-cite-style", e.target.value); } catch { /* a convenience */ } x.draw(); } }, el("option", { value: "apa" }, "APA 7"), el("option", { value: "chicago" }, "Chicago"));
    styleSel.value = style;
    const share = (text, name, type) => {
      const f = new globalThis.File([text], name, { type });
      if (navigator.canShare?.({ files: [f] })) return void navigator.share({ files: [f] }).catch(() => undefined);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type }));
      a.download = name;
      a.click();
    };
    x.root.append(section("", el("div", { class: "ph-filter" }, q, go2), found),
      section(L(`המקורות של הקורס (${src.length})`, `The course's sources (${src.length})`),
        btns(pick, el("button", { type: "button", onclick: () => pick.click() }, L("📥 ייבוא מ-Zotero (BibTeX / RIS)", "📥 Import from Zotero (BibTeX / RIS)")), styleSel),
        ...src.map((s) => el("div", { class: "ph-row", style: "flex-direction: column; align-items: stretch" }, el("small", { dir: "ltr", style: "text-align: left" }, ref(s)),
          btns(el("button", { type: "button", onclick: () => void navigator.clipboard?.writeText(ref(s)) }, L("העתקה", "Copy")), el("button", { type: "button", onclick: () => void navigator.clipboard?.writeText(cite(s)) }, cite(s)),
            el("button", { type: "button", "aria-label": L("להסיר", "Remove"), onclick: () => { c.sources = (c.sources ?? []).filter((y) => y.id !== s.id); c.removed = [...(c.removed ?? []), s.id]; if (commit()) x.draw(); } }, "✕")))),
        src.length ? btns(el("button", { type: "button", onclick: () => share(toBibtex(src), "sources.bib", "text/plain") }, "BibTeX"), el("button", { type: "button", onclick: () => share(toRis(src), "sources.ris", "text/plain") }, "RIS")) : el("p", { class: "muted small" }, L("מאמרים ששומרים מגיעים לכאן, עם הפניה ב-APA 7.", "Saved papers come here, with an APA 7 reference."))));
  }

  /** Grades on the phone: the weighted average, the degree's progress and "should I take Moed B?". */
  function grades() {
    let g;
    try { g = cleanGrades(JSON.parse(localStorage.getItem(GRADES_KEY) || "{}")); } catch { g = cleanGrades({}); }
    const save = () => { try { localStorage.setItem(GRADES_KEY, JSON.stringify({ ...g, t: Date.now() })); } catch { alert(L("אין מקום לשמור.", "No room to save.")); } x.draw(); };
    const num = (v) => (String(v).trim() === "" ? undefined : Number(v));
    x.root.append(back({ at: "home" }), el("h2", {}, L("🎓 ציונים, ממוצע ותואר", "🎓 Grades, average and degree")));
    const { average, credits } = weightedAverage(g.rows);
    x.root.append(section(average !== undefined ? L(`ממוצע ${average} · ${credits} נק"ז`, `Average ${average} · ${credits} credits`) : L("להוסיף קורסים", "Add courses"),
      ...g.rows.map((r) => {
        const { grade, sofar } = rowGrade(r);
        const score = el("input", { type: "number", min: "0", max: "100", style: "width: 72px", value: r.final ?? "", placeholder: L("ציון", "Grade"), onchange: (e) => { const v = num(e.target.value); if (v === undefined) delete r.final; else r.final = v; save(); } });
        const cr = el("input", { type: "number", min: "0", max: "30", step: "0.5", style: "width: 64px", value: r.credits, onchange: (e) => { r.credits = num(e.target.value) ?? 0; save(); } });
        const kind = g.kinds?.length ? el("select", { onchange: (e) => { if (e.target.value) r.kind = e.target.value; else delete r.kind; save(); } }, el("option", { value: "" }, L("סוג…", "Kind…")), ...g.kinds.map((k) => el("option", { value: k.id }, k.name))) : "";
        if (kind) kind.value = r.kind ?? "";
        const binary = el("input", { type: "checkbox", onchange: (e) => { if (e.target.checked) r.binary = true; else { delete r.binary; delete r.passed; } save(); } });
        binary.checked = !!r.binary;
        const moedOut = el("small", { dir: "auto" });
        const moed = !r.binary && r.final === undefined && r.parts.some((p) => p.score !== undefined) && el("input", { type: "number", min: "0", max: "100", style: "width: 72px", placeholder: L("מועד ב׳", "Moed B"), oninput: (e) => {
          const v = num(e.target.value);
          const m = v !== undefined && moedB(g, r.id, v);
          moedOut.textContent = m ? L(`קורס ${m.course.now ?? "—"} ← ${m.course.withB ?? "—"} · ממוצע ${m.average.now ?? "—"} ← ${m.average.withB ?? "—"}`, `Course ${m.course.now ?? "—"} → ${m.course.withB ?? "—"} · average ${m.average.now ?? "—"} → ${m.average.withB ?? "—"}`) : "";
        } });
        return el("div", { class: "ph-row", style: "flex-direction: column; align-items: stretch" },
          el("div", { class: "ph-filter" }, el("b", { dir: "auto" }, r.name), el("span", {}, r.binary ? (r.passed === undefined ? "—" : r.passed ? L("עבר", "Pass") : L("נכשל", "Fail")) : grade ?? (sofar !== undefined ? L(`עד עכשיו ${sofar}`, `so far ${sofar}`) : "—"))),
          el("div", { class: "ph-filter", style: "flex-wrap: wrap" }, L('נק"ז ', "Credits "), cr, r.binary ? "" : score, kind, el("label", {}, binary, L(" עובר/נכשל", " pass/fail")),
            r.binary ? (() => { const s = el("select", { onchange: (e) => { if (e.target.value) r.passed = e.target.value === "1"; else delete r.passed; save(); } }, el("option", { value: "" }, L("עוד לא", "Not yet")), el("option", { value: "1" }, L("עבר", "Pass")), el("option", { value: "0" }, L("נכשל", "Fail"))); s.value = r.passed === undefined ? "" : r.passed ? "1" : "0"; return s; })() : "",
            el("button", { type: "button", "aria-label": L("להסיר", "Remove"), onclick: () => { g.rows = g.rows.filter((y) => y.id !== r.id); save(); } }, "✕")),
          moed ? el("div", { class: "ph-filter" }, L("לגשת למועד ב׳? ציון צפוי: ", "Take Moed B? Expected: "), moed) : "", moedOut);
      }),
      (() => {
        const name = el("input", { dir: "auto", placeholder: L("שם הקורס", "Course name") });
        return el("div", { class: "ph-filter" }, name, el("button", { type: "button", onclick: () => { if (!name.value.trim()) return; g.rows.push({ id: `g${Date.now().toString(36)}`, name: name.value.trim(), credits: 0, parts: [] }); save(); } }, L("+ קורס", "+ Course")));
      })()));
    const p = degreeProgress(g);
    const kinds = el("textarea", { rows: "4", dir: "auto", placeholder: L("חובה 90\nבחירה 18\nכלליים 8\nאנגלית 4", "Required 90\nElectives 18\nGeneral 8\nEnglish 4") });
    kinds.value = (g.kinds ?? []).map((k) => `${k.name} ${k.need}`).join("\n");
    x.root.append(section(L("התקדמות בתואר", "Degree progress"),
      ...(g.kinds?.length ? [el("p", {}, L(`${p.total.done} מתוך ${p.total.need} נק"ז · ${p.total.doing} עכשיו · חסרות ${p.total.missing}`, `${p.total.done} of ${p.total.need} · ${p.total.doing} now · ${p.total.missing} missing`)), ...p.kinds.map((k) => el("p", { class: "small", dir: "auto" }, `${k.name}: ${k.done}/${k.need}${k.doing ? L(` (+${k.doing} עכשיו)`, ` (+${k.doing} now)`) : ""}${k.missing ? L(` · חסרות ${k.missing}`, ` · ${k.missing} missing`) : " ✓"}`))] : [el("p", { class: "muted small" }, L("כמה נק\"ז צריך מכל סוג: שורה לכל סוג, שם ומספר.", "Credits each kind needs: one line per kind, name and number."))]),
      kinds, el("button", { type: "button", onclick: () => { g.kinds = kinds.value.split("\n").map((line, i) => { const m = /^(.+?)\s+(\d+(?:\.\d+)?)\s*$/.exec(line.trim()); return m ? { id: `k${i}`, name: m[1], need: Number(m[2]) } : null; }).filter(Boolean); save(); } }, L("שמירת דרישות התואר", "Save the requirements")),
      (() => { const s = el("select", { onchange: (e) => { g.moedRule = e.target.value; save(); } }, el("option", { value: "last" }, L("במועד ב׳ קובע הציון האחרון", "On a retake the last exam counts")), el("option", { value: "best" }, L("במועד ב׳ קובע הגבוה", "On a retake the higher counts"))); s.value = g.moedRule ?? "last"; return s; })()));
  }

  /** Academic English practice from a text she pastes: comprehension questions and its hard words into cards. */
  function english() {
    x.root.append(back({ at: "home" }), el("h2", {}, L("📘 אנגלית אקדמית", "📘 Academic English")));
    const text = el("textarea", { rows: "6", dir: "ltr", placeholder: L("הדביקי טקסט באנגלית: מאמר או פסקה", "Paste an English text: an article or a paragraph") });
    const out = el("div");
    const b = el("button", { type: "button", class: "primary" }, L("לתרגל על הטקסט", "Practise on this text"));
    b.onclick = async () => {
      if ((text.value.match(/[A-Za-z]/g) ?? []).length < 200) return alert(L("הדביקי לפחות פסקה באנגלית.", "Paste at least a paragraph in English."));
      const r = await need([{ role: "system", content: ENGLISH_PROMPT }, { role: "user", content: text.value.slice(0, 5000) }], b);
      const p = r && cleanEnglish(jsonIn(r));
      if (!p?.questions.length) return r !== undefined && alert(L("המודל לא כתב שאלות. נסי שוב.", "The model wrote no questions. Try again."));
      const course = el("select", {}, ...x.db().courses.map((c) => el("option", { value: c.id }, c.name)));
      // The score after the last answer (t141).
      let right = 0, answered = 0;
      const score = el("p", { class: "small", "aria-live": "polite" });
      out.replaceChildren(...p.questions.map((q) => {
        const why = el("p", { class: "muted small", dir: "auto" });
        const opts = q.options.map((o, k) => el("button", { type: "button", dir: "ltr", style: "display: block; width: 100%; text-align: left; margin: 4px 0", onclick: () => { opts.forEach((y, j) => { y.disabled = true; if (j === q.answer) y.style.borderColor = "#6fd3a5"; else if (j === k) y.style.borderColor = "#f08a8a"; }); why.textContent = q.explain; answered++; if (k === q.answer) right++; if (answered === p.questions.length) score.textContent = L(`${right} מתוך ${p.questions.length}`, `${right} of ${p.questions.length}`); } }, o));
        return section("", el("b", { dir: "ltr" }, q.q), ...opts, why);
      }), score, p.words.length ? section(L("מילים מהטקסט", "Words from the text"), ...p.words.map((w) => el("div", { class: "ph-row" }, el("span", { dir: "ltr" }, w.en), el("span", { dir: "rtl" }, w.he))),
        x.db().courses.length ? el("div", { class: "ph-filter" }, course, el("button", { type: "button", onclick: () => { const c = x.db().courses.find((y) => y.id === course.value); if (!c) return; for (const w of p.words) newCard(c, w.en, w.he); if (commit()) alert(L(`נוספו ${p.words.length} כרטיסיות`, `${p.words.length} cards added`)); } }, L("📇 לכרטיסיות", "📇 Into cards"))) : "") : "");
    };
    x.root.append(section("", text, b), out);
  }

  // ---------- a mock exam on the phone alone (the computer's design MockExam, students part 27 #1) ----------
  /**
   * A full exam under time: multiple-choice questions from all her lectures (5 at a time, the phone's model is small)
   * and, if she wants, open questions; one countdown (a quarter more with extra time); at the end the grade out of 100,
   * how she did per lecture, and each open answer checked against the lectures. Kept with the course's quizzes, so the
   * computer shows it in her mock exams too.
   */
  function mock(c) {
    const v = x.view;
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("📝 מבחן דמה", "📝 Mock exam")));
    if (!c.lectures.length) return x.root.append(el("p", { class: "muted" }, L("מבחן דמה נבנה מההרצאות. הוסיפי הרצאה קודם.", "A mock exam is built from the lectures. Add a lecture first.")));
    const z = v.mock;
    if (!z) {
      const choice = el("select", { "aria-label": L("שאלות אמריקאיות", "Multiple-choice questions") }, ...[10, 15, 20].map((n) => el("option", { value: String(n) }, L(`${n} אמריקאיות`, `${n} multiple choice`))));
      const open = el("select", { "aria-label": L("שאלות פתוחות", "Open questions") }, ...[0, 2, 3].map((n) => el("option", { value: String(n) }, n ? L(`${n} פתוחות`, `${n} open`) : L("בלי פתוחות", "No open ones"))));
      const extra = el("input", { type: "checkbox" });
      const status = el("p", { class: "muted small", "aria-live": "polite" });
      const go2 = el("button", { type: "button", class: "primary" }, L("לבנות את המבחן", "Build the exam"));
      go2.onclick = async () => {
        const n = Number(choice.value);
        const o = Number(open.value);
        const material = c.lectures.slice(-8).map((l, i) => `### Lecture ${i + 1}: ${l.title}\n${(l.summary || l.text).slice(0, 1500)}`).join("\n\n");
        const ids = c.lectures.slice(-8).map((l) => l.id);
        const qs = [];
        for (let k = 0; qs.length < n && k < Math.ceil(n / 5) + 2; k++) {
          status.textContent = L(`כותב שאלות… ${qs.length}/${n} (בטלפון זה לוקח זמן)`, `Writing questions… ${qs.length}/${n} (this takes a while on a phone)`);
          const r = await need([{ role: "system", content: `Write 5 multiple-choice questions for an exam from the material, 4 options each, exactly one right, different topics from: ${qs.map((q) => q.q.slice(0, 60)).join(" | ") || "none yet"}. Write in the same language as the material. Use only what the material says. Answer with JSON only: [{"q":"...","options":["...","...","...","..."],"answer":0,"explain":"...","lecture":1}]` }, { role: "user", content: material }], go2);
          if (r === undefined) return;
          const list = jsonIn(r);
          for (const q of Array.isArray(list) ? list : []) {
            if (!(q?.q && Array.isArray(q.options) && q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length)) continue;
            const checked = checkCalcQuestion({ ...q, options: q.options.map(String) });
            if (!checked) continue;
            if (ids[Number(q.lecture) - 1]) checked.lectureId = ids[Number(q.lecture) - 1];
            if (qs.length < n) qs.push(checked);
          }
        }
        let openQs = [];
        if (o) {
          status.textContent = L("כותב שאלות פתוחות…", "Writing open questions…");
          const r = await need([{ role: "system", content: OPEN_QUIZ_PROMPT("open") }, { role: "user", content: `Write exactly ${o} questions, then stop.\n\n${material}` }], go2);
          openQs = r ? parseOpenQuestions(r, ids, o) : [];
        }
        status.textContent = "";
        if (qs.length < 3) return alert(L("המודל לא כתב מספיק שאלות. נסי שוב.", "The model did not write enough questions. Try again."));
        const minutes = mockMinutes(qs.length, openQs.length);
        x.go({ ...v, mock: { group: `m${uid().slice(0, 10)}`, minutes, extra: extra.checked, ends: Date.now() + mockTime({ minutes, extra: extra.checked }) * 60000, qs, openQs, picked: [], texts: [] } });
      };
      return x.root.append(section("", el("p", { class: "muted small" }, L("מבחן שלם בזמן אמת מכל ההרצאות, עם שעון. בסוף: ציון מתוך 100 ואיפה כדאי לחזור.", "A full timed exam from all the lectures. At the end: a grade out of 100 and where to go back.")),
        el("div", { class: "ph-filter", style: "flex-wrap: wrap" }, choice, open), el("label", { class: "ph-filter" }, extra, L(" תוספת זמן (25%)", " Extra time (25%)")), go2, status));
    }
    if (!z.done) {
      const left = el("b", { "aria-live": "off" });
      const finish = async (b) => {
        clearInterval(t);
        if (b) { b.disabled = true; b.textContent = L("בודק…", "Checking…"); }
        const marks = [];
        const feedback = [];
        for (const [i, q] of z.openQs.entries()) {
          const text = (z.texts[i] || "").trim();
          if (!text) { marks.push(0); feedback.push(L("לא נכתבה תשובה.", "No answer was written.")); continue; }
          const r = await need(openGradeMessages({ lectures: c.lectures, question: q, text, budget: 2500 }));
          const m = r ? openMark(r, /[\u0590-\u05ff]/.test(q.q)) : undefined;
          marks.push(m?.mark ?? 0);
          feedback.push(m?.line ?? L("לא הצלחתי לבדוק את התשובה הזאת.", "Could not check this answer."));
        }
        const at = Date.now();
        const m = { group: z.group, minutes: z.minutes, ...(z.extra ? { extra: true } : {}) };
        const score = z.qs.filter((q, i) => z.picked[i] === q.answer).length;
        c.quizzes ??= [];
        c.quizzes.push({ id: uid(), t: at, questions: z.qs, answers: z.qs.map((_, i) => z.picked[i] ?? -1), score, mock: m });
        if (z.openQs.length) c.quizzes.push({ id: uid(), t: at, kind: "open", questions: z.openQs, answers: z.openQs.map(() => -1), texts: z.texts, marks, feedback, score: marks.reduce((a, b2) => a + b2, 0), mock: m });
        commit();
        x.go({ ...v, mock: { ...z, done: true, feedback } });
      };
      const t = setInterval(() => {
        if (!left.isConnected) return clearInterval(t);
        const s = Math.max(0, Math.round((z.ends - Date.now()) / 1000));
        left.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        if (!s) void finish();
      }, 1000);
      const submit = el("button", { type: "button", class: "primary", style: "width: 100%; min-height: 48px" }, L("הגשה", "Hand in"));
      submit.onclick = () => { if (confirm(L("להגיש את המבחן?", "Hand in the exam?"))) void finish(submit); };
      return x.root.append(el("div", { class: "ph-row", style: "position: sticky; top: 0; background: var(--bg); z-index: 2" }, left, el("small", { class: "muted" }, L(`${z.qs.length} אמריקאיות${z.openQs.length ? ` · ${z.openQs.length} פתוחות` : ""}`, `${z.qs.length} multiple choice${z.openQs.length ? ` · ${z.openQs.length} open` : ""}`))),
        ...z.qs.map((q, i) => section("", el("b", { dir: "auto" }, `${i + 1}. ${q.q}`), ...q.options.map((o, k) => {
          const r = el("input", { type: "radio", name: `mq${i}`, onchange: () => { z.picked[i] = k; } });
          r.checked = z.picked[i] === k;
          return el("label", { class: "ph-row", style: "justify-content: flex-start; gap: 8px", dir: "auto" }, r, String(o));
        }))),
        ...z.openQs.map((q, i) => section("", el("b", { dir: "auto" }, `${z.qs.length + i + 1}. ${q.q}`), (() => { const ta = el("textarea", { rows: "4", dir: "auto", "aria-label": L("התשובה שלך", "Your answer"), oninput: (e) => { z.texts[i] = e.target.value; } }); ta.value = z.texts[i] || ""; return ta; })())),
        submit);
    }
    const res = mockResult(c.quizzes.filter((q) => q.mock?.group === z.group));
    const title = (id) => c.lectures.find((l) => l.id === id)?.title ?? "";
    x.root.append(section(res ? L(`ציון: ${res.grade}`, `Grade: ${res.grade}`) : L("נבדק", "Checked"),
      res ? el("p", {}, L(`${res.right}/${res.choice} אמריקאיות נכונות${res.openMax ? ` · פתוחות: ${res.open}/${res.openMax}` : ""}`, `${res.right}/${res.choice} multiple choice right${res.openMax ? ` · open: ${res.open}/${res.openMax}` : ""}`)) : "",
      ...(res?.byLecture ?? []).slice(0, 5).map((b) => el("p", { class: "small", dir: "auto" }, `${title(b.lectureId) || L("הרצאה", "Lecture")}: ${b.got}/${b.of}`)),
      ...z.qs.map((q, i) => z.picked[i] === q.answer && !q.fixed ? "" : el("details", { open: !!q.checkNote }, el("summary", { dir: "auto" }, `${z.picked[i] === q.answer ? "✎" : "✗"} ${i + 1}. ${q.q.slice(0, 80)}`), el("p", { dir: "auto", class: "small" }, `${L("נכון: ", "Right: ")}${q.options[q.answer]}. ${q.explain || ""}`), questionCheck(c, q, z.picked[i] ?? -1, () => mockFix(c, z)))),
      ...z.openQs.map((q, i) => el("details", {}, el("summary", { dir: "auto" }, `${z.qs.length + i + 1}. ${q.q.slice(0, 80)}`), el("p", { dir: "auto", class: "small" }, z.feedback?.[i] ?? ""))),
      btns(el("button", { type: "button", class: "primary", onclick: () => x.go({ at: "mock", course: c.id }) }, L("מבחן דמה נוסף", "Another mock exam")))));
  }

  /** After a mock exam question was checked: its saved part leaves out a broken question and recounts the score. */
  function mockFix(c, z) {
    const saved = (c.quizzes ?? []).find((q) => q.mock?.group === z.group && !q.kind);
    if (!saved) return;
    const kept = z.qs.map((q, i) => [q, z.picked[i] ?? -1]).filter(([q]) => !q.dropped);
    saved.questions = kept.map(([q]) => ({ q: q.q, options: q.options, answer: q.answer, explain: q.explain, ...(q.lectureId ? { lectureId: q.lectureId } : {}), ...(q.fixed ? { fixed: q.fixed } : {}) }));
    saved.answers = kept.map(([, p]) => p);
    saved.score = kept.filter(([q, p]) => p === q.answer).length;
    commit();
  }

  // ---------- the first setup on the phone alone (design StudySetupWizardPhone, students part 38) ----------
  // The same four explained steps as the computer's (field, courses, will it work here, the first lecture), kept in the
  // phone (the same checked shape as the computer's prefs); skipped steps wait on the "Getting started" list.
  function loadSetup() { try { return cleanStudyPrefs(JSON.parse(localStorage.getItem(SETUP_KEY) || "{}")); } catch { return cleanStudyPrefs({}); } }
  function saveSetup(change) {
    const next = cleanStudyPrefs({ ...loadSetup(), ...change });
    try { localStorage.setItem(SETUP_KEY, JSON.stringify(next)); } catch { /* full: the setup just starts again */ }
    return next;
  }
  /** Whether the first setup shows instead of the home: a new start, or a setup left in the middle. */
  const needsSetup = () => { const p = loadSetup(); return !p.welcomed && (!x.db().courses.length || p.setupStep > 0); };
  const FIELD_ICONS = { nursing: "🩺", medicine: "⚕️", law: "⚖️", engineering: "📐", cs: "💻", psychology: "🧠", economics: "💼", math: "➗", biology: "🧬", education: "🍎", humanities: "📜", gamedev: "🎮" };
  const FIRST_FIELDS = ["nursing", "medicine", "law", "engineering", "cs", "psychology", "economics"];
  const fieldName = (id) => { const f = STUDY_FIELDS.find((y) => y.id === id); return f ? L(f.he, f.en) : ""; };
  const chip = (on, label, onclick, attrs = {}) => el("button", { type: "button", role: "radio", "aria-checked": on ? "true" : "false", style: `border-radius: 999px; padding: 6px 12px${on ? "; border-color: var(--accent); color: var(--accent)" : ""}`, onclick, ...attrs }, `${on ? "✓ " : ""}${label}`);
  /** What the phone can do: a model on it, speech-to-text, a connected computer. */
  async function phoneReady() {
    const m = await Promise.resolve(x.sync?.phoneModel?.()).catch(() => undefined);
    return { model: !!m?.ready, modelName: m?.name || "", speech: !!x.speech, computer: !!x.sync?.hasComputer?.() };
  }
  function readyBox(st) {
    const line = (ok, title, text, act) => el("div", { class: "ph-row", style: "align-items: flex-start" }, el("span", {}, el("b", {}, `${ok ? "✅" : "⬜"} ${title}`), el("br"), el("small", { class: "muted", dir: "auto" }, text)), act || "");
    return el("div", {},
      line(st.model || st.computer, L("מודל שעונה", "A model that answers"), st.model ? st.modelName || L("מודל בטלפון", "A model on the phone") : st.computer ? L("המחשב המחובר עושה את העבודה", "The connected computer does the work") : L("מודל קטן בטלפון: לעברית הכי טוב DictaLM 1.7B (‏1.1GB, עדיף ב־Wi‑Fi). או חיבור למחשב.", "A small model on the phone: for Hebrew, DictaLM 1.7B is best (1.1 GB, Wi‑Fi is better). Or connect a computer."),
        st.model || st.computer || !x.sync?.openModels ? null : el("button", { type: "button", onclick: () => x.sync.openModels() }, L("להוריד מודל", "Get a model"))),
      line(st.speech, L("תמלול הקלטות", "Transcribing recordings"), st.speech ? L("בטלפון עצמו", "On the phone itself") : L("לא זמין בטלפון הזה; אפשר להדביק טקסט או להעלות קובץ.", "Not available on this phone; paste text or upload a file instead.")),
      line(st.computer, L("מחשב מחובר (לא חובה)", "A connected computer (optional)"), st.computer ? L("מחובר: הקורסים מסתנכרנים, והעבודה הכבדה רצה שם", "Connected: courses sync, and the heavy work runs there") : L("אפשר לחבר בהמשך, מהמסך הראשי של האפליקציה.", "You can connect one later, from the app's main screen.")));
  }
  function setupView() {
    const p = loadSetup();
    const step = p.setupStep;
    const courses = x.db().courses;
    const go2 = (to, skipped) => {
      const list = skipped ? [...new Set([...p.setupSkipped, skipped])] : p.setupSkipped.filter((k) => k !== SETUP_STEPS[step]);
      saveSetup({ setupStep: Math.min(to, SETUP_STEPS.length - 1), setupSkipped: list });
      x.draw();
      globalThis.setTimeout(() => x.root.querySelector("h2")?.focus(), 30);
    };
    const finish = (to) => {
      saveSetup({ welcomed: true, setupStep: 0 });
      const first = x.db().courses[0];
      if (to === "record" && first) return go({ at: "record", course: first.id });
      if (to === "file" && first) return go({ at: "course", course: first.id });
      go({ at: "home" });
    };
    const nav = (next, nextLabel, skip, disabled = false) => el("div", { class: "ph-btns", style: "flex-wrap: wrap; margin-top: 10px" },
      el("button", { type: "button", class: "primary", disabled: disabled ? "" : undefined, onclick: next }, nextLabel),
      step > 0 ? el("button", { type: "button", onclick: () => go2(step - 1) }, L("‹ חזרה", "‹ Back")) : "",
      el("button", { type: "button", class: "link", onclick: () => go2(step + 1, skip) }, L("לדלג על השלב (יישאר ברשימה)", "Skip this step (it stays on the list)")));
    const bar = el("div", { style: "display: flex; gap: 5px; margin: 6px 0 10px" }, ...SETUP_STEPS.map((_, i) => el("span", { style: `flex: 1; height: 4px; border-radius: 2px; background: ${i <= step ? "var(--accent, #a5b4ff)" : "#2a2a2e"}` })));
    x.root.append(el("div", { class: "ph-row" }, el("span", { class: "muted small", "aria-live": "polite" }, L(`שלב ${step + 1} מתוך 4`, `Step ${step + 1} of 4`)),
      el("button", { type: "button", class: "link", onclick: () => { saveSetup({ welcomed: true }); go({ at: "home" }); } }, L("לסגור, אסתדר לבד", "Close, I'll find my way"))), bar);
    if (step === 0) {
      const more = p.field && !FIRST_FIELDS.includes(p.field);
      const showAll = x.view.moreFields || more;
      x.root.append(section("",
        el("h2", { tabindex: "-1" }, L("🎓 מה את לומדת?", "🎓 What do you study?")),
        el("p", { class: "muted small" }, L("ככה הכלים יתאימו לתחום שלך: מחשבוני תרופות לסיעוד, מקרים למשפטים, נוסחאות להנדסה.", "So the tools fit your field: medication calculators for nursing, cases for law, formulas for engineering.")),
        el("div", { role: "radiogroup", "aria-label": L("תחום", "Field"), style: "display: flex; flex-wrap: wrap; gap: 6px" },
          ...STUDY_FIELDS.filter((f) => showAll || FIRST_FIELDS.includes(f.id)).map((f) => chip(p.field === f.id, `${FIELD_ICONS[f.id] ?? "📘"} ${L(f.he, f.en)}`, () => { saveSetup({ field: f.id }); x.draw(); })),
          showAll ? "" : el("button", { type: "button", class: "link", onclick: () => go({ ...x.view, moreFields: true }) }, L("עוד תחומים…", "More fields…"))),
        el("p", { class: "small", style: "margin: 10px 0 4px" }, L("באיזו שנה? (לא חובה)", "Which year? (optional)")),
        el("div", { role: "radiogroup", "aria-label": L("שנה", "Year"), style: "display: flex; flex-wrap: wrap; gap: 6px" },
          ...[1, 2, 3, 4].map((y) => chip(p.year === y, L(["א׳", "ב׳", "ג׳", "ד׳ ומעלה"][y - 1], ["1st", "2nd", "3rd", "4th+"][y - 1]), () => { saveSetup({ year: p.year === y ? null : y }); x.draw(); }))),
        nav(() => go2(1, p.field ? undefined : "field"), L("הבא ›", "Next ›"), "field")));
    } else if (step === 1) {
      const name = el("input", { dir: "auto", "aria-label": L("שם הקורס", "Course name"), placeholder: L("למשל: פרמקולוגיה", "e.g. Pharmacology"), style: "flex: 1 1 100%; min-width: 0" });
      const exam = el("input", { type: "date", "aria-label": L("תאריך המבחן (לא חובה)", "Exam date (optional)") });
      const add = () => {
        const n = name.value.trim();
        if (!n) return courses.length ? go2(2) : go2(2, "courses");
        const c = { id: uid(), name: n.slice(0, 80), createdAt: Date.now(), field: detectField(n, "") || p.field, ...(exam.value ? { examDate: exam.value } : {}), lectures: [], cards: [], reviews: [], quizzes: [] };
        x.db().courses.push(c);
        if (commit()) go2(2);
      };
      const photo = x.extract ? timetablePhoto(() => go2(2)) : null;
      x.root.append(section("",
        el("h2", { tabindex: "-1" }, L("📚 הקורסים שלך", "📚 Your courses")),
        el("p", { class: "muted small" }, L("לכל קורס יש הרצאות, כרטיסיות ובוחנים משלו. הכי מהיר: צילום של מערכת השעות.", "Each course has its own lectures, cards and quizzes. Fastest: a photo of your timetable.")),
        photo ? el("div", {}, photo.shot, el("button", { type: "button", class: "primary", style: "width: 100%", onclick: () => photo.shot.click() }, L("📷 כל הקורסים מצילום מערכת השעות", "📷 All my courses from a timetable photo")), photo.found) : "",
        el("p", { class: "small", style: "margin: 12px 0 4px" }, L("או קורס אחד בכל פעם:", "Or one course at a time:")),
        el("div", { class: "ph-filter", style: "flex-wrap: wrap" }, name, el("label", { class: "small", style: "display: flex; flex-direction: column; gap: 2px" }, L("מתי המבחן? (לא חובה)", "When is the exam? (optional)"), exam)),
        courses.length ? el("p", { class: "small", dir: "auto" }, `✅ ${L(`יש לך ${courses.length} קורסים: `, `You have ${courses.length} courses: `)}${courses.slice(0, 6).map((c) => c.name).join(" · ")}`) : "",
        nav(add, L("להוסיף ולהמשיך ›", "Add and go on ›"), "courses")));
    } else if (step === 2) {
      const box = el("div", {}, el("p", { class: "muted small" }, L("בודק מה יש בטלפון…", "Checking this phone…")));
      x.root.append(section("",
        el("h2", { tabindex: "-1" }, L("📱 האם זה יעבוד בטלפון?", "📱 Will it work on this phone?")),
        el("p", { class: "muted small" }, L("הכול נשמר ורץ בטלפון, בלי לשלוח את ההרצאות לשום מקום. צריך מודל שעונה; תמלול הקלטות אם יש.", "Everything stays and runs on the phone; your lectures go nowhere. It needs a model that answers, and speech-to-text if there is one.")),
        box, el("p", { class: "muted small" }, L("הורדה מתחילה רק כשלוחצים.", "A download starts only when you tap.")),
        nav(() => void phoneReady().then((st) => go2(3, st.model || st.computer ? undefined : "model")), L("הבא ›", "Next ›"), "model")));
      void phoneReady().then((st) => box.replaceChildren(readyBox(st)));
    } else {
      const has = courses.length > 0;
      const opt = (label, text, onclick, off) => el("button", { type: "button", disabled: off ? "" : undefined, style: "display: flex; flex-direction: column; align-items: flex-start; text-align: start; width: 100%; margin: 4px 0; padding: 10px 12px", onclick }, el("b", {}, label), el("small", { class: "muted" }, text));
      x.root.append(section("",
        el("h2", { tabindex: "-1" }, L("🎙 ההרצאה הראשונה", "🎙 Your first lecture")),
        el("p", { class: "muted small" }, L("מכל הרצאה נעשים סיכום, כרטיסיות לחזרה ובוחן.", "Each lecture becomes a summary, review cards and a quiz.")),
        x.speech ? opt(L("🎙 להקליט עכשיו", "🎙 Record now"), L("הגישה למיקרופון נשאלת רק עכשיו.", "The microphone is asked only now."), () => finish("record"), !has) : "",
        opt(L("📄 טקסט, קובץ או צילום לוח", "📄 Text, a file or a photo of the board"), L("להדביק תמלול, להעלות מצגת או PDF, או לצלם.", "Paste a transcript, upload slides or a PDF, or take a photo."), () => finish("file"), !has),
        opt(L("🕐 בשיעור הבא", "🕐 In the next class"), L("הכול מוכן. ברשימת \"מתחילים\" יחכה הצעד הבא.", "All set. The \"Getting started\" list keeps the next step."), () => finish("later")),
        has ? "" : el("p", { class: "small" }, L("כדי להוסיף הרצאה צריך קורס אחד לפחות (שלב 2).", "A lecture needs at least one course (step 2).")),
        el("div", { class: "ph-btns" }, el("button", { type: "button", onclick: () => go2(2) }, L("‹ חזרה", "‹ Back")))));
    }
  }
  /** "Getting started" on the phone's Study home: what is done, what is left and why, one button each. */
  function setupList() {
    const p = loadSetup();
    if (!p.welcomed || p.checklistHidden) return null;
    const courses = x.db().courses;
    const box = el("div");
    void phoneReady().then((st) => {
      const items = [
        [!!p.field, p.field ? L(`התחום: ${fieldName(p.field)}`, `Field: ${fieldName(p.field)}`) : L("התחום שלך", "Your field"), L("כלים שמתאימים לתחום", "Tools that fit your field"), () => { saveSetup({ welcomed: false, setupStep: 0 }); x.draw(); }, L("לבחור", "Choose")],
        [courses.length > 0, L("הקורסים", "Your courses"), L("לכל קורס הרצאות וכרטיסיות משלו", "Each course has its own lectures and cards"), null, ""],
        [st.model || st.computer, L("מודל שעונה", "A model that answers"), L("בלעדיו אין סיכום, כרטיסיות ובוחן", "Without it there is no summary, cards or quiz"), x.sync?.openModels ? () => x.sync.openModels() : null, L("להוריד", "Get one")],
        [courses.some((c) => c.lectures.length), L("ההרצאה הראשונה", "The first lecture"), L("ממנה נעשים סיכום, כרטיסיות ובוחן", "It becomes a summary, cards and a quiz"), courses[0] ? () => go({ at: "course", course: courses[0].id }) : null, L("להוסיף", "Add")],
      ];
      const done = items.filter((i) => i[0]).length;
      // All done: hidden for good, so the model check does not load the phone model engine on every visit.
      if (done === items.length) { saveSetup({ checklistHidden: true }); return box.remove(); }
      box.replaceChildren(section("",
        el("div", { class: "ph-row" }, el("h2", { style: "margin: 0" }, L(`🧭 מתחילים: ${done} מתוך ${items.length}`, `🧭 Getting started: ${done} of ${items.length}`)),
          el("button", { type: "button", class: "link", onclick: () => { saveSetup({ checklistHidden: true }); box.remove(); } }, L("להסתיר", "Hide"))),
        ...items.map(([ok, title, why, act, label]) => el("div", { class: "ph-row" },
          el("span", { style: "flex: 1; min-width: 0" }, el("b", { dir: "auto" }, `${ok ? "✅" : "⬜"} ${title}`), ok ? "" : el("small", { class: "muted" }, ` — ${why}`)),
          !ok && act ? el("button", { type: "button", onclick: act }, label) : ""))));
    });
    return box;
  }

  // ---------- my progress: daily goal, the week, mastery and milestones (design PhoneProgress) ----------
  // The same calculations as the computer's Study (goalToday, weekRecap, topicMastery, studyBadges), from the phone's
  // own data; the goal (minutes of focus and cards reviewed a day) is kept on the phone.
  function loadGoal() { try { const g = JSON.parse(localStorage.getItem(GOAL_KEY) || "{}"); return { on: g.on === true, targets: { minutes: Math.min(240, Math.max(0, Number(g.targets?.minutes) || 0)), cards: Math.min(500, Math.max(0, Number(g.targets?.cards) || 0)) } }; } catch { return { on: false, targets: { minutes: 15, cards: 20 } }; } }
  function saveGoal(g) { try { localStorage.setItem(GOAL_KEY, JSON.stringify(g)); } catch { alert(L("אין מקום לשמור.", "No room to save.")); } }
  const datas = () => x.db().courses.map((c) => x.toData(c));
  /** On the home: today's goal (or one tap to set one). */
  function goalCard() {
    const g = loadGoal();
    if (!x.db().courses.length) return null;
    if (!g.on) return el("div", { class: "ph-row" }, el("span", { class: "muted small" }, L("יעד קטן לכל יום עוזר להתמיד.", "A small goal each day helps you keep going.")),
      el("button", { type: "button", onclick: () => { saveGoal({ on: true, targets: { minutes: 15, cards: 20 } }); x.draw(); } }, L("🎯 15 דקות ו־20 כרטיסיות", "🎯 15 minutes and 20 cards")));
    const t = goalToday(datas(), [], { on: true, targets: g.targets });
    const parts = [["minutes", "⏱", "דקות", "minutes"], ["cards", "🃏", "כרטיסיות", "cards"]].filter(([k]) => t.targets[k]);
    const share = parts.length ? parts.reduce((n, [k]) => n + Math.min(1, t.counts[k] / t.targets[k]), 0) / parts.length : 0;
    return section("",
      el("div", { class: "ph-row" }, el("b", {}, t.done ? L("🎯 היעד של היום הושג ✓", "🎯 Today's goal reached ✓") : L("🎯 היעד של היום", "🎯 Today's goal")), el("button", { type: "button", class: "link", onclick: () => go({ at: "myProgress" }) }, L("ההתקדמות שלי ›", "My progress ›"))),
      el("div", { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(share * 100)), "aria-label": L("היעד של היום", "Today's goal"), style: "height: 6px; border-radius: 3px; background: #2a2a2e; overflow: hidden; margin: 6px 0" }, el("span", { style: `display: block; height: 100%; width: ${Math.round(share * 100)}%; background: #7fd8a8` })),
      el("p", { class: "small", style: "margin: 0" }, parts.map(([k, icon, he, en]) => `${icon} ${L(`${Math.min(t.counts[k], t.targets[k])} מתוך ${t.targets[k]} ${he}`, `${Math.min(t.counts[k], t.targets[k])} of ${t.targets[k]} ${en}`)}${t.counts[k] >= t.targets[k] ? " ✓" : ""}`).join(" · ")),
      t.streak ? el("p", { class: "muted small", style: "margin: 4px 0 0" }, L(`🔥 ${t.streak} ימים ברצף`, `🔥 ${t.streak} days in a row`)) : "");
  }
  /** The goal's reminder (20:30, like the computer's): today when it is not reached yet, else tomorrow. */
  function goalReminder() {
    const g = loadGoal();
    if (!g.on || !x.db().courses.length) return null;
    const t = goalToday(datas(), [], { on: true, targets: g.targets });
    const d = new Date();
    d.setHours(20, 30, 0, 0);
    if (t.done || d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return { id: `goal-${dayKey(d)}`, at: d.getTime(), title: L("🎯 עוד לא הגעת ליעד של היום", "🎯 Today's goal is not reached yet"), body: L("כמה דקות של חזרה מספיקות.", "A few minutes of review are enough.") };
  }
  function progress() {
    x.root.append(back({ at: "home" }), el("h2", {}, L("📈 ההתקדמות שלי", "📈 My progress")));
    const g = loadGoal();
    const ds = datas();
    const pick = (k, values) => el("div", { role: "radiogroup", style: "display: flex; flex-wrap: wrap; gap: 6px" }, ...values.map((v) => chip(g.on && g.targets[k] === v, v ? String(v) : L("בלי", "None"), () => { saveGoal({ on: true, targets: { ...g.targets, [k]: v } }); x.draw(); })));
    x.root.append(goalCard() ?? "", section(L("היעד היומי", "The daily goal"),
      el("p", { class: "small", style: "margin: 4px 0" }, L("דקות ריכוז ביום", "Focus minutes a day")), pick("minutes", [0, 10, 15, 30, 60]),
      el("p", { class: "small", style: "margin: 8px 0 4px" }, L("כרטיסיות ביום", "Cards a day")), pick("cards", [0, 10, 20, 40]),
      g.on ? el("button", { type: "button", class: "link", onclick: () => { saveGoal({ ...g, on: false }); x.draw(); } }, L("לכבות את היעד", "Turn the goal off")) : ""));
    const w = weekRecap(ds, []);
    x.root.append(section(L("השבוע", "This week"),
      el("p", { class: "small" }, L(`למדת ${w.days} מתוך 7 ימים · ${w.counts.cards} כרטיסיות · ${w.counts.minutes} דקות ריכוז`, `You studied ${w.days} of 7 days · ${w.counts.cards} cards · ${w.counts.minutes} focus minutes`)),
      ...w.rose.map((m) => el("p", { class: "small", dir: "auto", style: "margin: 2px 0" }, `⬆ ${m.course}: ${m.title} (+${m.change})`)),
      ...w.dropped.map((m) => el("p", { class: "small", dir: "auto", style: "margin: 2px 0" }, `⬇ ${m.course}: ${m.title} (${m.change})`))));
    const rows = x.db().courses.map((c) => ({ c, m: topicMastery(c.cards, c.reviews, c.quizzes).sort((a, b) => a.mastery - b.mastery).slice(0, 6) })).filter((y) => y.m.length);
    x.root.append(section(L("שליטה בנושאים", "Mastery by topic"), ...(rows.length ? rows.flatMap(({ c, m }) => [el("b", { dir: "auto" }, c.name),
      ...m.map((t) => el("div", { class: "ph-row" }, el("span", { dir: "auto", style: "flex: 1; min-width: 0" }, c.lectures.find((l) => l.id === t.lectureId)?.title ?? ""),
        el("span", { role: "img", "aria-label": `${t.mastery}`, style: "width: 90px; height: 6px; border-radius: 3px; background: #2a2a2e; overflow: hidden; display: inline-block" }, el("span", { style: `display: block; height: 100%; width: ${t.mastery}%; background: ${t.mastery >= 80 ? "#7fd8a8" : t.mastery >= 50 ? "#a5b4ff" : "#f0a830"}` })),
        el("small", { style: "width: 28px; text-align: end" }, String(t.mastery))))]) : [el("p", { class: "muted small" }, L("אחרי כמה חזרות ובחנים על הרצאה, השליטה בה תופיע כאן.", "After a few reviews and quizzes on a lecture, its mastery shows here."))])));
    const badges = studyBadges(ds, [], studyStreak(studyDays(ds)));
    x.root.append(section(L("הישגים", "Milestones"), badges.length ? el("p", {}, badges.map((b) => `${b.icon} ${L(b.he, b.en)}`).join(" · ")) : el("p", { class: "muted small" }, L("ההרצאה הראשונה, 100 כרטיסיות, 7 ימים ברצף… יופיעו כאן.", "The first lecture, 100 cards, a 7-day streak… show here."))));
  }

  // ---------- back on track after days off (design BackOnTrack, students part 39) ----------
  /** On the home: the course with the biggest pile of due cards, cleared a little each day; null when there is none. */
  function backOnTrack() {
    let pace = "steady";
    try { pace = localStorage.getItem("kesherai-backlog-pace") === "gentle" ? "gentle" : "steady"; } catch { /* steady */ }
    const found = x.db().courses.map((c) => ({ c, steady: backlogPlan(x.toData(c), Date.now(), "steady"), gentle: backlogPlan(x.toData(c), Date.now(), "gentle") })).filter((y) => y.steady).sort((a, b) => b.steady.due - a.steady.due)[0];
    if (!found) return null;
    const plan = found[pace];
    const day = new Date(`${plan.finish}T12:00`).toLocaleDateString(L("he-IL", "en-GB"), { weekday: "long", day: "numeric", month: "numeric" });
    const set = (p) => { try { localStorage.setItem("kesherai-backlog-pace", p); } catch { /* this visit */ } x.draw(); };
    return el("section", { class: "api", style: "border-inline-start: 4px solid #7fd8a8" },
      el("h2", {}, L("🌱 חוזרים למסלול: ", "🌱 Back on track: "), el("span", { dir: "auto" }, found.c.name)),
      el("p", {}, L(`מחכות ${plan.due} כרטיסיות. בלי לחץ: לא צריך הכול היום.`, `${plan.due} cards are waiting. No pressure: not all today.`)),
      el("div", { role: "radiogroup", "aria-label": L("קצב", "Pace"), style: "display: flex; flex-wrap: wrap; gap: 6px" },
        chip(pace === "gentle", L(`🐢 בנחת · ${found.gentle.perDay} ביום`, `🐢 Gentle · ${found.gentle.perDay} a day`), () => set("gentle")),
        chip(pace === "steady", L(`🚶 בקצב · ${found.steady.perDay} ביום`, `🚶 Steady · ${found.steady.perDay} a day`), () => set("steady"))),
      el("p", { class: "muted small" }, L(`ביום רגיל את עושה בערך ${plan.usual}. ככה חוזרים למסלול עד ${day}; קודם הכרטיסיות שלמדת לאחרונה.`, `On a usual day you do about ${plan.usual}. This way you are back on track by ${day}; the ones you learned lately come first.`)),
      el("button", { type: "button", class: "primary", onclick: () => go({ at: "review", course: found.c.id, today: plan.perDay, done: 0 }) }, L(`▶ ${plan.perDay} של היום`, `▶ Today's ${plan.perDay}`)));
  }

  // ---------- image cards (image occlusion) made on the phone (design PhoneOcclusion) ----------
  // The picture is kept once on the phone (IndexedDB, at most 1600 px), named "ph-….jpg" so a synced card is accepted
  // by the computer too (which shows its text there); boxes are drawn with a finger, each box becomes a card.
  const imageDb = () => new Promise((ok, bad) => { const q = globalThis.indexedDB.open("kesherai-images", 1); q.onupgradeneeded = () => q.result.createObjectStore("pics"); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); });
  async function putImage(name, dataUrl) { const d = await imageDb(); await new Promise((ok, bad) => { const t = d.transaction("pics", "readwrite"); t.objectStore("pics").put(dataUrl, name); t.oncomplete = ok; t.onerror = () => bad(t.error); }); }
  /** A picture kept on the phone for its image cards, or "" when it is not here. */
  async function phoneImage(name) {
    try { const d = await imageDb(); return await new Promise((ok) => { const q = d.transaction("pics").objectStore("pics").get(name); q.onsuccess = () => ok(q.result || ""); q.onerror = () => ok(""); }); } catch { return ""; }
  }
  const shrink = (file) => new Promise((ok, bad) => {
    const url = URL.createObjectURL(file);
    const im = new globalThis.Image();
    im.onload = () => { const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight)); const cv = document.createElement("canvas"); cv.width = Math.round(im.naturalWidth * k); cv.height = Math.round(im.naturalHeight * k); cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); ok(cv.toDataURL("image/jpeg", 0.85)); };
    im.onerror = () => { URL.revokeObjectURL(url); bad(new Error("not a picture")); };
    im.src = url;
  });
  function occlusion(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("🖼 כרטיסיות מתמונה", "🖼 Cards from a picture")));
    const box = el("div");
    const pick = el("input", { type: "file", accept: "image/*", hidden: true, onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      let data;
      try { data = await shrink(f); } catch { return alert(L("זו לא תמונה.", "That is not a picture.")); }
      editor(data);
    } });
    const start = () => box.replaceChildren(section("", el("p", { class: "muted small" }, L("מצלמים או בוחרים תמונה (אנטומיה, תרשים, מפה), ומסמנים באצבע את מה להסתיר. כל תיבה היא כרטיסייה.", "Take or choose a picture (anatomy, a diagram, a map) and mark with a finger what to hide. Each box is a card.")),
      pick, el("button", { type: "button", class: "primary", onclick: () => pick.click() }, L("📷 תמונה", "📷 A picture"))));
    function editor(data) {
      const boxes = [];
      const area = el("div", { style: "position: relative; touch-action: none; user-select: none; max-width: 100%" });
      const img = el("img", { src: data, alt: "", draggable: "false", style: "display: block; width: 100%; border-radius: 8px; background: #fff" });
      area.append(img);
      const list = el("div");
      const title = el("input", { dir: "auto", "aria-label": L("כותרת", "Title"), placeholder: L("כותרת, למשל: הלב", "A title, e.g. The heart"), style: "width: 100%" });
      const make = el("button", { type: "button", class: "primary", disabled: "" }, L("ליצור כרטיסיות", "Make cards"));
      const pct = (n) => `${n * 100}%`;
      const draw = () => {
        area.replaceChildren(img, ...boxes.map((b, i) => el("div", { style: `position: absolute; left: ${pct(b.x)}; top: ${pct(b.y)}; width: ${pct(b.w)}; height: ${pct(b.h)}; background: #a5b4ff; border-radius: 4px; display: grid; place-items: center; color: #111; font-weight: 700` }, String(i + 1))));
        list.replaceChildren(...boxes.map((b, i) => el("div", { class: "ph-row" }, el("b", {}, String(i + 1)),
          el("input", { dir: "auto", value: b.label || "", "aria-label": L(`תיבה ${i + 1}`, `Box ${i + 1}`), placeholder: L("מה מוסתר כאן", "What is hidden here"), style: "flex: 1; min-width: 0", oninput: (e) => { b.label = e.target.value.slice(0, 200); } }),
          el("button", { type: "button", "aria-label": L("להסיר", "Remove"), onclick: () => { boxes.splice(i, 1); draw(); } }, "✕"))));
        make.disabled = !boxes.length;
        make.textContent = L(`ליצור ${boxes.length} כרטיסיות`, `Make ${boxes.length} cards`);
      };
      let from;
      let live;
      const at = (e) => { const r = area.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
      area.onpointerdown = (e) => { from = at(e); area.setPointerCapture?.(e.pointerId); live = el("div", { style: "position: absolute; border: 2px dashed #f0a830; border-radius: 4px; pointer-events: none" }); area.append(live); };
      area.onpointermove = (e) => { if (!from || !live) return; const p = at(e); Object.assign(live.style, { left: pct(Math.min(from.x, p.x)), top: pct(Math.min(from.y, p.y)), width: pct(Math.abs(p.x - from.x)), height: pct(Math.abs(p.y - from.y)) }); };
      area.onpointerup = (e) => {
        if (!from) return;
        const p = at(e);
        const b = { x: Math.min(from.x, p.x), y: Math.min(from.y, p.y), w: Math.abs(p.x - from.x), h: Math.abs(p.y - from.y) };
        from = undefined;
        live?.remove();
        // A tap, not a box: too small to hide anything.
        if (b.w > 0.02 && b.h > 0.02 && boxes.length < 40) boxes.push(b);
        draw();
      };
      make.onclick = async () => {
        const name = `ph-${uid().replace(/[^\w-]/g, "").slice(0, 24)}.jpg`;
        try { await putImage(name, data); } catch { return alert(L("אין מקום לשמור את התמונה בטלפון.", "No room on the phone to keep the picture.")); }
        const t = title.value.trim().slice(0, 200);
        boxes.forEach((b, i) => {
          newCard(c, `🖼 ${t || "?"} — ${i + 1}/${boxes.length}`, b.label?.trim() || `#${i + 1}`);
          const card = c.cards[c.cards.length - 1];
          card.format = "diagram";
          card.kind = "anatomy";
          card.occlusion = { image: name, boxes: boxes.map(({ x: bx, y, w, h, label }) => ({ x: bx, y, w, h, ...(label ? { label: label.trim().slice(0, 200) } : {}) })), i };
        });
        if (commit()) { alert(L(`נוצרו ${boxes.length} כרטיסיות`, `${boxes.length} cards made`)); go({ at: "course", course: c.id }); }
      };
      box.replaceChildren(section("", el("p", { class: "muted small" }, L("גוררים באצבע מסביב למה שצריך להסתיר.", "Drag with a finger around what to hide.")), area, list, title,
        el("div", { class: "ph-btns", style: "flex-wrap: wrap" }, make, el("button", { type: "button", onclick: start }, L("תמונה אחרת", "Another picture")))));
      draw();
    }
    x.root.append(box);
    start();
  }

  // ---------- my mistakes, the 5-minute lesson and the match game: from what is already on the phone ----------
  const scheduler = fsrs();
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  /** Rates a card in spaced review, as the review page does. */
  const rateCard = (c, card, r) => {
    const f = card.fsrs;
    const before = { ...f, due: new Date(f.due), ...(f.last_review ? { last_review: new Date(f.last_review) } : {}) };
    const elapsedDays = before.last_review ? Math.floor((Date.now() - before.last_review.getTime()) / 86400000) : 0;
    const next = scheduler.next(before, new Date(), r).card;
    card.fsrs = JSON.parse(JSON.stringify(next));
    card.due = next.due.toISOString();
    c.reviews.push({ cardId: card.id, t: Date.now(), rating: r, format: card.format, elapsedDays });
  };
  /**
   * "My mistakes" (the cards she forgot and the questions she got wrong lately; each until right twice) or the
   * 5-minute lesson (up to 5 cards, due first, and 2 questions from her quizzes; each once). Same as the computer's.
   */
  function practice(c) {
    const quick = x.view.mode === "quick";
    const need = quick ? 1 : 2;
    let items;
    if (quick) {
      const d = x.toData(c);
      const due = cardsToReview(d, Date.now(), 5);
      const cards = due.length >= 3 ? due : [...due, ...shuffle(c.cards.filter((k) => !due.some((y) => y.id === k.id))).slice(0, 5 - due.length)];
      const pool = c.quizzes.filter((z) => !z.kind).flatMap((z) => z.questions.filter((q) => q.answer >= 0 && q.options?.length > 1));
      items = [...cards.map((card) => ({ card })), ...shuffle(pool).slice(0, 2).map((q) => ({ q }))];
    } else {
      const m = recentMistakes(x.toData(c));
      items = [...m.cards.map((card) => ({ card })), ...m.questions.map((q) => ({ q }))];
    }
    items = shuffle(items).map((it, i) => ({ ...it, key: i, right: 0 }));
    const total = items.length;
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, quick ? L("⚡ שיעור של 5 דקות", "⚡ 5-minute lesson") : L("🔁 הטעויות שלי", "🔁 My mistakes")));
    const box = el("section", { class: "api", "aria-live": "polite" });
    x.root.append(box);
    if (!total) return box.append(el("p", { class: "muted" }, quick ? L("עוד אין כרטיסיות או בחנים בקורס.", "No cards or quizzes in the course yet.") : L("אין טעויות מהחודש האחרון. כל הכבוד!", "No mistakes from the last month. Well done!")));
    const show = () => {
      const left = items.filter((it) => it.right < need);
      if (!left.length) {
        commit();
        return box.replaceChildren(el("p", {}, el("b", {}, L("🎉 סיימת!", "🎉 Done!"))), el("p", { class: "muted" }, quick ? L(`עברת על ${total} דברים.`, `You went over ${total} things.`) : L(`כל ${total} הטעויות נענו נכון פעמיים.`, `All ${total} mistakes answered right twice.`)), el("button", { type: "button", onclick: () => go({ at: "course", course: c.id }) }, L("חזרה לקורס", "Back to the course")));
      }
      const it = left[0];
      const progress = el("p", { class: "muted small" }, L(`נשארו ${left.length} מתוך ${total}`, `${left.length} of ${total} left`));
      const after = (ok) => {
        it.right = ok ? it.right + 1 : 0;
        // A miss goes a few places back, so it comes again soon but not at once.
        items.splice(items.indexOf(it), 1);
        items.splice(ok ? items.length : Math.min(items.length, 2), 0, it);
        show();
      };
      if (it.card) {
        const ans = el("p", { dir: "auto", hidden: true, style: "white-space: pre-wrap" }, it.card.back);
        const rates = el("div", { class: "ph-btns", hidden: true }, ...[[1, "שוב", "Again"], [2, "קשה", "Hard"], [3, "טוב", "Good"], [4, "קל", "Easy"]].map(([rt, h, e]) => el("button", { type: "button", onclick: () => { rateCard(c, it.card, rt); after(rt >= 3); } }, L(h, e))));
        const showBtn = el("button", { type: "button", class: "primary", onclick: () => { ans.hidden = false; rates.hidden = false; showBtn.hidden = true; } }, L("הצגת התשובה", "Show the answer"));
        box.replaceChildren(progress, el("p", { dir: "auto", style: "white-space: pre-wrap" }, el("b", {}, it.card.front)), showBtn, ans, rates);
      } else {
        const q = it.q;
        const out = el("p", { dir: "auto" });
        const opts = q.options.map((o, i) => el("button", { type: "button", dir: "auto", style: "display: block; width: 100%; text-align: start; margin: 4px 0", onclick: () => {
          opts.forEach((b, j) => { b.disabled = true; if (j === q.answer) b.style.outline = "2px solid #7fd8a8"; else if (j === i) b.style.outline = "2px solid #e88"; });
          const ok = i === q.answer;
          out.textContent = `${ok ? L("✓ נכון. ", "✓ Right. ") : L("✗ לא נכון. ", "✗ Not right. ")}${q.explain ?? ""}`;
          box.append(el("button", { type: "button", class: "primary", onclick: () => after(ok) }, L("הבא", "Next")));
        } }, o));
        box.replaceChildren(progress, el("p", { dir: "auto" }, el("b", {}, q.q)), ...opts, out);
      }
    };
    show();
  }

  /** The match game: six terms from her lectures and their meanings; tap a term, then its meaning. Best time kept. */
  function match(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("🧩 משחק התאמה", "🧩 Match game")));
    const seen = new Set();
    const pool = c.lectures.flatMap((l) => l.terms ?? []).filter((t) => t.term?.trim() && t.explain?.trim() && !seen.has(t.term) && seen.add(t.term));
    const box = el("section", { class: "api" });
    x.root.append(box);
    if (pool.length < 3) return box.append(el("p", { class: "muted" }, L("צריך לפחות 3 מונחים. סכמי הרצאה (הסיכום מוציא מונחים) ואז חזרי למשחק.", "At least 3 terms are needed. Summarize a lecture (summaries pull out terms), then come back.")));
    const bestKey = `kesher-match-best:${c.id}`;
    const fmt = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`;
    const short = (t) => { const f = t.split(/(?<=[.!?])\s/)[0] ?? t; return f.length > 70 ? `${f.slice(0, 68)}…` : f; };
    const round = () => {
      const picked = shuffle(pool).slice(0, 6);
      const tiles = shuffle(picked.flatMap((t, i) => [{ pair: i, text: t.term, term: true }, { pair: i, text: short(t.explain), term: false }]));
      let sel, start, penalty = 0, done = 0, timer;
      let best = 0;
      try { best = Number(localStorage.getItem(bestKey)) || 0; } catch { best = 0; }
      const clock = el("b", { class: "ph-clock" }, "0:00.0");
      const grid = el("div", { style: "display: grid; grid-template-columns: 1fr 1fr; gap: 6px" });
      const btns = tiles.map((t) => {
        const b = el("button", { type: "button", dir: "auto", style: `min-height: 64px; white-space: normal; overflow-wrap: anywhere; font-size: ${t.term ? "15px" : "13px"}${t.term ? "; font-weight: 600" : ""}` }, t.text);
        b.onclick = () => {
          if (b.disabled) return;
          if (!start) { start = Date.now(); timer = setInterval(() => { clock.textContent = fmt(Date.now() - start + penalty); }, 100); }
          if (!sel || sel.t.term === t.term) { if (sel) sel.b.style.outline = ""; sel = sel?.b === b ? undefined : { t, b }; if (sel) b.style.outline = "2px solid var(--accent)"; return; }
          if (sel.t.pair === t.pair) {
            sel.b.disabled = b.disabled = true; sel.b.style.visibility = b.style.visibility = "hidden"; sel = undefined; done++;
            if (done === picked.length) {
              clearInterval(timer);
              const ms = Date.now() - start + penalty;
              const record = !best || ms < best;
              if (record) try { localStorage.setItem(bestKey, String(ms)); } catch { /* kept for this round only */ }
              box.replaceChildren(el("p", {}, el("b", {}, L(`🎉 ${fmt(ms)}`, `🎉 ${fmt(ms)}`))), el("p", { class: "muted" }, record ? L("שיא חדש!", "A new best!") : L(`השיא: ${fmt(best)}`, `Best: ${fmt(best)}`)), el("button", { type: "button", class: "primary", onclick: round }, L("עוד סיבוב", "Another round")));
            }
          } else {
            penalty += 1000;
            const a = sel.b; a.style.outline = "2px solid #e88"; b.style.outline = "2px solid #e88";
            globalThis.setTimeout(() => { a.style.outline = ""; b.style.outline = ""; }, 400);
            sel = undefined;
          }
        };
        return b;
      });
      grid.append(...btns);
      box.replaceChildren(el("div", { class: "ph-row" }, clock, el("small", { class: "muted" }, best ? L(`השיא: ${fmt(best)} · טעות מוסיפה שנייה`, `Best: ${fmt(best)} · a mistake adds a second`) : L("טעות מוסיפה שנייה", "A mistake adds a second"))), grid);
    };
    round();
  }

  // ---------- highlights while reading (the computer's ReadHighlights), on the phone ----------
  /** Keeps the words she selected as a highlight of the lecture, with an optional note. */
  function addHighlight(l, text, note = "") {
    const list = cleanHighlights([...(l.highlights ?? []), { id: `h${uid().slice(0, 10)}`, text, ...(note.trim() ? { note: note.trim() } : {}), t: Date.now() }]);
    if (list.length === (l.highlights ?? []).length) return alert(L("אפשר עד 300 הדגשות בהרצאה.", "Up to 300 highlights in a lecture."));
    l.highlights = list;
    if (commit()) x.draw();
  }
  /** Her highlights in a lecture: notes, removing, and cards from the new ones (only those, as on the computer). */
  function highlightsBox(c, l) {
    const list = l.highlights ?? [];
    if (!list.length) return null;
    const fresh = list.filter((h) => !h.carded);
    const make = el("button", { type: "button", class: "primary", disabled: fresh.length ? undefined : "" }, fresh.length ? L(`📇 כרטיסיות מ־${fresh.length} ההדגשות החדשות`, `📇 Cards from the ${fresh.length} new highlights`) : L("✓ כל ההדגשות כבר בכרטיסיות", "✓ All highlights are cards"));
    make.onclick = async () => {
      const count = Math.min(40, Math.max(1, Math.round(fresh.length * 1.5)));
      const material = `What the student highlighted (each with her note); write the cards about these only, using the lecture below for context:\n${fresh.map((h) => `- ${h.text}${h.note ? ` [her note: ${h.note}]` : ""}`).join("\n")}\n\nThe lecture:\n${(l.text || l.summary || "").slice(0, 6000)}`;
      const r = await need([{ role: "system", content: `You write flashcards for a student. Each tests one fact; the front is a question, the back a short answer. Use only the material.${/[\u0590-\u05ff]/.test(material) ? " Write in Hebrew." : ""} Answer with JSON only: [{"front":"...","back":"..."}]` }, { role: "user", content: `Write ${count} cards.\n\nLecture: ${l.title}\n\n${material}` }], make);
      let got;
      try { got = r && jsonIn(r); } catch { got = undefined; }
      if (!Array.isArray(got)) return r !== undefined && alert(L("המודל לא החזיר כרטיסיות. נסי שוב.", "The model returned no cards. Try again."));
      let n = 0;
      for (const k of got) if (k?.front && k?.back && n < count) { newCard(c, k.front, k.back, l.id); n++; }
      if (!n) return alert(L("המודל לא החזיר כרטיסיות שימושיות. נסי שוב.", "The model returned no usable cards. Try again."));
      for (const h of fresh) h.carded = true;
      if (commit()) { alert(L(`נוצרו ${n} כרטיסיות`, `${n} cards made`)); x.draw(); }
    };
    return section(L(`🖍 ההדגשות שלי (${list.length})`, `🖍 My highlights (${list.length})`),
      ...list.map((h) => el("div", { class: "ph-row" }, el("span", { dir: "auto", style: "flex: 1; min-width: 0; overflow-wrap: anywhere" }, el("mark", { dir: "auto" }, h.text.length > 240 ? `${h.text.slice(0, 240)}…` : h.text), h.note ? el("small", { class: "muted", dir: "auto" }, ` — ${h.note}`) : "", h.carded ? el("small", { class: "muted" }, " 📇") : ""),
        el("button", { type: "button", "aria-label": L("הערה", "Note"), onclick: () => { const v = globalThis.prompt(L("הערה להדגשה:", "A note for the highlight:"), h.note ?? ""); if (v === null) return; if (v.trim()) h.note = v.trim().slice(0, 2000); else delete h.note; if (commit()) x.draw(); } }, "✎"),
        el("button", { type: "button", "aria-label": L("להסיר הדגשה", "Remove highlight"), onclick: () => { l.highlights = list.filter((y) => y.id !== h.id); if (commit()) x.draw(); } }, "✕"))),
      make);
  }

  // ---------- explain it back (Feynman) and the writing coach, on the phone's model ----------
  const heb = (t) => /[\u0590-\u05ff]/.test(t);
  /** In a lecture: she explains it in her own words; what she got, what she left out (as cards), what was wrong. */
  function teachBackBox(c, l) {
    const ta = el("textarea", { rows: "4", dir: "auto", "aria-label": L("ההסבר שלך", "Your explanation"), placeholder: L("הסבירי את ההרצאה במילים שלך, כאילו לחברה שלא הייתה בשיעור…", "Explain the lecture in your own words, as to a friend who missed it…") });
    const out = el("div");
    const b = el("button", { type: "button", class: "primary" }, L("בדיקה", "Check"));
    b.onclick = async () => {
      if (ta.value.trim().length < 20) return alert(L("כתבי כמה משפטים קודם.", "Write a few sentences first."));
      const material = l.summary ? `Summary:\n${l.summary}\n\nThe lecture:\n${l.text.slice(0, 6000)}` : l.text.slice(0, 8000);
      const r = await need([{ role: "system", content: `${TEACH_BACK_PROMPT}${heb(ta.value) ? " Write it all in Hebrew." : ""}` }, { role: "user", content: `Lecture: ${l.title}\n\n${material}\n\nHer explanation:\n${ta.value.slice(0, 4000)}` }], b);
      const t = r && parseTeachBack(jsonIn(r));
      if (!t) return r !== undefined && alert(L("המודל לא בדק בצורה הצפויה. נסי שוב.", "The model did not check it in the expected form. Try again."));
      const cards = t.missing.filter((m) => m.card);
      out.replaceChildren(el("p", {}, el("b", {}, L(`הבנה: ${t.score}/100`, `Understanding: ${t.score}/100`))),
        t.covered.length ? el("p", { dir: "auto", class: "small" }, `✓ ${t.covered.join(" · ")}`) : "",
        ...t.missing.map((m) => el("p", { dir: "auto", class: "small" }, `○ ${m.point}`)),
        ...t.wrong.map((w) => el("p", { dir: "auto", class: "small" }, `✗ ${w.said} → ${w.right}`)),
        t.tip ? el("p", { dir: "auto", class: "small muted" }, `💡 ${t.tip}`) : "",
        cards.length ? el("button", { type: "button", onclick: (e) => { for (const m of cards) newCard(c, m.card.front, m.card.back, l.id); if (commit()) { e.currentTarget.disabled = true; e.currentTarget.textContent = L("✓ נוספו", "✓ Added"); } } }, L(`📇 ${cards.length} מה שחסר לכרטיסיות`, `📇 What was missing as ${cards.length} cards`)) : "");
    };
    return el("details", { class: "api" }, el("summary", {}, L("🗣 להסביר במילים שלי", "🗣 Explain it in my words")), ta, b, out);
  }

  /** The writing coach: feedback on her assignment, outline, draft or revision; it never writes the work for her. */
  function writing(c) {
    x.root.append(back({ at: "course", course: c.id }), el("h2", {}, L("✍️ מאמן כתיבה", "✍️ Writing coach")));
    const stage = el("select", { "aria-label": L("שלב", "Stage") }, ...[["assignment", "המטלה (להבין מה מבקשים)", "The assignment"], ["outline", "ראשי פרקים / טענה", "Outline / thesis"], ["draft", "טיוטה", "Draft"], ["revision", "תיקון אחרי הערות", "Revision"]].map(([k, h, e]) => el("option", { value: k }, L(h, e))));
    const text = el("textarea", { rows: "8", dir: "auto", "aria-label": L("הטקסט שלך", "Your text"), placeholder: L("הדביקי את המטלה או את מה שכתבת", "Paste the assignment or what you wrote") });
    const out = el("div");
    const b = el("button", { type: "button", class: "primary" }, L("משוב", "Feedback"));
    b.onclick = async () => {
      const t = text.value.trim();
      if (t.length < 30) return alert(L("כתבי או הדביקי כמה משפטים קודם.", "Write or paste a few sentences first."));
      const passages = findPassages(c.lectures, t.slice(0, 3000), 3000).map((p) => `[${p.title}]\n${p.text}`).join("\n\n---\n\n") || "(No lecture passage matches.)";
      const r = await need([{ role: "system", content: `${WRITING_PROMPT(stage.value)}${heb(t) ? " Write it all in Hebrew." : ""}` }, { role: "user", content: `Her text:\n<<<\n${t.slice(0, 8000)}\n>>>\n\nPassages from her course's lectures:\n${passages}` }], b);
      const f = r && parseWritingFeedback(jsonIn(r), t);
      if (!f) return r !== undefined && alert(L("המאמן לא ענה בצורה הצפויה. נסי שוב.", "The coach did not answer in the expected form. Try again."));
      out.replaceChildren(section("", el("p", { dir: "auto" }, f.summary),
        ...f.dimensions.map((d) => el("p", { dir: "auto", class: "small" }, `${"●".repeat(d.level)}${"○".repeat(4 - d.level)} ${d.name}: ${d.note}`)),
        ...f.comments.map((m) => el("p", { dir: "auto", class: "small" }, el("q", {}, m.quote), ` — ${m.note}`)),
        f.next.length ? el("ol", { dir: "auto" }, ...f.next.map((n) => el("li", {}, n))) : ""));
    };
    x.root.append(section("", el("p", { class: "muted small" }, L("המאמן לא כותב בשבילך: הוא שואל, מצביע על המילים שלך ומסביר, עם מה שבהרצאות.", "The coach never writes it for you: it asks, points to your words and explains, with what the lectures say.")), stage, text, b), out);
  }

  // ---------- the timetable, typed or read from a photo ----------
  const loadTable = () => { try { return cleanTimetable(JSON.parse(localStorage.getItem(TABLE_KEY) || "{}")); } catch { return cleanTimetable({}); } };
  // Her changes carry the time, so the phone's and the computer's copies sync (the later one wins).
  const saveTable = (t, at = Date.now()) => { try { localStorage.setItem(TABLE_KEY, JSON.stringify({ ...t, t: at })); return true; } catch { alert(L("אין מקום לשמור.", "No room to save.")); return false; } };
  const courseName = (id) => x.db().courses.find((c) => c.id === id)?.name ?? "";

  /** On the home page: the class she is in now, or one starting within 10 minutes. */
  function classBanner() {
    const t = loadTable();
    const n = t.slots.length && classNow(t, new Date());
    if (!n) return "";
    const name = courseName(n.slot.courseId);
    return el("section", { class: "api" }, el("b", { dir: "auto" }, n.state === "now" ? L(`🏫 עכשיו: ${name} · עוד ${n.minutes} דק׳`, `🏫 Now: ${name} · ${n.minutes} min left`) : L(`🏫 בעוד ${n.minutes} דק׳: ${name}`, `🏫 In ${n.minutes} min: ${name}`)), n.slot.room ? el("small", { class: "muted" }, n.slot.room) : "",
      btns(x.speech && el("button", { type: "button", onclick: () => go({ at: "record", course: n.slot.courseId }) }, L("🎙 להקליט את השיעור", "🎙 Record the class")), el("button", { type: "button", onclick: () => go({ at: "course", course: n.slot.courseId }) }, L("לקורס", "To the course"))));
  }

  /**
   * Classes from a photo of her timetable (the phone's model reads the text): a hidden file input and a box that lists
   * what was found, with "add them all" (new courses are made, with her field when the name does not tell).
   *
   * @param after - Called once they are added.
   */
  function timetablePhoto(after) {
    const t = loadTable();
    const courses = x.db().courses;
    const found = el("div");
    const shot = el("input", { type: "file", accept: "image/*", hidden: true, onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      found.replaceChildren(el("p", { class: "muted small" }, L("קורא את הצילום… (בטלפון זה לוקח זמן)", "Reading the photo… (this takes a while on a phone)")));
      let text;
      try { text = (await x.extract({ name: "timetable.jpg", data: globalThis.btoa(bin) }))?.text; } catch (err) { return found.replaceChildren(el("p", { class: "muted" }, String(err?.message || err))); }
      if (!text) return found.replaceChildren(el("p", { class: "muted" }, L("לקריאת צילום: בחרי מודל שרואה תמונות (כמו Gemma 4), או התחברי למחשב.", "To read a photo: choose a model that sees pictures (like Gemma 4), or connect to the computer.")));
      const r = await need([{ role: "system", content: TIMETABLE_PHOTO_PROMPT.replace("You read a photo or screenshot", "You read the text of a photo or screenshot") }, { role: "user", content: `The schedule's text:\n${String(text).slice(0, 6000)}` }]);
      const list = r === undefined ? [] : cleanReadClasses(jsonIn(r));
      if (!list.length) return found.replaceChildren(el("p", { class: "muted" }, L("לא נמצאו שיעורים בצילום. נסי צילום חד יותר או צילום מסך של המערכת.", "No classes were found. Try a sharper photo or a screenshot of the schedule.")));
      const match = (name) => courses.find((c) => c.name.trim() === name.trim() || c.name.includes(name) || name.includes(c.name));
      found.replaceChildren(section(L(`נמצאו ${list.length} שיעורים`, `${list.length} classes found`),
        ...list.map((k) => el("div", { class: "ph-row" }, el("span", { dir: "auto" }, `${L(`יום ${DAYS[k.day][0]}`, DAYS[k.day][1])} ${k.start}–${k.end} · ${k.name}${k.room ? ` · ${k.room}` : ""}`), el("small", { class: "muted" }, match(k.name) ? L("✓ קורס קיים", "✓ Existing course") : L("+ קורס חדש", "+ New course")))),
        el("button", { type: "button", class: "primary", onclick: () => {
          const slots = [...t.slots];
          for (const k of list) {
            let c = match(k.name);
            if (!c) { c = { id: uid(), name: k.name.slice(0, 80), createdAt: Date.now(), field: detectField(k.name, "") || loadSetup().field, lectures: [], cards: [], reviews: [], quizzes: [] }; x.db().courses.push(c); courses.push(c); }
            slots.push({ id: `t${uid().slice(0, 8)}`, courseId: c.id, day: k.day, start: k.start, end: k.end, ...(k.room ? { room: k.room } : {}), ...(k.kind ? { kind: k.kind } : {}) });
          }
          if (commit() && saveTable(cleanTimetable({ ...t, slots }))) after();
        } }, L("להוסיף את כולם למערכת", "Add them all to the timetable"))));
    } });
    return { shot, found };
  }

  /** Her week: classes by day, added by hand or read from a photo of the schedule (the phone reads it, its model sorts it). */
  function timetable() {
    const t = loadTable();
    const courses = x.db().courses;
    x.root.append(back({ at: "home" }), el("h2", {}, L("🗓 מערכת שעות", "🗓 Timetable")));
    const days = [0, 1, 2, 3, 4, 5].filter((d) => classesOn(t, d).length);
    x.root.append(section("", ...(days.length ? days.map((d) => el("div", {}, el("b", {}, L(`יום ${DAYS[d][0]}`, DAYS[d][1]), d === new Date().getDay() ? L(" · היום", " · today") : ""),
      ...classesOn(t, d).map((s) => el("div", { class: "ph-row" }, el("span", { dir: "auto" }, `${s.start}–${s.end} · ${courseName(s.courseId) || L("קורס שנמחק", "A deleted course")}${s.room ? ` · ${s.room}` : ""}`),
        el("button", { type: "button", "aria-label": L("להסיר", "Remove"), onclick: () => { t.slots = t.slots.filter((y) => y.id !== s.id); if (saveTable(t)) x.draw(); } }, "✕"))))) : [el("p", { class: "muted" }, L("עוד אין שיעורים. אפשר להוסיף ידנית או מצילום של המערכת.", "No classes yet. Add them by hand or from a photo of your schedule."))])));
    if (courses.length) {
      const course = el("select", { "aria-label": L("קורס", "Course") }, ...courses.map((c) => el("option", { value: c.id }, c.name)));
      const day = el("select", { "aria-label": L("יום", "Day") }, ...[0, 1, 2, 3, 4, 5].map((d) => el("option", { value: String(d) }, L(`יום ${DAYS[d][0]}`, DAYS[d][1]))));
      const start = el("input", { type: "time", value: "10:00", "aria-label": L("התחלה", "Start") });
      const end = el("input", { type: "time", value: "12:00", "aria-label": L("סוף", "End") });
      const room = el("input", { dir: "auto", placeholder: L("חדר", "Room"), style: "width: 90px" });
      x.root.append(section(L("הוספת שיעור", "Add a class"), el("div", { class: "ph-filter", style: "flex-wrap: wrap" }, course, day, start, end, room,
        el("button", { type: "button", class: "primary", onclick: () => {
          const next = cleanTimetable({ ...t, slots: [...t.slots, { id: `t${uid().slice(0, 8)}`, courseId: course.value, day: Number(day.value), start: start.value, end: end.value, room: room.value }] });
          if (next.slots.length === t.slots.length) return alert(L("השעות לא תקינות: הסוף צריך להיות אחרי ההתחלה.", "The times are not valid: the end must be after the start."));
          if (saveTable(next)) x.draw();
        } }, L("הוספה", "Add")))));
    }
    if (x.extract) {
      const { shot, found } = timetablePhoto(() => x.draw());
      x.root.append(section(L("מצילום של המערכת", "From a photo of the schedule"), el("p", { class: "muted small" }, L("צילום מסך מהפורטל או צילום של הדף. קורסים חדשים נוצרים לבד.", "A screenshot from the portal or a photo of the page. New courses are made for you.")), shot, el("button", { type: "button", onclick: () => shot.click() }, L("📷 בחירת צילום", "📷 Choose a photo")), found));
    }
  }

  // ---------- my week: each assignment broken into steps in the days before it is due ----------
  const TONES = ["#a5b4ff", "#7fd8a8", "#f0a830", "#e88ad8", "#6ac0d0"];
  const loadPlans = () => { try { const p = JSON.parse(localStorage.getItem(PLANS_KEY) || "[]"); return Array.isArray(p) ? p.slice(0, 40) : []; } catch { return []; } };
  const savePlans = (p) => { try { localStorage.setItem(PLANS_KEY, JSON.stringify(p)); return true; } catch { alert(L("אין מקום לשמור.", "No room to save.")); return false; } };
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  /** Asks the phone's model for the steps and checks them (checkPlan, as on the computer); an even plan when it cannot. */
  async function makePlan(p, button) {
    const lang = L("he", "en");
    const busy = {};
    for (const o of loadPlans()) if (o.id !== p.id) for (const st of o.steps) if (!st.done) busy[st.date] = (busy[st.date] ?? 0) + st.minutes;
    const now = Date.now();
    const r = await need([{ role: "system", content: planPrompt(lang) }, { role: "user", content: `Assignment: ${p.title}\nCourse: ${p.course}\nToday: ${dayKey(new Date(now))}\nDue: ${new Date(p.due).toISOString().slice(0, 16)}\nAlready planned (minutes per day): ${JSON.stringify(busy)}` }], button);
    if (r === undefined) return undefined;
    let raw;
    try { raw = jsonIn(r); } catch { raw = undefined; }
    return { ...p, steps: checkPlan(raw, now, p.due, busy, lang), createdAt: now };
  }
  function week() {
    x.root.append(back({ at: "home" }), el("h2", {}, L("📅 השבוע שלי", "📅 My week")));
    const plans = loadPlans().sort((a, b) => a.due - b.due);
    const table = loadTable();
    const days = new Map();
    plans.forEach((plan, n) => plan.steps.forEach((step, i) => { const list = days.get(step.date) ?? []; list.push({ plan, step, i, tone: TONES[n % TONES.length] }); days.set(step.date, list); }));
    const today = dayKey(new Date());
    const keys = [...days.keys()].filter((k) => k >= today || days.get(k).some((e) => !e.step.done)).sort().slice(0, 10);
    const name = (k) => k === today ? L("היום", "Today") : new Date(`${k}T12:00`).toLocaleDateString(L("he-IL", "en-GB"), { weekday: "long", day: "numeric", month: "numeric" });
    const save = (fn) => { const all = loadPlans(); fn(all); if (savePlans(all)) x.draw(); };
    x.root.append(section("", ...(keys.length ? keys.map((k) => {
      const list = days.get(k);
      const times = table.slots.length ? freeSlots(table, k, list.map((e) => e.step.minutes)) : [];
      return el("div", {}, el("b", {}, name(k)), ...list.map((e, j) => el("label", { class: "ph-row", style: `border-inline-start: 4px solid ${e.tone}; padding-inline-start: 8px` },
        el("input", { type: "checkbox", checked: e.step.done ? "" : undefined, onchange: (ev) => save((all) => { const pl = all.find((y) => y.id === e.plan.id); if (pl?.steps[e.i]) pl.steps[e.i].done = ev.currentTarget.checked; }) }),
        el("span", { dir: "auto", style: `flex: 1; min-width: 0; overflow-wrap: anywhere${e.step.done ? "; text-decoration: line-through; opacity: .6" : ""}` }, `${times[j] ? `${times[j]} · ` : ""}${e.step.title} (${e.step.minutes} ${L("דק׳", "min")}) · ${e.plan.title}`))));
    }) : [el("p", { class: "muted" }, L("אין עדיין הגשות. הוסיפי מטלה, והמודל בטלפון יפרק אותה לצעדים עד ההגשה.", "No assignments yet. Add one, and the phone's model breaks it into steps until it is due."))])));
    if (plans.length) x.root.append(section(L("ההגשות", "Assignments"), ...plans.map((p) => el("div", { class: "ph-row" },
      el("span", { dir: "auto", style: "flex: 1; min-width: 0; overflow-wrap: anywhere" }, `${p.title}${p.course ? ` · ${p.course}` : ""} · ${new Date(p.due).toLocaleDateString(L("he-IL", "en-GB"))}`),
      el("button", { type: "button", onclick: async (ev) => { const n = await makePlan(p, ev.currentTarget); if (n) save((all) => { const i = all.findIndex((y) => y.id === p.id); if (i >= 0) all[i] = n; }); } }, L("🔁 לתכנן מחדש", "🔁 Plan again")),
      el("button", { type: "button", "aria-label": L(`למחוק את ${p.title}`, `Delete ${p.title}`), onclick: () => confirm(L("למחוק את התכנית?", "Delete the plan?")) && save((all) => all.splice(all.findIndex((y) => y.id === p.id), 1)) }, "✕")))));
    const title = el("input", { dir: "auto", "aria-label": L("מה מגישים", "What is due"), placeholder: L("למשל: עבודה מסכמת", "e.g. Final paper"), style: "flex: 1 1 100%; min-width: 0" });
    const course = el("select", { "aria-label": L("קורס", "Course") }, el("option", { value: "" }, L("בלי קורס", "No course")), ...x.db().courses.map((c) => el("option", { value: c.name }, c.name)));
    const date = el("input", { type: "date", "aria-label": L("תאריך הגשה", "Due date"), min: today });
    const add = el("button", { type: "button", class: "primary" }, L("לתכנן", "Plan it"));
    add.onclick = async () => {
      const due = date.value ? new Date(`${date.value}T23:59`).getTime() : NaN;
      if (!title.value.trim() || !(due > Date.now())) return alert(L("כתבי מה מגישים ומתי.", "Write what is due and when."));
      const p = await makePlan({ id: `p${uid().slice(0, 10)}`, title: title.value.trim().slice(0, 160), course: course.value.slice(0, 120), due }, add);
      if (p) save((all) => all.push(p));
    };
    x.root.append(section(L("+ הגשה", "+ Assignment"), el("div", { class: "ph-filter", style: "flex-wrap: wrap" }, title, course, date, add),
      table.slots.length ? "" : el("p", { class: "muted small" }, L("עם מערכת שעות, לכל צעד תוצע שעה פנויה סביב השיעורים.", "With a timetable, each step gets a free time around your classes."))));
  }

  /** The timetable for a sync with the computer, and the computer's answer taken when it is newer. */
  const tableSync = {
    out: () => { const t = loadTable(); return t.t ? t : undefined; },
    in: (theirs) => { const t = theirs && cleanTimetable(theirs); if (t?.t && t.t > (loadTable().t ?? 0)) saveTable(t, t.t); },
  };

  /** Her grades for a sync with the computer, and the computer's copy taken when it is newer. */
  const gradesSync = {
    out: () => { try { const g = cleanGrades(JSON.parse(localStorage.getItem(GRADES_KEY) || "{}")); return g.t ? g : undefined; } catch { return undefined; } },
    in: (theirs) => {
      const g = theirs && cleanGrades(theirs);
      let mine = 0;
      try { mine = cleanGrades(JSON.parse(localStorage.getItem(GRADES_KEY) || "{}")).t ?? 0; } catch { mine = 0; }
      if (g?.t && g.t > mine) try { localStorage.setItem(GRADES_KEY, JSON.stringify(g)); } catch { /* full: kept as it was */ }
    },
  };

  return { goalReminder, goalCard, backOnTrack, phoneImage, needsSetup, setupView, setupList, addHighlight, highlightsBox, teachBackBox, tableSync, gradesSync, courseButtons, examEve, hardCards, cardTimer, noteCardsBtn, portions, podcastBtn, whereBtn, quizTalk, questionCheck, micButton, sayButton, homeworkExtras, views: { feed, web, palace, letter, rehearse, papers, mock, writing, practice, match, occlusion }, homeViews: { grades, english, timetable, week, myProgress: progress }, classBanner };
}
