import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumeBoard, chatKindForTool, isResumeItem, type ResumeItem } from "./resume-board.js";
import { chatResumeSource, engineSyncResumeSource, helperResumeSource, inboxResumeSource, selfWorkResumeSource } from "./resume-sources.js";

const at = "2026-11-21T10:00:00.000Z";

async function tempFile(): Promise<{ file: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-resume-"));
  return { file: join(dir, "resume.json"), done: () => rm(dir, { recursive: true, force: true }) };
}

test("chatKindForTool: media jobs, renders and plain chat work", () => {
  assert.equal(chatKindForTool("generate_image"), "media");
  assert.equal(chatKindForTool("comfy_run_flow"), "media");
  assert.equal(chatKindForTool("unreal_package"), "render");
  assert.equal(chatKindForTool("edit_file"), "chat");
  assert.equal(chatKindForTool(undefined), "chat");
});

test("isResumeItem refuses damaged items and outside links", () => {
  const good: ResumeItem = { id: "chat:c1", source: "chat", kind: "chat", title: "A chat", at, auto: false, ref: "c1", link: "#/c/c1" };
  assert.ok(isResumeItem(good));
  assert.ok(!isResumeItem({ ...good, kind: "rocket" }));
  assert.ok(!isResumeItem({ ...good, link: "https://example.com" }));
  assert.ok(!isResumeItem({ ...good, auto: "yes" }));
});

test("a chat in a picture job is saved on close, found after the start with its tool, and continues on Continue only", async () => {
  const { file, done } = await tempFile();
  try {
    // Before the close: c1 works inside generate_image.
    let interrupted: Array<{ id: string; at: string }> = [];
    const resumed: Array<[string, boolean]> = [];
    const deps = {
      working: () => ["c1"],
      runningTool: () => "generate_image",
      interrupted: async () => interrupted,
      resume: async (id: string, dismiss: boolean) => {
        resumed.push([id, dismiss]);
        interrupted = interrupted.filter((x) => x.id !== id);
        return true;
      },
      title: () => "Poster",
    };
    const before = new ResumeBoard(file);
    before.add("chat", chatResumeSource(deps));
    assert.equal(await before.save("update"), 1);
    // closeAll put it on the interrupted list; a new process starts.
    interrupted = [{ id: "c1", at }];
    const after = new ResumeBoard(file);
    after.add("chat", chatResumeSource({ ...deps, working: () => [], runningTool: () => undefined }));
    const { reason, items } = await after.list();
    assert.equal(reason, "update");
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, "media");
    assert.equal(items[0]!.detail, "generate_image");
    assert.equal(items[0]!.auto, false);
    assert.deepEqual(resumed, [], "nothing continues by itself");
    assert.ok(await after.act("chat:c1", "continue", { local: true }));
    assert.deepEqual(resumed, [["c1", false]]);
    assert.equal((await after.list()).items.length, 0);
    assert.equal(JSON.parse(await readFile(file, "utf8")).items.length, 0);
  } finally {
    await done();
  }
});

test("a chat continued from its own banner leaves the card", async () => {
  const { file, done } = await tempFile();
  try {
    let interrupted = [{ id: "c2", at }];
    const board = new ResumeBoard(file);
    board.add("chat", chatResumeSource({ working: () => [], runningTool: () => undefined, interrupted: async () => interrupted, resume: async () => true, title: () => undefined }));
    assert.equal((await board.list()).items.length, 1);
    interrupted = [];
    assert.equal((await board.list()).items.length, 0);
  } finally {
    await done();
  }
});

test("self-work's chat is not offered twice", async () => {
  const { file, done } = await tempFile();
  try {
    const board = new ResumeBoard(file);
    board.add("chat", chatResumeSource({ working: () => [], runningTool: () => undefined, interrupted: async () => [{ id: "sw", at }, { id: "c3", at }], resume: async () => true, title: () => undefined, skip: () => "sw" }));
    assert.deepEqual((await board.list()).items.map((i) => i.ref), ["c3"]);
  } finally {
    await done();
  }
});

