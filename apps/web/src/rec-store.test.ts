import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIVE_MS, elapsedMs, groupParts, isInterrupted, joinWavs, memoryBackend, RecStore } from "./rec-store";

/** A store on a clock the test moves. */
const setup = () => {
  let now = 1_000_000;
  const store = new RecStore(memoryBackend(), () => now);
  return { store, tick: (ms: number) => (now += ms), now: () => now };
};

const text = async (b: Blob) => await b.text();

test("chunks come back joined per part, in order", async () => {
  const { store } = setup();
  const s = await store.begin("ideas", "audio/webm");
  await store.addChunk(s.id, 0, 1, new Blob(["b"]));
  await store.addChunk(s.id, 0, 0, new Blob(["a"]));
  await store.addChunk(s.id, 1, 0, new Blob(["c"]));
  const parts = await store.parts(s.id);
  assert.equal(parts.length, 2);
  assert.equal(await text(parts[0]!), "ab");
  assert.equal(await text(parts[1]!), "c");
  assert.equal(parts[0]!.type, "audio/webm");
});

test("groupParts leaves out empty parts", () => {
  const parts = groupParts([{ session: "x", part: 2, seq: 0, blob: new Blob([]) }, { session: "x", part: 0, seq: 0, blob: new Blob(["z"]) }], "audio/ogg");
  assert.equal(parts.length, 1);
});

test("the clock counts while recording and stops while paused", async () => {
  const { store, tick, now } = setup();
  let s = await store.begin("study", "audio/webm");
  tick(10_000);
  s = await store.pause(s.id, true);
  assert.equal(s.recordedMs, 10_000);
  tick(60_000);
  assert.equal(elapsedMs(s, now()), 10_000);
  s = await store.pause(s.id, false);
  tick(5_000);
  assert.equal(elapsedMs(s, now()), 15_000);
});

test("a session whose page went quiet is interrupted and resumes into the same session with a gap", async () => {
  const { store, tick } = setup();
  const s = await store.begin("ideas", "audio/webm");
  tick(4_000);
  await store.touch(s.id); // the last heartbeat: 4 s recorded
  assert.equal(await store.unfinished("ideas"), undefined, "still alive");
  tick(ALIVE_MS + 1_000);
  const found = await store.unfinished("ideas");
  assert.equal(found?.id, s.id);
  assert.equal(await store.unfinished("study"), undefined, "other pages do not see it");
  const { session, part } = await store.resume(s.id);
  assert.equal(part, 1);
  assert.equal(session.recordedMs, 4_000);
  assert.equal(session.state, "recording");
  assert.equal(session.gaps.length, 1);
  assert.equal(session.gaps[0]!.at, 4_000);
  assert.equal(session.gaps[0]!.ms, ALIVE_MS + 1_000);
  assert.equal(isInterrupted(session, session.updatedAt), false);
});

test("a stopped session stays until removed (so a failed send can be tried again)", async () => {
  const { store, tick } = setup();
  const s = await store.begin("ideas", "audio/webm");
  await store.addChunk(s.id, 0, 0, new Blob(["x"]));
  tick(2_000);
  const ended = await store.stop(s.id);
  assert.equal(ended.recordedMs, 2_000);
  assert.equal((await store.unfinished("ideas"))?.id, s.id);
  await store.remove(s.id);
  assert.equal(await store.unfinished("ideas"), undefined);
  await assert.rejects(store.parts(s.id));
});

test("meta is kept with the session", async () => {
  const { store } = setup();
  const s = await store.begin("study", "", true);
  await store.setMeta(s.id, { lines: ["[00:00] hello"] });
  assert.deepEqual((await store.get(s.id))?.meta, { lines: ["[00:00] hello"] });
  assert.equal((await store.get(s.id))?.native, true);
});

/** A WAV file with these 16-bit samples. */
const wav = (samples: number[]): Uint8Array => {
  const out = new Uint8Array(44 + samples.length * 2);
  out.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  out.set([..."WAVEfmt "].map((c) => c.charCodeAt(0)), 8);
  out.set([..."data"].map((c) => c.charCodeAt(0)), 36);
  const v = new DataView(out.buffer);
  v.setUint32(4, 36 + samples.length * 2, true);
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, x, true));
  return out;
};

test("joinWavs joins the sound and fixes the lengths", () => {
  const j = joinWavs([wav([1, 2]), new Uint8Array([1, 2, 3]), wav([3])]);
  const v = new DataView(j.buffer);
  assert.equal(j.length, 44 + 6);
  assert.equal(v.getUint32(40, true), 6);
  assert.equal(v.getUint32(4, true), 42);
  assert.deepEqual([0, 1, 2].map((i) => v.getInt16(44 + i * 2, true)), [1, 2, 3]);
  assert.equal(joinWavs([]).length, 0);
});
