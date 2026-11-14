import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatTimers, parseWhen, TIMERS_PER_CHAT, timerTools } from "./chat-timers.js";

const T0 = Date.parse("2026-11-15T01:00:00Z");

test("parseWhen reads 'in' and 'at', and refuses the past, too soon and too far", () => {
  assert.equal(parseWhen({ in: "45m" }, T0), T0 + 45 * 60_000);
  assert.equal(parseWhen({ in: "in 2 hours" }, T0), T0 + 2 * 3_600_000);
  assert.equal(parseWhen({ in: "1d" }, T0), T0 + 86_400_000);
  assert.equal(parseWhen({ in: "90 seconds" }, T0), T0 + 90_000);
  assert.equal(parseWhen({ at: "2026-11-15T09:00:00Z" }, T0), Date.parse("2026-11-15T09:00:00Z"));
  assert.match(String(parseWhen({ in: "5s" }, T0)), /30 seconds/);
  assert.match(String(parseWhen({ in: "40d" }, T0)), /30 days/);
  assert.match(String(parseWhen({ at: "2020-01-01T00:00:00Z" }, T0)), /30 seconds/);
  assert.match(String(parseWhen({ in: "soon" }, T0)), /number and a unit/);
  assert.match(String(parseWhen({}, T0)), /Give "in"/);
});

test("a due timer goes into its chat once, is kept on disk, and a cancelled one never fires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-timers-"));
  let now = T0;
  const sent: Array<[string, string]> = [];
  const timers = new ChatTimers(join(dir, "timers.json"), { send: async (c, t) => void sent.push([c, t]), exists: async (c) => c !== "gone" }, () => now);
  const a = await timers.add("c1", "Check the build", T0 + 60_000);
  const b = await timers.add("c1", "Never", T0 + 120_000);
  await timers.add("gone", "Deleted chat", T0 + 60_000);
  assert.ok(typeof a !== "string" && typeof b !== "string");
  assert.equal(JSON.parse(await readFile(join(dir, "timers.json"), "utf8")).length, 3);
  assert.ok(await timers.cancel(b.id));
  assert.equal(await timers.cancel(b.id), false);
  now = T0 + 61_000;
  await timers.tick();
  await timers.tick();
  assert.deepEqual(sent, [["c1", "⏰ Timer: Check the build"]]);
  assert.equal(timers.list().length, 0);
});

test("a timer that came due while KesherAI was closed says it is late", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-timers-"));
  let now = T0;
  const sent: string[] = [];
  const timers = new ChatTimers(join(dir, "timers.json"), { send: async (_c, t) => void sent.push(t), exists: async () => true }, () => now);
  await timers.add("c1", "Look again", T0 + 60_000);
  now = T0 + 3_600_000;
  await timers.tick();
  assert.match(sent[0]!, /late/);
});

test("at most 10 timers wait per chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-timers-"));
  const timers = new ChatTimers(join(dir, "timers.json"), { send: async () => undefined, exists: async () => true }, () => T0);
  for (let i = 0; i < TIMERS_PER_CHAT; i++) assert.notEqual(typeof (await timers.add("c1", `t${i}`, T0 + 60_000 + i)), "string");
  assert.match(String(await timers.add("c1", "one more", T0 + 99_000)), /already has 10/);
  assert.notEqual(typeof (await timers.add("c2", "another chat", T0 + 99_000)), "string");
});

test("notify_user: one a minute per chat, across turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-timers-"));
  let now = T0;
  const notes: string[] = [];
  const timers = new ChatTimers(join(dir, "timers.json"), { send: async () => undefined, exists: async () => true }, () => now);
  const tools = () => timerTools(timers, "chat-n", async (_t, b) => void notes.push(b), () => now);
  const notify = (t: ReturnType<typeof tools>) => t.find((x) => x.spec.name === "notify_user")!;
  const ctx = {} as Parameters<ReturnType<typeof tools>[0]["run"]>[1];
  await notify(tools()).run({ message: "Build finished" }, ctx);
  // A new turn makes the tools again: the limit still holds.
  await assert.rejects(notify(tools()).run({ message: "Again" }, ctx), /less than a minute/);
  now += 61_000;
  await notify(tools()).run({ message: "Again" }, ctx);
  assert.deepEqual(notes, ["Build finished", "Again"]);
  const set = tools().find((x) => x.spec.name === "set_timer")!;
  assert.match((await set.run({ in: "45m", prompt: "Check" }, ctx)).output, /in 45 minutes/);
  await assert.rejects(set.run({ in: "1s", prompt: "Check" }, ctx), /30 seconds/);
});
