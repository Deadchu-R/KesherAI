import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeaAudio, audioUntil, type AudioPolicy } from "./ideas-audio.js";

const DAY = 86_400_000;
const GB = 1024 ** 3;
const policy = (over: Partial<AudioPolicy> = {}): AudioPolicy => ({ mode: "days", days: 30, capBytes: 5 * GB, ...over });

/** A store with recordings of the given ages (days) and sizes (bytes), made "now". */
async function store(items: Array<{ id: string; ageDays: number; bytes?: number }>) {
  const base = await mkdtemp(join(tmpdir(), "kesher-ideas-audio-"));
  const now = Date.now();
  const audio = new IdeaAudio(join(base, "kept"), () => now);
  for (const i of items) {
    const src = join(base, `${i.id}.m4a`);
    await writeFile(src, Buffer.alloc(i.bytes ?? 10));
    const to = await audio.adopt(i.id, src);
    const t = new Date(now - i.ageDays * DAY);
    await utimes(to, t, t);
  }
  return { audio, base, all: new Set(items.map((i) => i.id)) };
}

test("adopt moves the file into the store and find, remove work on it", async () => {
  const { audio, base } = await store([{ id: "a", ageDays: 0, bytes: 42 }]);
  const kept = await audio.find("a");
  assert.equal(kept?.bytes, 42);
  assert.deepEqual(await readdir(base), ["kept"]);
  await audio.remove("a");
  assert.equal(await audio.find("a"), undefined);
  await audio.remove("a");
  await rm(base, { recursive: true, force: true });
});

test("a session id with path parts is refused", async () => {
  const { audio, base } = await store([]);
  await assert.rejects(audio.adopt("../x", join(base, "none.m4a")));
  assert.equal(await audio.find("../x"), undefined);
  await rm(base, { recursive: true, force: true });
});

test("days: recordings older than the limit are deleted, newer stay", async () => {
  const { audio, base, all } = await store([{ id: "old", ageDays: 31 }, { id: "new", ageDays: 5 }]);
  assert.deepEqual(await audio.cleanup(policy(), all), ["old"]);
  assert.ok(await audio.find("new"));
  assert.equal(await audio.find("old"), undefined);
  await rm(base, { recursive: true, force: true });
});

test("forever keeps old recordings; off deletes every one", async () => {
  const { audio, base, all } = await store([{ id: "old", ageDays: 400 }, { id: "new", ageDays: 0 }]);
  assert.deepEqual(await audio.cleanup(policy({ mode: "forever" }), all), []);
  assert.deepEqual((await audio.cleanup(policy({ mode: "off" }), all)).sort(), ["new", "old"]);
  await rm(base, { recursive: true, force: true });
});

test("over the size cap the oldest go first, until the total fits", async () => {
  const { audio, base, all } = await store([{ id: "a", ageDays: 3, bytes: 400 }, { id: "b", ageDays: 2, bytes: 400 }, { id: "c", ageDays: 1, bytes: 400 }]);
  assert.deepEqual(await audio.cleanup(policy({ capBytes: 800 }), all), ["a"]);
  assert.deepEqual(await audio.cleanup(policy({ capBytes: 500 }), all), ["b"]);
  assert.ok(await audio.find("c"));
  await rm(base, { recursive: true, force: true });
});

test("a recording whose session is gone is deleted", async () => {
  const { audio, base } = await store([{ id: "kept", ageDays: 0 }, { id: "orphan", ageDays: 0 }]);
  assert.deepEqual(await audio.cleanup(policy(), new Set(["kept"])), ["orphan"]);
  await rm(base, { recursive: true, force: true });
});

test("audioUntil is the keep time plus the days, and nothing for forever", () => {
  assert.equal(audioUntil(policy({ days: 7 }), 1000), 1000 + 7 * DAY);
  assert.equal(audioUntil(policy({ mode: "forever" }), 1000), undefined);
});
