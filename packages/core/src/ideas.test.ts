import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanIdeas, ideaQuery, researchPrompt } from "@kesher/shared";
import { Ideas, type IdeasDeps } from "./ideas.js";

const wait = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20));
};

const deps = (over: Partial<IdeasDeps> = {}): IdeasDeps & { started: string[] } => {
  const started: string[] = [];
  return {
    started,
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
  assert.match(researchPrompt({ ...out[0]!, audience: "devs" }, true), /מחקר מעמיק[\s\S]*קהל יעד: devs/);
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
