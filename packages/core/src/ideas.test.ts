import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATIVE_PROMPT, SUMMARY_PROMPT, fallbackDirections, splitTranscript, peekIdeas, cleanIdeas, editIdea, ideaNote, ideaQuery, ideaTask, mergeIdeas, researchPrompt, sessionMatches, splitIdea, type Idea } from "@kesher/shared";
import { Ideas, type IdeasDeps } from "./ideas.js";

const wait = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20));
};

const deps = (over: Partial<IdeasDeps> = {}): IdeasDeps & { started: string[]; notes: string[]; tasks: Array<{ title: string; goal: string; acceptance?: string }> } => {
  const started: string[] = [];
  const notes: string[] = [];
  const tasks: Array<{ title: string; goal: string; acceptance?: string }> = [];
  return {
    started,
    notes,
    tasks,
    saveNote: async (_title, md) => (notes.push(md), `n${notes.length}.md`),
    addTask: async (t) => (tasks.push(t), `r-${tasks.length}`),
    ask: async (system) =>
      system.includes("thinking aloud")
        ? '[{"title":"ללמד בחזרה לקוד","prompt":"בנה מצב שבו אני מסביר קוד בקול","verdict":"good","why":"עוזר להבין","projects":["kesherai","Other"],"audience":"סטודנטים"},{"title":"תזכורת מים","prompt":"אפליקציה שמזכירה לשתות","verdict":"weak","why":"קיים בכל מקום","projects":[],"audience":"כללי"},{"title":"","prompt":"x"}]'
        : '[{"i":0,"tried":true,"note":"דיברנו על זה באוקטובר"}]',
    transcribe: async () => "אממ… אולי מצב ללמד בחזרה לקוד… ואפליקציה למים",
    projects: () => ["KesherAI", "Unreal plugin"],
    search: async (q) => (q.includes("ללמד") ? [{ id: "c1", title: "ללמד בחזרה", snippet: "מצב ללמד בחזרה בקוד", score: 3 }] : []),
    startResearch: async (title) => {
      started.push(title);
      return `conv-${started.length}`;
    },
    settle: async () => "done",
    ...over,
  };
};

test("cleanIdeas keeps only her projects, needs a title and prompt, and defaults the verdict", () => {
  const out = cleanIdeas([{ title: "A", prompt: "do A", verdict: "great", projects: ["kesherai", "nope"] }, { title: "B" }], ["KesherAI"], (i) => `i${i}`);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "maybe");
  assert.deepEqual(out[0]!.projects, ["KesherAI"]);
  assert.equal(cleanIdeas("nope", [], String).length, 0);
  assert.match(ideaQuery({ title: "תוסף Unreal לרמות", prompt: "לייצר רמות מתמונה של מפה" }), /Unreal/);
  assert.match(researchPrompt({ ...out[0]!, audience: "devs" }, true), /מחקר מעמיק \(deep_research\)[\s\S]*קהל יעד: devs/);
  assert.match(researchPrompt(out[0]!, false), /^Research deeply \(deep_research\)/);
});

test("cleanIdeas reads kind, next step and her own words, and drops a quote that is not in the transcript", () => {
  const said = "אז חשבתי — maybe a Unity plugin שמייצר levels מתמונה. וגם צריך לשלם חשבון חשמל עד יום שני.";
  const out = cleanIdeas([
    { kind: "idea", title: "Unity plugin", prompt: "Build it", quote: "“maybe a Unity plugin שמייצר levels מתמונה.”", next: "  חפש  plugins קיימים " },
    { kind: "chore", title: "חשמל", prompt: "לשלם", quote: "צריך לשלם את החשבון מחר" },
    { kind: "question", title: "Q", prompt: "?", quote: 42 },
  ], [], (i) => `i${i}`, said);
  assert.equal(out[0]!.kind, "idea");
  assert.equal(out[0]!.quote, "maybe a Unity plugin שמייצר levels מתמונה.");
  assert.equal(out[0]!.next, "חפש plugins קיימים");
  assert.equal(out[1]!.kind, "idea", "an unknown kind is an idea");
  assert.equal(out[1]!.quote, undefined, "a paraphrase is not her words");
  assert.equal(out[2]!.kind, "question");
  assert.equal(out[2]!.quote, undefined);
});

const idea = (id: string, over: Partial<Idea> = {}): Idea => ({ id, title: id.toUpperCase(), prompt: `do ${id}`, verdict: "maybe", why: "", projects: [], audience: "", tried: "no", ...over });

