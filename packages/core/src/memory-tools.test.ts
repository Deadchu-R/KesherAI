import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryTools } from "./memory-tools.js";
import { MemoryStore, parseFiling, refusal, worthFiling } from "./memory-store.js";

const ctx = { signal: new AbortController().signal } as never;

test("memory tools: remember files under a topic once, refuses secrets; forget removes; none in incognito", async () => {
  const m = new MemoryStore(join(await mkdtemp(join(tmpdir(), "kesher-mem-")), "memory.json"));
  const [remember, forget] = memoryTools(m, () => ({ projectId: "p1" }));
  await remember!.run({ note: "Makes games in Unreal", topic: "Work" }, ctx);
  await remember!.run({ note: "makes games in unreal", topic: "work" }, ctx);
  await remember!.run({ note: "Uses UE 5.6 here", topic: "Engine", project: true }, ctx);
  const d = await m.data();
  assert.deepEqual(d.topics.map((t) => [t.title, t.project ?? "", t.facts.map((f) => f.text)]), [["Work", "", ["makes games in unreal"]], ["Engine", "p1", ["Uses UE 5.6 here"]]]);
  await assert.rejects(remember!.run({ note: "my password is hunter2" }, ctx), /passwords/);
  await assert.rejects(remember!.run({ note: "card 4580 1234 5678 9012" }, ctx), /card/);
  assert.match((await forget!.run({ about: "unreal" }, ctx)).output, /Forgot 1/);
  assert.equal(memoryTools(m, () => ({ projectId: null, incognito: true })).length, 0);
});

test("memory prompt: general and this project's topics; another project's never; isolation and pause", async () => {
  const m = new MemoryStore(join(await mkdtemp(join(tmpdir(), "kesher-mem-")), "memory.json"));
  await m.add({ topic: "About you", text: "Lives in Israel", source: "you" });
  await m.add({ topic: "Game", text: "AutoShooter uses GAS", source: "auto", project: "a" });
  await m.add({ topic: "Site", text: "Portfolio on GitHub Pages", source: "auto", project: "b" });
  const inA = await m.promptFor("a");
  assert.match(inA, /Lives in Israel/);
  assert.match(inA, /AutoShooter/);
  assert.doesNotMatch(inA, /Portfolio/);
  await m.settings({ isolate: { project: "a", on: true } });
  assert.doesNotMatch(await m.promptFor("a"), /Israel/, "an isolated project reads only its own memory");
  assert.match(await m.promptFor(null), /Israel/);
  await m.settings({ paused: true });
  assert.equal(await m.promptFor(null), "");
  await m.reset();
  assert.equal((await m.data()).topics.length, 0);
});

test("filing helpers", () => {
  assert.deepEqual(parseFiling('```json\n{"add":[{"topic":"Work","fact":"Unreal developer at 3DVision"}],"forget":["old job"]}\n```'), { add: [{ topic: "Work", fact: "Unreal developer at 3DVision", project: false }], forget: ["old job"] });
  assert.deepEqual(parseFiling("nothing"), { add: [], forget: [] });
  assert.ok(worthFiling("I work at 3DVision as an Unreal dev"));
  assert.ok(worthFiling("אני עובד ב-3DVision כמפתח"));
  assert.ok(!worthFiling("fix the build"));
  assert.ok(refusal("my api key is abc"));
  assert.equal(refusal("Prefers dark mode"), undefined);
});
