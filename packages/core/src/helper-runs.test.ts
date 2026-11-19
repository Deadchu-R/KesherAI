import { test } from "node:test";
import assert from "node:assert/strict";
import { HelperRuns, REPORT_CHARS, type HelperJob } from "./helper-runs.js";

/** A job that ends when `release` is called (or stops with its signal). */
function job(over: Partial<HelperJob> = {}): HelperJob & { release: (text?: string) => void } {
  let release!: (text?: string) => void;
  const ended = new Promise<string>((r) => (release = (t = "done") => r(t)));
  return {
    chatId: "c1",
    kind: "lookup",
    title: "find it",
    background: false,
    maxSteps: 8,
    timeMs: 60_000,
    local: true,
    model: "Qwen3-4B",
    run: async (ctl) => {
      ctl.step("search: x");
      const text = await Promise.race([ended, new Promise<never>((_, no) => ctl.signal.addEventListener("abort", () => no(new Error("aborted"))))]);
      return { report: text };
    },
    release,
    ...over,
  };
}

test("the queue keeps the limit; the next one starts when one ends", async () => {
  const runs = new HelperRuns({ limit: () => 2 });
  const jobs = [job(), job(), job()];
  const ids = jobs.map((j) => runs.start(j).id);
  assert.deepEqual(runs.list("c1").map((r) => r.state), ["running", "running", "waiting"]);
  assert.match(runs.get(ids[2]!)!.waitReason ?? "", /up to 2 at once/);
  assert.equal(runs.get(ids[2]!)!.waitLimit, 2);
  jobs[0]!.release("found in a.ts");
  await runs.wait([ids[0]!]);
  await new Promise((r) => setImmediate(r));
  assert.equal(runs.get(ids[2]!)!.state, "running");
  assert.equal(runs.get(ids[0]!)!.report, "found in a.ts");
  assert.deepEqual(runs.get(ids[0]!)!.steps, ["search: x"]);
  jobs[1]!.release();
  jobs[2]!.release();
  await runs.wait(ids);
});

test("cloud and outside agents do not take the card's room", () => {
  const runs = new HelperRuns({ limit: () => 1 });
  runs.start(job());
  const cloud = runs.start(job({ local: false, cloud: true }));
  assert.equal(runs.get(cloud.id)!.state, "running");
});

test("stop: a running one ends as stopped, a waiting one leaves the queue, stopAll stops a chat's", async () => {
  const runs = new HelperRuns({ limit: () => 1 });
  const a = runs.start(job());
  const b = runs.start(job());
  const other = runs.start(job({ chatId: "c2", local: false }));
  assert.equal(runs.stop(b.id), true);
  assert.equal(runs.get(b.id)!.state, "stopped");
  assert.equal(runs.stopAll("c1"), 1);
  await runs.wait([a.id]);
  assert.equal(runs.get(a.id)!.state, "stopped");
  assert.equal(runs.get(other.id)!.state, "running", "another chat's keeps going");
  assert.equal(runs.stop(a.id), false, "already ended");
  runs.stop(other.id);
});

test("the time cap fails a run; a long report is cut and kept whole", async () => {
  const runs = new HelperRuns({ limit: () => 2 });
  const slow = runs.start(job({ timeMs: 20 }));
  const [r] = await runs.wait([slow.id]);
  assert.equal(r!.state, "failed");
  assert.match(r!.error ?? "", /longer than/);
  const long = job();
  const l = runs.start(long);
  long.release("x".repeat(REPORT_CHARS + 50));
  await runs.wait([l.id]);
  assert.equal(runs.get(l.id)!.cut, true);
  assert.equal(runs.get(l.id)!.full!.length, REPORT_CHARS + 50);
});

test("background hand-off: an ended background run is pending until handed over; ask waits for the answer", async () => {
  const runs = new HelperRuns({ limit: () => 2 });
  const ended: string[] = [];
  runs.on("end", (i: { id: string }) => ended.push(i.id));
  let asked: boolean | undefined;
  const j = job({ background: true, run: async (ctl) => ({ report: `files: ${(asked = await ctl.ask("cloud-files"))}` }) });
  const r = runs.start(j);
  await new Promise((res) => setImmediate(res));
  assert.equal(runs.get(r.id)!.state, "asking");
  assert.equal(runs.answer(r.id, true), true);
  await runs.wait([r.id]).then(() => undefined);
  assert.equal(asked, true);
  assert.deepEqual(ended, [r.id]);
  assert.equal(runs.pending(r.id), false, "wait handed it over");
  const k = job({ background: true });
  const r2 = runs.start(k);
  k.release("report");
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(runs.pending(r2.id), true);
  runs.delivered(r2.id);
  assert.equal(runs.pending(r2.id), false);
});
