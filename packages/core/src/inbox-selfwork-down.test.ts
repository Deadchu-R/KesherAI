import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPUS_WAIT_NOTE, TaskInbox, type RunCmd, type TaskInboxDeps } from "./inbox-runner.js";

/**
 * The task inbox while self-work is down (found on the PC, 28.11): tasks handed to the local model must not hold the
 * line forever, can be handed on to the next ready executor, and a task kept for Claude says so.
 */

const git: RunCmd = async () => ({ code: 0, out: "" });

function make(o: { coderReady?: boolean; down?: () => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kesher-swdown-"));
  const coder: TaskInboxDeps["coder"] | undefined = o.coderReady
    ? { ready: () => true, models: async () => ["opencode-go/mimo-v2.6-flash"], run: async () => ({ text: "" }) }
    : undefined;
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo: join(root, "repo"), branch: "kesher-inbox", dailyCap: 10 }),
    file: join(root, "inbox.json"),
    git,
    run: git,
    startAgent: () => Promise.reject(new Error("no agent in this test")),
    notify: () => undefined,
    busy: async () => ({ free: true, reasons: [] }),
    ...(coder ? { coder } : {}),
    ...(o.down ? { selfWorkDown: o.down } : {}),
  });
  return { inbox, root };
}

/** Puts a hub task on the local model's board, as a hand-over does (the board item open for self-work). */
async function queueLocal(inbox: TaskInbox, id: string) {
  await inbox.fromHub({ taskId: id, title: `Task ${id}`, spec: "Fix the gap" }, "t1");
  const t = await inbox.reassign(`h-${id.toLowerCase()}`, "local");
  (t as { boardState?: string }).boardState = "open";
  const saved = (inbox as unknown as { saved: { tasks: Array<{ id: string; boardState?: string }> } }).saved;
  saved.tasks.find((x) => x.id === t.id)!.boardState = "open";
  return t.id;
}

const slotFree = (inbox: TaskInbox) => (inbox as unknown as { slotFree: (ex: string) => boolean }).slotFree("local");

test("slotFree: open board items hold the local line while self-work runs, never when it is down", async () => {
  let down = false;
  const { inbox, root } = make({ down: () => down });
  try {
    assert.equal(slotFree(inbox), true, "nothing queued");
    await queueLocal(inbox, "T-1");
    assert.equal(slotFree(inbox), false, "self-work runs: it takes the item");
    down = true;
    assert.equal(slotFree(inbox), true, "self-work is down: the line is not stuck");
    assert.equal(await inbox.localQueuedCount(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseLocalQueue: hands the waiting local tasks to the next ready executor, with a note; none ready, none moved", async () => {
  const none = make();
  try {
    await queueLocal(none.inbox, "T-2");
    assert.equal(await none.inbox.releaseLocalQueue("self-work failed"), 0, "no OpenCode or GhostCLI ready: the task stays");
    assert.equal((await none.inbox.list())[0]!.runBy, "local");
  } finally {
    rmSync(none.root, { recursive: true, force: true });
  }
  const ready = make({ coderReady: true });
  try {
    await queueLocal(ready.inbox, "T-3");
    assert.equal(await ready.inbox.releaseLocalQueue("self-work failed: model errors"), 1);
    const t = (await ready.inbox.list())[0]!;
    assert.deepEqual([t.runBy, t.status], ["opencode", "waiting"]);
    assert.match(t.note ?? "", /Handed on from/);
    assert.equal(await ready.inbox.localQueuedCount(), 0);
  } finally {
    rmSync(ready.root, { recursive: true, force: true });
  }
});

test("a task kept for Claude shows as waiting for Claude (never auto-runs)", async () => {
  const { inbox, root } = make();
  try {
    await inbox.fromHub({ taskId: "T-4", title: "Big one", spec: "Fix the gap" }, "t1");
    const t = await inbox.reassign("h-t-4", "opus");
    assert.deepEqual([t.runBy, t.status], ["opus", "queued"]);
    const listed = (await inbox.list())[0]!;
    assert.equal(listed.note, OPUS_WAIT_NOTE);
    assert.match(listed.note ?? "", /^Waiting for Claude/);
    assert.equal((await inbox.state(true)).tasks[0]!.note, OPUS_WAIT_NOTE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
