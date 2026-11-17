/* global localStorage, fetch, alert, navigator, document, setInterval, clearInterval, AudioContext, Blob, URL */
/**
 * The phone's own Study, part two (Roee: "everything that can work alone on the phone should"): the features the
 * computer's Study page gained in students parts 25–34, here with no computer — the feed, hard cards and the card
 * timer, cards from notes, reading in portions, the days before an exam, grades with the degree and Moed B, where a
 * term appears, the course web, the memory palace, the two-voice podcast, what to learn from a quiz, a similar
 * problem, letters to the lecturer, academic English, presentation rehearsal and papers. The same shared code as the
 * computer (vendor/study-core.js), the phone's own model, and the same course data, so all of it syncs.
 */
import { createEmptyCard, findPassages, jsonIn, leechCards, LEECH_PROMPT, noteCards, readingPortion, studyFeed, courseWeb, whereTerm, QUIZ_TALK_PROMPT, SIMILAR_MARK, PALACE_PROMPT, PALACE_SPOTS_HE, cleanPalace, PODCAST_PROMPT, parsePodcast, letterPrompt, parseLetter, ENGLISH_PROMPT, cleanEnglish, REHEARSE_PROMPT, speechStats, PAPERS_PROMPT, parseOpenAlex, cleanDoi, cleanSources, apaRef, apaCite, chicagoRef, chicagoCite, parseBibtex, parseRis, toBibtex, toRis, cleanGrades, rowGrade, weightedAverage, degreeProgress, moedB, detectField, cleanTimetable, classNow, classesOn, TIMETABLE_PHOTO_PROMPT, cleanReadClasses } from "./vendor/study-core.js";

const GRADES_KEY = "kesherai-grades";
const TIMER_KEY = "kesherai-card-timer";
const TABLE_KEY = "kesherai-timetable";
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
      el("button", { type: "button", onclick: () => go({ at: "feed", course: c.id }) }, L("📱 פיד", "📱 Feed")),
      el("button", { type: "button", onclick: () => go({ at: "web", course: c.id }) }, L("🕸 מפת הקורס", "🕸 Course web")),
      el("button", { type: "button", onclick: () => go({ at: "palace", course: c.id }) }, L("🏛 ארמון זיכרון", "🏛 Memory palace")),
      el("button", { type: "button", onclick: () => go({ at: "papers", course: c.id }) }, L("📚 מאמרים ומקורות", "📚 Papers and sources")),
      x.speech && el("button", { type: "button", onclick: () => go({ at: "rehearse", course: c.id }) }, L("🎤 חזרה על הצגה", "🎤 Rehearse a talk")),
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
    const missed = z.questions.filter((q, i) => z.picked[i] !== q.answer);
    if (!missed.length) return "";
    const out = el("p", { dir: "auto", style: "white-space: pre-wrap" });
    const b = el("button", { type: "button" }, L("💬 מה ללמוד מזה?", "💬 What should I learn from this?"));
    b.onclick = async () => {
      const text = missed.map((q) => `- ${q.q}\n  Her answer: ${q.options[z.picked[z.questions.indexOf(q)]] ?? "(none)"}\n  Right: ${q.options[q.answer]}. ${q.explain || ""}${q.lectureId ? `\n  Lecture: ${c.lectures.find((l) => l.id === q.lectureId)?.title ?? ""}` : ""}`).join("\n");
      const r = await need([{ role: "system", content: QUIZ_TALK_PROMPT }, { role: "user", content: `Score: ${z.questions.length - missed.length} of ${z.questions.length}.\nQuestions she missed:\n${text}` }], b);
      if (r !== undefined) { out.textContent = String(r).trim(); b.hidden = true; }
    };
    return el("div", {}, b, out);
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
        const opts = it.options.map((o, k) => el("button", { type: "button", dir: "auto", style: "display: block; width: 100%; text-align: start; margin: 4px 0", onclick: () => { opts.forEach((b, j) => { b.disabled = true; if (j === it.answer) b.style.borderColor = "#6fd3a5"; else if (j === k) b.style.borderColor = "#f08a8a"; }); why.textContent = it.explain || ""; } }, o));
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
      out.replaceChildren(...p.questions.map((q) => {
        const why = el("p", { class: "muted small", dir: "auto" });
        const opts = q.options.map((o, k) => el("button", { type: "button", dir: "ltr", style: "display: block; width: 100%; text-align: left; margin: 4px 0", onclick: () => { opts.forEach((y, j) => { y.disabled = true; if (j === q.answer) y.style.borderColor = "#6fd3a5"; else if (j === k) y.style.borderColor = "#f08a8a"; }); why.textContent = q.explain; } }, o));
        return section("", el("b", { dir: "ltr" }, q.q), ...opts, why);
      }), p.words.length ? section(L("מילים מהטקסט", "Words from the text"), ...p.words.map((w) => el("div", { class: "ph-row" }, el("span", { dir: "ltr" }, w.en), el("span", { dir: "rtl" }, w.he))),
        x.db().courses.length ? el("div", { class: "ph-filter" }, course, el("button", { type: "button", onclick: () => { const c = x.db().courses.find((y) => y.id === course.value); if (!c) return; for (const w of p.words) newCard(c, w.en, w.he); if (commit()) alert(L(`נוספו ${p.words.length} כרטיסיות`, `${p.words.length} cards added`)); } }, L("📇 לכרטיסיות", "📇 Into cards"))) : "") : "");
    };
    x.root.append(section("", text, b), out);
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

  /** Her week: classes by day, added by hand or read from a photo of the schedule (the phone reads it, its model sorts it). */
  function timetable() {
    const t = loadTable();
    const courses = x.db().courses;
    x.root.append(back({ at: "home" }), el("h2", {}, L("🗓 מערכת שעות", "🗓 Timetable")));
    const days = [0, 1, 2, 3, 4, 5].filter((d) => classesOn(t, d).length);
    x.root.append(section("", ...(days.length ? days.map((d) => el("div", {}, el("b", {}, L(`יום ${DAYS[d][0]}`, DAYS[d][1])),
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
              if (!c) { c = { id: uid(), name: k.name.slice(0, 80), createdAt: Date.now(), field: detectField(k.name, ""), lectures: [], cards: [], reviews: [], quizzes: [] }; x.db().courses.push(c); courses.push(c); }
              slots.push({ id: `t${uid().slice(0, 8)}`, courseId: c.id, day: k.day, start: k.start, end: k.end, ...(k.room ? { room: k.room } : {}), ...(k.kind ? { kind: k.kind } : {}) });
            }
            if (commit() && saveTable(cleanTimetable({ ...t, slots }))) x.draw();
          } }, L("להוסיף את כולם למערכת", "Add them all to the timetable"))));
      } });
      x.root.append(section(L("מצילום של המערכת", "From a photo of the schedule"), el("p", { class: "muted small" }, L("צילום מסך מהפורטל או צילום של הדף. קורסים חדשים נוצרים לבד.", "A screenshot from the portal or a photo of the page. New courses are made for you.")), shot, el("button", { type: "button", onclick: () => shot.click() }, L("📷 בחירת צילום", "📷 Choose a photo")), found));
    }
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

  return { tableSync, gradesSync, courseButtons, examEve, hardCards, cardTimer, noteCardsBtn, portions, podcastBtn, whereBtn, quizTalk, homeworkExtras, views: { feed, web, palace, letter, rehearse, papers }, homeViews: { grades, english, timetable }, classBanner };
}
