import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredRecord } from "../../../packages/shared/src/drive-sync.js";
import type { SyncBody, SyncKind } from "../../../packages/shared/src/hub-sync.js";
import type { PageTask } from "../page/device.js";
import { agentSnapshots, deviceLabel, hubInboxId, mergeTasks, pageTaskBody, parseAppToken } from "../page/drive-view.js";

const ctx = { me: "page-mine1234", pcNames: ["Office PC"], deviceName: (id: string) => (id === "dev-pc" ? "Office PC" : undefined) };

const rec = (kind: SyncKind, id: string, writer: string, body: SyncBody | null, deleted = false): StoredRecord => ({ head: { id, kind, rev: 1, writer, ...(deleted ? { deleted: true } : {}) }, body });

const local = (taskId: string, over: Partial<PageTask> = {}): PageTask => ({
  taskId,
  title: `task ${taskId}`,
  spec: "do it",
  executor: "pc-antigravity",
  ifOffline: "wait",
  route: "pc",
  to: "dev-pc",
  toName: "Office PC",
  createdAt: 1_000,
  status: "sent",
  history: [],
  ...over,
});

test("hubInboxId matches the PC's slug of a relayed task id", () => {
  assert.equal(hubInboxId("AbC_dE-fg12"), "h-abc-de-fg12");
  assert.equal(hubInboxId("__"), "h-task");
});

test("deviceLabel names this device, a single PC by name, and other kinds", () => {
  assert.equal(deviceLabel("page-mine1234", ctx).en, "This device");
  assert.equal(deviceLabel("pc-xyz", ctx).en, "Office PC");
  assert.equal(deviceLabel("pc-xyz", { me: "", pcNames: ["a", "b"] }).en, "PC");
  assert.equal(deviceLabel("page-other", ctx).en, "Hub page");
});

test("mergeTasks shows Drive tasks of other devices with their run, newest first", () => {
  const rows = mergeTasks(
    [local("pageTask0001", { createdAt: 5_000 })],
    [
      rec("task", "pcTask00001", "pc-xyz", { type: "task", title: "From the PC", spec: "", origin: "inbox-claude", executor: "local", target: "pc-xyz", createdAt: new Date(9_000).toISOString() }),
      rec("run", "pcTask00001", "pc-xyz", { type: "run", state: "done", result: "All good", branch: "local/x" }),
      rec("task", "goneTask0001", "pc-xyz", null, true),
    ],
    ctx,
  );
  assert.deepEqual(rows.map((r) => r.taskId), ["pcTask00001", "pageTask0001"]);
  const pc = rows[0]!;
  assert.equal(pc.status, "done");
  assert.equal(pc.line, "All good");
  assert.equal(pc.route, "pc");
  assert.equal(pc.executor, "pc-local");
  assert.equal(pc.toName, "Office PC");
  assert.equal(pc.drive?.only, true);
  assert.equal(pc.drive?.device.en, "Office PC");
  assert.equal(rows[1]!.drive, undefined, "a local task not yet in Drive has no mark");
});

test("mergeTasks keeps one row for a task known locally and in Drive, and folds the PC's inbox copy into it", () => {
  const rows = mergeTasks(
    [local("Relay_Task01")],
    [
      rec("task", "Relay_Task01", ctx.me, { type: "task", title: "x", spec: "", origin: "page", executor: "pc-antigravity", target: "hub:dev-pc", createdAt: "" }),
      rec("task", "h-relay-task01", "pc-xyz", { type: "task", title: "x", spec: "", origin: "page", executor: "antigravity", target: "pc-xyz", createdAt: "" }),
      rec("run", "h-relay-task01", "pc-xyz", { type: "run", state: "waiting-run" }),
    ],
    ctx,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "waiting-run");
  assert.equal(rows[0]!.drive?.only, false);
  assert.equal(rows[0]!.drive?.device.en, "This device");
});

test("mergeTasks leaves out archived tasks and names a page task's hub target", () => {
  const rows = mergeTasks(
    [],
    [
      rec("task", "otherPage001", "page-other", { type: "task", title: "y", spec: "", origin: "page", executor: "pc-any", target: "hub:dev-pc", createdAt: "" }),
      rec("task", "archived0001", "pc-xyz", { type: "task", title: "z", spec: "", origin: "pc", executor: "local", createdAt: "" }),
      rec("meta", "archived0001", "page-other", { type: "meta", archived: true }),
    ],
    ctx,
  );
  assert.deepEqual(rows.map((r) => [r.taskId, r.toName, r.status]), [["otherPage001", "Office PC", "waiting"]]);
});

test("pageTaskBody writes only this page's own tasks, targeted so no PC queues them from Drive", () => {
  const body = pageTaskBody(local("pageTask0001", { to: "dev-pc" }));
  assert.equal(body?.origin, "page");
  assert.equal(body?.target, "hub:dev-pc");
  assert.equal(pageTaskBody(local("pageTask0001", { to: "hub", route: "claude-cloud" }))?.target, "hub:hub");
  assert.equal(pageTaskBody(local("inboxTask01", { inbox: { from: "claude", executor: "local", deviceId: "dev-pc", at: 1 } })), undefined);
  assert.equal(pageTaskBody(local("short")), undefined, "an id Drive records cannot hold");
  assert.equal(pageTaskBody(local("pageTask0002", { drive: { device: { he: "", en: "" }, writer: "pc-x", origin: "pc", only: true } })), undefined);
});

test("agentSnapshots lists the newest snapshots first", () => {
  const snaps = agentSnapshots(
    [
      rec("agent", "run-old-0001", "pc-xyz", { type: "agent", title: "old", source: "inbox", state: "done", endedAt: new Date(1_000).toISOString() }),
      rec("agent", "run-new-0001", "pc-xyz", { type: "agent", title: "new", source: "chat-helper", state: "failed", endedAt: new Date(2_000).toISOString() }),
      rec("task", "task-000001", "pc-xyz", { type: "task", title: "t", spec: "", origin: "pc", executor: "local", createdAt: "" }),
    ],
    ctx,
  );
  assert.deepEqual(snaps.map((s) => s.body.title), ["new", "old"]);
  assert.equal(snaps[0]!.device.en, "Office PC");
});

test("parseAppToken takes only a well-formed token with a sane lifetime", () => {
  const ok = parseAppToken("#kdt=ya29.a0AfB_byC-1234567890abcdef&kde=3599", 1_000);
  assert.deepEqual(ok, { token: "ya29.a0AfB_byC-1234567890abcdef", expiresAt: 1_000 + 3_599_000 });
  assert.equal(parseAppToken("#tasks", 0), undefined);
  assert.equal(parseAppToken("#kdt=short&kde=3599", 0), undefined);
  assert.equal(parseAppToken("#kdt=ya29.a0AfB_byC-1234567890abcdef&kde=999999", 0), undefined);
  assert.equal(parseAppToken("#kdt=ya29.a0AfB_byC<script>567890abcdef&kde=3599", 0), undefined);
});
