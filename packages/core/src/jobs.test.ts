import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./jobs.js";

test("a job runs detached, its output and exit code are read back, and it is found again by key", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-jobs-"));
  const jobs = new JobStore(dir);
  const rec = await jobs.start("build:x", "sh", ["-c", "echo hello; exit 3"]);
  const s = await jobs.wait(rec, { timeoutMs: 10_000 });
  assert.equal(s.state, "done");
  assert.equal(s.code, 3);
  assert.match(s.output, /hello/);
  // A new store (KesherAI restarted) finds the same job.
  const again = await new JobStore(dir).find("build:x");
  assert.equal(again?.id, rec.id);
  assert.equal(again?.code, 3);
});

test("a running job is reported as running, and stop ends it", { skip: process.platform === "win32" }, async () => {
  const jobs = new JobStore(await mkdtemp(join(tmpdir(), "kesher-jobs-")));
  const rec = await jobs.start("long", "sleep", ["30"]);
  assert.equal((await jobs.state(rec)).state, "running");
  assert.equal((await jobs.running()).length, 1);
  jobs.stop(rec);
  const s = await jobs.wait(rec, { timeoutMs: 5000 });
  assert.notEqual(s.state, "running");
});