test("review helpers: edit, merge, split; notes, tasks and session search", () => {
  const a = idea("a", { quote: "said a", research: { conversationId: "c", status: "done" } });
  const e = editIdea(a, { title: "  New  ", prompt: "", kind: "task", verdict: "great", quote: "", next: "go" });
  assert.equal(e.title, "New");
  assert.equal(e.prompt, "do a", "an empty prompt keeps the old one");
  assert.equal(e.kind, "task");
  assert.equal(e.verdict, "maybe");
  assert.equal(e.quote, undefined);
  assert.equal(e.next, "go");
  assert.deepEqual(editIdea(a, null), a);

  const list = [a, idea("b", { verdict: "good", projects: ["P"], quote: "said b" }), idea("c")];
  const m = mergeIdeas(list, ["a", "b"], "m")!;
  assert.deepEqual(m.map((i) => i.id), ["m", "c"]);
  assert.equal(m[0]!.title, "A + B");
  assert.equal(m[0]!.verdict, "good");
  assert.equal(m[0]!.quote, "said a … said b");
  assert.deepEqual(m[0]!.projects, ["P"]);
  assert.equal(m[0]!.research, undefined);
  assert.equal(mergeIdeas(list, ["a", "zzz"], "m"), undefined);

  const sp = splitIdea(list, "b", [idea("x"), idea("y")])!;
  assert.deepEqual(sp.map((i) => i.id), ["a", "x", "y", "c"]);
  assert.deepEqual(sp[1]!.projects, ["P"]);
  assert.equal(splitIdea(list, "b", [idea("x")]), undefined);
  assert.equal(splitIdea(list, "nope", [idea("x"), idea("y")]), undefined);

  const note = ideaNote({ ...a, kind: "question", next: "ask", projects: ["P"] }, Date.UTC(2026, 10, 21), true);
  assert.match(note, /^# A\n\nשאלה · ממוח פתוח · 2026-11-21\n\n> said a\n\ndo a\n\n\*\*הצעד הבא:\*\* ask/);
  assert.deepEqual(ideaTask({ ...a, next: "done when X" }), { title: "A", goal: 'do a\n"said a"', acceptance: "done when X" });

  const s = { transcript: "דיברתי על Unity ועל צ׳אט", ideas: [idea("q", { title: "Level maker" })] };
  assert.ok(sessionMatches(s, ""));
  assert.ok(sessionMatches(s, "unity LEVEL"));
  assert.ok(sessionMatches(s, "צ׳אט"));
  assert.ok(!sessionMatches(s, "unreal"));
});

test("a session's review and actions: edit, delete, merge, split (own lines or the model), note, task, search", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ideas-"));
  try {
    const d = deps();
    const ideas = new Ideas(dir, d);
    const s = await ideas.start({ text: "אממ… אולי מצב ללמד בחזרה לקוד… ואפליקציה למים" });
    await wait(async () => (await ideas.get(s.id)).status === "done");
    let got = await ideas.get(s.id);
    const [one, two] = got.ideas;
    got = await ideas.edit(s.id, one!.id, { kind: "task", next: "לכתוב אב טיפוס" });
    assert.equal(got.ideas[0]!.kind, "task");
    got = await ideas.saveNote(s.id, one!.id, true);
    got = await ideas.saveNote(s.id, one!.id, true);
    assert.equal(d.notes.length, 1, "saved once");
    assert.equal(got.ideas[0]!.note, "n1.md");
    assert.match(d.notes[0]!, /משימה[\s\S]*הצעד הבא:\*\* לכתוב אב טיפוס/);
    got = await ideas.toTask(s.id, one!.id);
    await ideas.toTask(s.id, one!.id);
    assert.equal(d.tasks.length, 1);
    assert.equal(got.ideas[0]!.task, "r-1");
    assert.equal(d.tasks[0]!.acceptance, "לכתוב אב טיפוס");

    got = await ideas.split(s.id, two!.id, ["מים בבוקר", " ", "מים בערב"]);
    assert.deepEqual(got.ideas.slice(1).map((i) => i.title), ["מים בבוקר", "מים בערב"]);
    got = await ideas.merge(s.id, got.ideas.slice(1).map((i) => i.id));
    assert.equal(got.ideas.length, 2);
    assert.equal(got.ideas[1]!.title, "מים בבוקר + מים בערב");
    // Without her own lines the model splits it (the fake answers with two ideas).
    got = await ideas.split(s.id, got.ideas[1]!.id);
    assert.equal(got.ideas.length, 3);
    await assert.rejects(ideas.merge(s.id, [got.ideas[1]!.id]), /at least two/);
    got = await ideas.removeIdea(s.id, got.ideas[2]!.id);
    got = await ideas.removeIdea(s.id, got.ideas[1]!.id);
    assert.equal(got.ideas.length, 1);
    // One part back from the model is not a split.
    const lone = new Ideas(dir, { ...d, ask: async () => '[{"title":"one","prompt":"one"}]' });
    await assert.rejects(lone.split(s.id, got.ideas[0]!.id), /could not be split/);
    await assert.rejects(ideas.edit(s.id, "nope", {}), /No such idea/);

    assert.equal((await ideas.list("ללמד")).length, 1);
    assert.equal((await ideas.list("unreal")).length, 0);
    assert.deepEqual((await ideas.list())[0]!.titles, ["ללמד בחזרה לקוד"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recording becomes sorted ideas, with 'tried before' from her past chats, and the audio is deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ideas-"));
  try {
    const d = deps();
    const ideas = new Ideas(join(dir, "ideas"), d);
    const audio = join(dir, "a.webm");
    await writeFile(audio, "x");
    const s = await ideas.start({ file: audio, seconds: 600 });
    await wait(async () => (await ideas.get(s.id)).status === "done");
    const got = await ideas.get(s.id);
    assert.equal(got.status, "done");
    assert.equal(got.ideas.length, 2);
    assert.deepEqual(got.ideas[0]!.projects, ["KesherAI"]);
    assert.equal(got.ideas[0]!.tried, "yes");
    assert.equal(got.ideas[0]!.triedIn?.[0]?.conversationId, "c1");
    assert.equal(got.ideas[1]!.tried, "no");
    assert.equal(existsSync(audio), false);
    const list = await ideas.list();
    assert.equal(list[0]!.count, 2);
    assert.equal(list[0]!.good, 1);

    // Research all: good ones first, one at a time, each a chat.
    await ideas.researchAll(s.id, true);
    await wait(async () => !(await ideas.get(s.id)).researchAll);
    const after = await ideas.get(s.id);
    assert.deepEqual(d.started, ["🔬 ללמד בחזרה לקוד", "🔬 תזכורת מים"]);
    assert.ok(after.ideas.every((i) => i.research?.status === "done"));
    // Asking again opens the same chat.
    assert.equal(await ideas.research(s.id, after.ideas[0]!.id, true), after.ideas[0]!.research!.conversationId);
    assert.equal(d.started.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed session keeps its error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ideas-"));
  try {
    const ideas = new Ideas(dir, deps({ ask: async () => "no json here" }));
    const s = await ideas.start({ text: "סתם" });
    await wait(async () => (await ideas.get(s.id)).status !== "sorting");
    assert.equal((await ideas.get(s.id)).status, "error");
    await assert.rejects(ideas.get("../etc"), /No such session/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Hebrew speech gets Hebrew ideas: an English answer is asked again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ideas-"));
  try {
    let calls = 0;
    const ideas = new Ideas(dir, deps({
      ask: async (system, user) => {
        if (!system.includes("thinking aloud")) return "[]";
        calls++;
        assert.match(user, /IN HEBREW/);
        return user.includes("was in English") ? '[{"title":"מצב הסבר קוד","prompt":"בנה מצב שבו אני מסביר קוד","verdict":"good"}]' : '[{"title":"Code explain mode","prompt":"Build a mode","verdict":"good"}]';
      },
    }));
    const s = await ideas.start({ text: "אממ חשבתי שאולי אפשר לעשות מצב שבו אני מסביר קוד בקול והמערכת בודקת אם הבנתי" });
    await wait(async () => (await ideas.get(s.id)).status === "done");
    // Two calls (the English answer, asked again) for the first pass; the creative pass after it (one idea is little) asks twice too.
    assert.equal(calls, 4);
    assert.equal((await ideas.get(s.id)).ideas[0]!.title, "מצב הסבר קוד");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("peekIdeas counts only complete items, by kind, and names the newest", () => {
  const part = 'thinking…\n[{"kind":"idea","title":"A pixel-art monkey game","prompt":"p"},{"kind":"task","title":"Send the CV","prompt":"p"},{"kind":"question","title":"Is it worth it?","prompt":"p"},{"kind":"idea","title":"Half writ';
  assert.deepEqual(peekIdeas(part), { ideas: 1, tasks: 1, questions: 1, last: "Is it worth it?" });
  assert.deepEqual(peekIdeas("no array yet"), { ideas: 0, tasks: 0, questions: 0 });
  assert.equal(peekIdeas('[{"title":"Old one without a kind","prompt":"p"}]').ideas, 1);
});

test("a session reports its stage and live details while it is analysed, and none once done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ideas-"));
  try {
    const file = join(dir, "a.wav");
    await writeFile(file, "x");
    let releaseSpeech!: () => void;
    let releaseModel!: () => void;
    const speech = new Promise<void>((r) => (releaseSpeech = r));
    const model = new Promise<void>((r) => (releaseModel = r));
    const ideas = new Ideas(dir, deps({
      transcribe: async () => (await speech, "מצב ללמד בחזרה"),
      ask: async (system, _user, _signal, onText) => {
        if (!system.includes("thinking aloud")) return "[]";
        onText?.('[{"kind":"task","title":"Send the CV","prompt":"p","verdict":"good"},');
        await model;
        return '[{"kind":"task","title":"Send the CV","prompt":"p","verdict":"good"},{"kind":"idea","title":"Monkey game","prompt":"p"}]';
      },
    }));
    const s = await ideas.start({ file, seconds: 600 });
    // The analysis starts in the background: on a busy machine its first stage is set a moment after start() returns.
    await wait(async () => (await ideas.get(s.id)).progress?.stage === "transcribing");
    let p = (await ideas.get(s.id)).progress;
    assert.equal(p?.stage, "transcribing");
    assert.equal(p?.audioSeconds, 600);
    assert.ok((p?.expectedSeconds ?? 0) > 0);
    releaseSpeech();
    await wait(async () => (await ideas.get(s.id)).progress?.stage === "splitting" && (await ideas.get(s.id)).progress?.found?.tasks === 1);
    p = (await ideas.get(s.id)).progress;
    assert.deepEqual(p?.found, { ideas: 0, tasks: 1, questions: 0, last: "Send the CV" });
    releaseModel();
    await wait(async () => (await ideas.get(s.id)).status === "done");
    const done = await ideas.get(s.id);
    assert.equal(done.progress, undefined);
    assert.equal(done.ideas.length, 2);
    // Never written to disk.
    assert.equal(JSON.stringify(JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, `${s.id}.json`), "utf8"))).includes("progress"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Starts a session from text and waits until the background analysis ends. */
const done = async (ideas: Ideas, text: string) => {
  const s = await ideas.start({ text });
  await wait(async () => ["done", "error"].includes((await ideas.get(s.id)).status));
  return ideas.get(s.id);
};
const HE = "אני כועס על שירות המשלוחים. המנוי שלי עלה ואף אחד לא נתן פיצוי על האיחור. אני צריך להתקשר אליהם מחר בבוקר. אולי אפשר לבנות משהו שמשווה בין שירותי משלוחים.";

test("splitTranscript cuts long text at sentence ends and loses nothing", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const parts = splitTranscript(text, 200);
  assert.ok(parts.length > 4 && parts.every((p) => p.length <= 200));
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text);
  assert.deepEqual(splitTranscript("short"), ["short"]);
});

test("fallbackDirections gives up to three inferred directions that quote the transcript", () => {
  const f = fallbackDirections(HE, (i) => `d${i}`);
  assert.ok(f.ideas.length >= 2 && f.ideas.length <= 3);
  for (const i of f.ideas) assert.ok(i.inferred && HE.includes(i.quote!) && /[\u0590-\u05FF]/.test(i.prompt));
  assert.equal(fallbackDirections("hm", String).ideas.length, 0);
});

test("a first pass that finds nothing is followed by the creative pass, whose items are marked inferred", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ideas-"));
  try {
    const seen: string[] = [];
    const ideas = new Ideas(dir, deps({
      ask: async (system) => {
        if (system.includes("THINK OUTSIDE THE BOX")) { seen.push("creative"); return JSON.stringify([{ kind: "idea", title: "השוואת שירותי משלוחים", prompt: "אפליקציה שמשווה", quote: "אפשר לבנות משהו שמשווה בין שירותי משלוחים", verdict: "maybe" }]); }
        if (system.includes("thinking aloud")) { seen.push("first"); return "[]"; }
        return "[]";
      },
    }));
    const s = await done(ideas, HE);
    assert.equal(s.status, "done");
    assert.deepEqual(seen.slice(0, 2), ["first", "creative"]);
    assert.equal(s.ideas[0]!.inferred, true);
    assert.equal(s.summary, undefined);
    assert.ok(CREATIVE_PROMPT.includes("inferred"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("never ends with zero: a model summary with directions, then the local floor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ideas-"));
  try {
    const viaModel = new Ideas(dir, deps({ ask: async (system) => (system === SUMMARY_PROMPT ? JSON.stringify({ summary: "דיברו על שירות משלוחים", directions: [{ kind: "task", title: "להתקשר לשירות", prompt: "לבקש פיצוי", quote: "אני צריך להתקשר אליהם מחר בבוקר" }] }) : "[]") }));
    const a = await done(viaModel, HE);
    assert.equal(a.status, "done");
    assert.equal(a.summary, "דיברו על שירות משלוחים");
    assert.equal(a.ideas[0]!.inferred, true);
    const floor = new Ideas(dir, deps({ ask: async () => "I cannot find anything" }));
    const b = await done(floor, HE);
    assert.equal(b.status, "done");
    assert.ok(b.ideas.length >= 2 && b.ideas.every((i) => i.inferred) && b.summary);
    const none = await done(floor, "אממ");
    assert.equal(none.status, "error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a long transcript is read in parts: every part is asked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ideas-"));
  try {
    const asked: number[] = [];
    const long = Array.from({ length: 900 }, (_, i) => `This is spoken sentence ${i} about things.`).join(" ");
    const ideas = new Ideas(dir, deps({ ask: async (system, user) => {
      if (system.includes("thinking aloud") && !system.includes("OUTSIDE")) { asked.push(user.length); return JSON.stringify([{ title: `Idea ${asked.length}`, prompt: "p" }, { title: `Other ${asked.length}`, prompt: "p" }, { title: `Third ${asked.length}`, prompt: "p" }]); }
      return "[]";
    } }));
    const s = await done(ideas, long);
    assert.ok(asked.length >= 3);
    assert.equal(s.ideas.length, asked.length * 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Analyse again goes one level deeper each time, keeps earlier ideas and adds only new ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ideas-"));
  try {
    const calls: Array<{ kind: string; strong: boolean; user: string }> = [];
    const idea = (t: string) => ({ kind: "idea", title: t, prompt: "p", quote: "אני צריך להתקשר אליהם מחר בבוקר" });
    const ideas = new Ideas(dir, deps({
      ask: async (system, user, _s, _t, strong) => {
        const kind = system.includes("CHALLENGE THEM") ? "challenge" : system.includes("OUTSIDE") ? "creative" : system.includes("thinking aloud") ? "normal" : "other";
        if (kind === "other") return "[]";
        calls.push({ kind, strong: !!strong, user });
        if (kind === "normal") return JSON.stringify([idea("A"), idea("B"), idea("C")]);
        if (kind === "creative") return JSON.stringify([idea("A"), idea("D")]);
        return JSON.stringify([idea("A"), idea("E")]);
      },
    }));
    const first = await done(ideas, HE);
    assert.equal(first.depth, 1);
    assert.deepEqual(first.ideas.map((i) => i.title), ["A", "B", "C"]);
    const level = async () => { await ideas.deeper(first.id); await wait(async () => (await ideas.get(first.id)).status === "done"); return ideas.get(first.id); };
    const two = await level();
    assert.equal(two.depth, 2);
    assert.deepEqual(two.ideas.map((i) => i.title), ["A", "B", "C", "D"]);
    assert.ok(two.ideas[3]!.inferred);
    const three = await level();
    assert.equal(three.depth, 3);
    assert.ok(calls.some((c) => c.kind === "normal" && c.strong) && calls.some((c) => c.kind === "creative" && c.strong));
    const four = await level();
    assert.equal(four.depth, 4);
    assert.deepEqual(four.ideas.map((i) => i.title), ["A", "B", "C", "D", "E"]);
    // The challenge pass is told what was already found.
    const ch = calls.filter((c) => c.kind === "challenge");
    assert.ok(ch.length >= 1 && /ALREADY FOUND:\n- A\n- B\n- C\n- D/.test(ch[0]!.user) && ch.every((c) => c.strong));
    // Not while it is running.
    await ideas.deeper(first.id);
    await assert.rejects(ideas.deeper(first.id), /still being analysed/);
    await wait(async () => (await ideas.get(first.id)).status === "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing deeper pass keeps the earlier ideas and says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ideas-"));
  try {
    let fail = false;
    const ideas = new Ideas(dir, deps({ ask: async (system) => { if (fail) throw new Error("model is off"); return system.includes("thinking aloud") ? JSON.stringify([{ title: "A", prompt: "p" }, { title: "B", prompt: "p" }, { title: "C", prompt: "p" }]) : "[]"; } }));
    const first = await done(ideas, HE);
    fail = true;
    await ideas.deeper(first.id);
    await wait(async () => (await ideas.get(first.id)).status === "done");
    const s = await ideas.get(first.id);
    assert.equal(s.ideas.length, 3);
    assert.equal(s.deeperError, "model is off");
    assert.equal(s.depth, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