test("helpers that went on by themselves show as going; Drop stops one", async () => {
  const { file, done } = await tempFile();
  try {
    const state = new Map([["h1", "running"]]);
    const board = new ResumeBoard(file);
    board.add("helper", helperResumeSource({ resumed: () => [{ id: "h1", chatId: "c1", title: "Compare" }], state: (id) => state.get(id), stop: (id) => { state.set(id, "stopped"); return true; } }));
    const { items } = await board.list();
    assert.equal(items[0]!.auto, true);
    await board.act("helper:h1", "drop", { local: false });
    assert.equal(state.get("h1"), "stopped");
  } finally {
    await done();
  }
});

test("an inbox run keeps its rule: Run on this computer, an approval ask from the phone", async () => {
  const { file, done } = await tempFile();
  try {
    const calls: string[] = [];
    const src = inboxResumeSource({ running: () => ({ id: "t1", title: "Task" }), status: async () => "failed", runHere: async (id) => calls.push(`run ${id}`), ask: async (id) => calls.push(`ask ${id}`) });
    const board = new ResumeBoard(file);
    board.add("inbox", src);
    await board.save("shutdown");
    await board.act("inbox:t1", "continue", { local: false });
    assert.deepEqual(calls, ["ask t1"]);
    await board.save("shutdown");
    await board.act("inbox:t1", "continue", { local: true });
    assert.deepEqual(calls, ["ask t1", "run t1"]);
  } finally {
    await done();
  }
});

test("self-work within its time goes on by itself; past it, it waits for Continue", async () => {
  const { file, done } = await tempFile();
  try {
    let status = "running";
    const resumed: number[] = [];
    const deps = { current: () => ({ status, goal: "Fix the board\nmore" }), resume: async () => resumed.push(1), stop: async () => (status = "stopped") };
    const a = new ResumeBoard(file);
    a.add("self-work", selfWorkResumeSource(deps));
    await a.save("restart");
    // After the start: past its time limit, load() marked it stopped.
    status = "stopped";
    const b = new ResumeBoard(file);
    b.add("self-work", selfWorkResumeSource(deps));
    const { items } = await b.list();
    assert.equal(items[0]!.title, "Fix the board");
    assert.equal(items[0]!.auto, false);
    await b.act("self-work:run", "continue", { local: true });
    assert.equal(resumed.length, 1);
  } finally {
    await done();
  }
});

test("an engine sync waits for Continue and Drop never throws the queued changes away", async () => {
  const { file, done } = await tempFile();
  try {
    const synced: string[] = [];
    const board = new ResumeBoard(file);
    board.add("engine-sync", engineSyncResumeSource({ running: async () => [{ engine: "unity", project: "D:/Games/Platformer" }], waiting: async () => 3, sync: async (e, p) => synced.push(`${e} ${p}`) }));
    await board.save("shutdown");
    const { items } = await board.list();
    assert.equal(items[0]!.title, "Platformer");
    assert.deepEqual(synced, []);
    await board.act(items[0]!.id, "continue", { local: true });
    assert.deepEqual(synced, ["unity D:/Games/Platformer"]);
  } finally {
    await done();
  }
});

test("a damaged record is an empty card, a slow source does not hold the close, a failed Continue keeps the item", async () => {
  const { file, done } = await tempFile();
  try {
    await writeFile(file, "{not json");
    const board = new ResumeBoard(file);
    board.add("slow", { snapshot: () => new Promise<ResumeItem[]>(() => undefined), continue: async () => undefined, drop: async () => undefined });
    board.add("inbox", inboxResumeSource({ running: () => ({ id: "t2", title: "T" }), status: async () => "failed", runHere: async () => { throw new Error("Another task is running."); }, ask: async () => undefined }));
    const t0 = Date.now();
    assert.equal(await board.save("shutdown"), 1);
    assert.ok(Date.now() - t0 < 4000);
    await assert.rejects(board.act("inbox:t2", "continue", { local: true }), /Another task/);
    assert.equal((await board.list()).items.length, 1);
    assert.equal(await board.dropWaiting(), 1);
    assert.equal((await board.list()).items.length, 0);
  } finally {
    await done();
  }
});
