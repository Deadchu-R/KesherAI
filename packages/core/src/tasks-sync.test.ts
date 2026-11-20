import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveError, DriveSync, ensureAccountKey, type DriveChange, type DriveFileInfo, type DriveStore, type InboxTaskView, type SyncRunBody } from "@kesher/shared";
import { inboxIdFor, scrubText, syncIdFor, TasksSync } from "./tasks-sync.js";

/** An in-memory appDataFolder (the DriveStore interface, no REST). */
class MemDrive implements DriveStore {
  files = new Map<string, { name: string; content: string; at: number }>();
  log: DriveChange[] = [];
  calls = 0;
  failWith?: DriveError;
  private n = 1;

  private use(): void {
    this.calls++;
    if (this.failWith) throw this.failWith;
  }
  private info(id: string): DriveFileInfo {
    const f = this.files.get(id)!;
    return { id, name: f.name, createdAt: f.at };
  }
  async list(_t?: string, prefix = "") {
    this.use();
    return { files: [...this.files.keys()].filter((id) => this.files.get(id)!.name.startsWith(prefix)).map((id) => this.info(id)) };
  }
  async startToken() {
    this.use();
    return String(this.log.length);
  }
  async changes(token: string) {
    this.use();
    return { changes: this.log.slice(Number(token)), newStartPageToken: String(this.log.length) };
  }
  async newIds(count: number) {
    this.use();
    return Array.from({ length: count }, () => `id${this.n++}`);
  }
  async create(name: string, content: string, id?: string) {
    this.use();
    const fid = id ?? `id${this.n++}`;
    if (!this.files.has(fid)) {
      this.files.set(fid, { name, content, at: Date.parse("2026-11-20T10:00:00Z") });
      this.log.push({ fileId: fid, removed: false, file: this.info(fid) });
    }
    return this.info(fid);
  }
  async read(id: string) {
    this.use();
    const f = this.files.get(id);
    if (!f) throw new DriveError(404, "notFound");
    return f.content;
  }
  async delete(id: string) {
    this.use();
    this.files.delete(id);
    this.log.push({ fileId: id, removed: true });
  }
  names(kind: string): string[] {
    return [...this.files.values()].map((f) => f.name).filter((n) => n.split(".")[1] === kind);
  }
}

function task(id: string, over: Partial<InboxTaskView> = {}): InboxTaskView {
  return { id, title: "Fix the gap", executor: "antigravity", risk: "medium", from: "claude", base: "origin/main", allowedPaths: [], forbiddenPaths: [], check: "", maxMinutes: 15, maxFiles: 15, goal: "Open /home/someone/kesher/a.ts", status: "waiting", runBy: "antigravity", branch: `agy/${id}-fix`, ...over };
}

