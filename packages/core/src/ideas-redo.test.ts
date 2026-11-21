import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKept, type IdeaSession } from "@kesher/shared";
import { Ideas, type IdeasDeps } from "./ideas.js";
import { IdeaAudio, type AudioPolicy } from "./ideas-audio.js";

const wait = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20));
};
const idea = (title: string) => ({ title, prompt: `do ${title}`, verdict: "good", why: "w", projects: [], audience: "a" });

/** Open mind with a fake whisper that answers by the language asked for, and a fake model that finds one idea per transcript line. */
async function setup(mode: AudioPolicy["mode"] = "days", over: Partial<IdeasDeps> = {}) {
  const base = await mkdtemp(join(tmpdir(), "kesher-ideas-redo-"));
  const calls: Array<{ lang?: string; language?: string }> = [];
  const audio = new IdeaAudio(join(base, "kept"));
  const ideas = new Ideas(join(base, "ideas"), {
    audio,
    audioPolicy: () => ({ mode, days: 30, capBytes: 5 * 1024 ** 3 }),
    transcribe: async (_f, lang, language) => {
      calls.push({ ...(lang ? { lang } : {}), ...(language ? { language } : {}) });
      return language === "he" ? { text: "שלום עולם זה רעיון על בישול", language: "he" } : { text: "Hola mundo esto es una idea sobre cocina", language: "es" };
    },
    ask: async (system, user) => (system.includes("thinking aloud") ? JSON.stringify([idea(user.includes("בישול") ? "בישול" : "cocina")]) : "[]"),
    projects: () => [],
    search: async () => [],
    startResearch: async () => "c1",
    settle: async () => "done",
    saveNote: async () => "n.md",
    addTask: async () => "t1",
    ...over,
  });
  const record = async (opts: { incognito?: boolean } = {}) => {
    const file = join(base, "rec.m4a");
    await writeFile(file, Buffer.alloc(2000));
    const s = await ideas.start({ file, seconds: 60, lang: "he", ...opts });
    await wait(async () => (await ideas.get(s.id)).status === "done");
    return s.id;
  };
  return { base, calls, audio, ideas, record };
}
const done = async (ideas: Ideas, id: string): Promise<IdeaSession> => {
  await wait(async () => (await ideas.get(id)).status === "done");
  return ideas.get(id);
};

test("the recording is kept after reading, and shows on the session with its end date", async () => {
  const { base, ideas, record } = await setup();
  const id = await record();
  const s = await ideas.get(id);
  assert.equal(s.recording?.bytes, 2000);
  assert.ok(s.recording?.until);
  await rm(base, { recursive: true, force: true });
});

test("'don't keep' and incognito sessions never keep the audio", async () => {
  const off = await setup("off");
  assert.equal((await off.ideas.get(await off.record())).recording, undefined);
  const inc = await setup("days");
  const id = await inc.record({ incognito: true });
  assert.equal((await inc.ideas.get(id)).recording, undefined);
  assert.equal((await inc.ideas.get(id)).incognito, true);
  await assert.rejects(inc.ideas.retranscribe(id, "he"), /no longer on this computer/);
  await rm(off.base, { recursive: true, force: true });
  await rm(inc.base, { recursive: true, force: true });
});

test("transcribe again replaces the transcript, runs the analysis again and keeps edited ideas", async () => {
  const { base, calls, ideas, record } = await setup();
  const id = await record();
  const first = await ideas.get(id);
  assert.match(first.transcript ?? "", /Hola/);
  assert.equal(first.language, "es");
  // She edits the one idea (it is now hers) and the new analysis finds a different one.
  const edited = await ideas.edit(id, first.ideas[0]!.id, { title: "Mi tema" });
  assert.equal(isKept(edited.ideas[0]!), true);
  const started = await ideas.retranscribe(id, "he");
  assert.equal(started.status, "transcribing");
  assert.equal(started.progress?.stage, "transcribing");
  const s = await done(ideas, id);
  assert.deepEqual(calls.at(-1), { language: "he" });
  assert.match(s.transcript ?? "", /בישול/);
  assert.equal(s.language, "he");
  assert.deepEqual(s.ideas.map((i) => i.title), ["Mi tema", "בישול"]);
  // The audio stays for another try.
  assert.ok(s.recording);
  await rm(base, { recursive: true, force: true });
});

test("ideas she did not touch are replaced, and the same title is not added twice", async () => {
  const { base, ideas, record } = await setup("days", { ask: async (system) => (system.includes("thinking aloud") ? JSON.stringify([idea("בישול")]) : "[]") });
  const id = await record();
  const first = await ideas.get(id);
  await ideas.toTask(id, first.ideas[0]!.id);
  await ideas.retranscribe(id, "auto");
  const s = await done(ideas, id);
  assert.equal(s.ideas.length, 1);
  assert.ok(s.ideas[0]!.task);
  await rm(base, { recursive: true, force: true });
});

test("a failed transcribe again puts the earlier transcript and ideas back", async () => {
  let fail = false;
  const { base, ideas, record } = await setup("days", {
    transcribe: async (_f, _l, language) => {
      if (fail) throw new Error("whisper stopped");
      return language ? { text: "x" } : { text: "Hello world this is an idea about cooking", language: "en" };
    },
    ask: async (system) => (system.includes("thinking aloud") ? JSON.stringify([idea("cooking")]) : "[]"),
  });
  const id = await record();
  fail = true;
  await ideas.retranscribe(id, "he");
  await wait(async () => !!(await ideas.get(id)).redoError);
  const s = await ideas.get(id);
  assert.equal(s.status, "done");
  assert.match(s.transcript ?? "", /Hello world/);
  assert.equal(s.ideas.length, 1);
  assert.ok(s.redoError);
  assert.ok(s.recording);
  await rm(base, { recursive: true, force: true });
});

test("a bad language, a busy session and a missing recording are refused", async () => {
  const { base, ideas, record } = await setup();
  const id = await record();
  await assert.rejects(ideas.retranscribe(id, "../x"), /Unknown language/);
  await ideas.removeRecording(id);
  await assert.rejects(ideas.retranscribe(id, "he"), /no longer on this computer/);
  const text = await ideas.start({ text: "just typed words about nothing special at all here" });
  await assert.rejects(ideas.retranscribe(text.id, "he"));
  await done(ideas, text.id);
  await rm(base, { recursive: true, force: true });
});

test("delete recording keeps the transcript; deleting the session deletes the recording", async () => {
  const { base, audio, ideas, record } = await setup();
  const id = await record();
  const s = await ideas.removeRecording(id);
  assert.equal(s.recording, undefined);
  assert.ok(s.transcript);
  const again = await record();
  assert.ok(await audio.find(again));
  await ideas.remove(again);
  assert.equal(await audio.find(again), undefined);
  await rm(base, { recursive: true, force: true });
});

test("cleanupAudio applies the policy to sessions that exist", async () => {
  const { base, audio, ideas, record } = await setup("off");
  const id = await record();
  assert.equal(existsSync(join(base, "kept")), false);
  await audio.adopt(id, await (async () => { const f = join(base, "late.m4a"); await writeFile(f, "x"); return f; })());
  await ideas.cleanupAudio();
  assert.equal(await audio.find(id), undefined);
  await rm(base, { recursive: true, force: true });
});