async function setup(opts: { enabled?: boolean; scope?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kesher-tasks-sync-"));
  const drive = new MemDrive();
  const tasks: InboxTaskView[] = [];
  const received: { id: string; title: string; goal: string; executor: string }[] = [];
  const settings = { enabled: opts.enabled ?? true };
  const google = { connected: true, scope: opts.scope ?? true, has: () => google.scope, accessToken: async () => "tok" };
  const inbox = {
    list: async () => tasks.map((t) => ({ ...t })),
    fromDrive: async (t: (typeof received)[number]) => {
      received.push(t);
      tasks.push(task(t.id, { title: t.title, goal: t.goal, from: "roee" }));
      return true;
    },
    onChange: () => () => undefined,
  };
  const file = join(dir, "tasks-sync.json");
  const sync = new TasksSync({ settings: () => settings, setEnabled: async (on) => void (settings.enabled = on), google, inbox, file, drive: () => drive, home: "/home/someone" });
  return { dir, drive, tasks, received, settings, google, sync, file, done: () => rm(dir, { recursive: true, force: true }) };
}

test("tasks sync: off by default does not touch Drive", async () => {
  const t = await setup({ enabled: false });
  t.tasks.push(task("c-20261120-01"));
  const s = await t.sync.syncNow();
  assert.equal(s.enabled, false);
  assert.equal(t.drive.calls, 0);
  await t.done();
});

test("tasks sync: writes each inbox task once and its run only when it changes", async () => {
  const t = await setup();
  t.tasks.push(task("c-20261120-01"));
  let s = await t.sync.syncNow();
  assert.equal(s.lastError, null);
  assert.ok(s.lastSync);
  assert.equal(t.drive.names("task").length, 1);
  assert.equal(t.drive.names("run").length, 1);
  assert.equal(s.counts.tasks, 1);
  await t.sync.syncNow();
  assert.equal(t.drive.names("task").length, 1, "the task is not written again");
  assert.equal(t.drive.names("run").length, 1, "an unchanged run is not written again");
  t.tasks[0]!.status = "done";
  t.tasks[0]!.summary = "Done in /home/someone/kesher";
  t.tasks[0]!.endedAt = Date.parse("2026-11-20T11:00:00Z");
  s = await t.sync.syncNow();
  assert.equal(t.drive.names("run").length, 2);
  assert.equal(s.counts.pending, 0);
  // The private state is in the data folder, owner-only, and the sealed files hold no plain text.
  const saved = JSON.parse(await readFile(t.file, "utf8")) as { writer: string };
  assert.match(saved.writer, /^pc-/);
  if (process.platform !== "win32") assert.equal((await stat(t.file)).mode & 0o077, 0);
  assert.ok(![...t.drive.files.values()].some((f) => f.content.includes("Fix the gap")));
  await t.done();
});

test("tasks sync: a phone's task comes into the inbox once, and the PC writes its run", async () => {
  const t = await setup();
  const keys = await ensureAccountKey(t.drive);
  const phone = await DriveSync.create({ drive: t.drive, writer: "phone-1", keys });
  const { head } = await phone.write("task", undefined, { type: "task", title: "From the phone", spec: "Add a button", origin: "phone", executor: "antigravity", createdAt: "2026-11-20T10:00:00Z" });
  await t.sync.syncNow();
  assert.deepEqual(t.received, [{ id: inboxIdFor(head.id), title: "From the phone", goal: "Add a button", executor: "antigravity" }]);
  await t.sync.syncNow();
  assert.equal(t.received.length, 1, "queued once");
  assert.equal(t.drive.names("task").length, 1, "the PC does not write the phone's task again");
  await phone.pull();
  const run = phone.records().find((r) => r.head.kind === "run" && r.head.id === head.id);
  assert.equal((run?.body as SyncRunBody).state, "waiting-run");
  await t.done();
});

test("tasks sync: a task meant for another device, or already finished, stays out", async () => {
  const t = await setup();
  const keys = await ensureAccountKey(t.drive);
  const phone = await DriveSync.create({ drive: t.drive, writer: "phone-1", keys });
  await phone.write("task", undefined, { type: "task", title: "For the laptop", spec: "x", origin: "phone", executor: "local", target: "pc-other", createdAt: "2026-11-20T10:00:00Z" });
  const { head } = await phone.write("task", undefined, { type: "task", title: "Old", spec: "y", origin: "page", executor: "local", createdAt: "2026-11-20T10:00:00Z" });
  await phone.write("run", head.id, { type: "run", state: "cancelled" });
  await t.sync.syncNow();
  assert.equal(t.received.length, 0);
  await t.done();
});

test("tasks sync: a missing permission or a refused token asks to reconnect", async () => {
  const t = await setup({ scope: false });
  let s = await t.sync.syncNow();
  assert.equal(s.needsReconnect, true);
  assert.equal(t.drive.calls, 0);
  t.google.scope = true;
  t.drive.failWith = new DriveError(401, "authError");
  s = await t.sync.syncNow();
  assert.equal(s.needsReconnect, true);
  assert.match(s.lastError ?? "", /401/);
  t.drive.failWith = undefined;
  s = await t.sync.syncNow();
  assert.equal(s.needsReconnect, false);
  assert.equal(s.lastError, null);
  await t.done();
});

test("tasks sync: ids and scrubbing", () => {
  assert.equal(syncIdFor("c-20261120-01"), "c-20261120-01");
  assert.match(syncIdFor("ab"), /^i-[0-9a-f]{20}$/);
  assert.match(inboxIdFor("AbC_123-xyz"), /^g-[0-9a-f]{16}$/);
  assert.equal(scrubText("see /home/someone/x and C:\\Users\\Someone\\y and /Users/bob/z", "/home/someone"), "see ~/x and C:\\Users\\~\\y and /Users/~/z");
});
