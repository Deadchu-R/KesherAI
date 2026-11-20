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

test("a run sums its model calls' tokens, and says when it asks and when the ask ends", async () => {
  const runs = new HelperRuns({ limit: () => 1 });
  const seen: string[] = [];
  runs.on("ask", (i: { id: string }) => seen.push(`ask ${i.id}`));
  runs.on("answered", (i: { id: string }) => seen.push(`answered ${i.id}`));
  const info = runs.start(
    job({
      run: async (ctl) => {
        ctl.usage({ input: 1000, output: 100, cached: 600, estimated: false });
        ctl.usage({ input: 500, output: 50, estimated: true });
        await ctl.ask("cloud-files");
        return { report: "ok" };
      },
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(runs.get(info.id)!.state, "asking");
  assert.deepEqual(seen, [`ask ${info.id}`]);
  assert.ok(runs.answer(info.id, true));
  const [ended] = await runs.wait([info.id]);
  assert.deepEqual(seen, [`ask ${info.id}`, `answered ${info.id}`]);
  assert.deepEqual(ended!.usage, { input: 1500, output: 150, cached: 600, calls: 2, estimated: true });
});

test("stopping a run that asks ends its ask once", async () => {
  const runs = new HelperRuns({ limit: () => 1 });
  let answered = 0;
  runs.on("answered", () => answered++);
  const info = runs.start(job({ run: async (ctl) => (await ctl.ask("cloud-files"), ctl.signal.throwIfAborted(), { report: "x" }) }));
  await new Promise((r) => setImmediate(r));
  runs.stop(info.id);
  await runs.wait([info.id]);
  assert.equal(answered, 1);
  assert.equal(runs.get(info.id)!.usage, undefined);
});

test("steer: a note waits until the run takes notes, shows in its steps, and an ended run takes none", async () => {
  const runs = new HelperRuns({ limit: () => 1 });
  const got: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = job();
  runs.start(first);
  // The second waits in the queue: its note is kept until it starts and asks for notes.
  const info = runs.start(job({ run: async (ctl) => { ctl.notes((n) => got.push(n)); await gate; ctl.notes(undefined); return { report: "ok" }; } }));
  assert.equal(info.state, "waiting");
  assert.equal(runs.message(info.id, "  look in src/ too  ", "user"), true);
  assert.match(runs.get(info.id)!.steps.at(-1)!, /^note\(user\): look in src\/ too$/);
  assert.equal(runs.get(info.id)!.step, 0, "a note is not counted as a step");
  first.release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got.length, 1);
  assert.match(got[0]!, /A note from the user[\s\S]*look in src\/ too/);
  assert.equal(runs.message(info.id, "and tests", "lead"), true);
  assert.match(got[1]!, /assistant that started you[\s\S]*and tests/);
  release();
  await runs.wait([info.id]);
  assert.equal(runs.message(info.id, "too late", "user"), false);
  assert.equal(runs.message(info.id, "   ", "user"), false);
});

test("continue: an ended run with its conversation starts again in the background, keeping its tokens", async () => {
  const runs = new HelperRuns({ limit: () => 2 });
  const resumeSpec = { task: "find x", kind: "lookup", maxSteps: 8, write: false };
  const info = runs.start(job({
    resume: resumeSpec,
    run: async (ctl) => {
      ctl.usage({ input: 100, output: 10 });
      ctl.transcript([{ role: "user", content: "find x" }, { role: "assistant", content: "in a.ts" }]);
      return { report: "in a.ts" };
    },
  }));
  await runs.wait([info.id]);
  const ended = runs.get(info.id)!;
  assert.equal(ended.canContinue, true);
  // Without a follow-up, or while it builds nothing, it does not continue.
  assert.equal(runs.continueRun(info.id, " ", "user", () => async () => ({ report: "" })), undefined);
  assert.equal(runs.continueRun(info.id, "now b", "user", () => undefined), undefined);
  let seen: { resumed?: number; followUp?: string; saved?: unknown } = {};
  const again = runs.continueRun(info.id, "now find b", "user", (saved) => {
    seen.saved = saved.resume;
    return async (ctl) => {
      seen = { ...seen, resumed: ctl.resumed?.length, followUp: ctl.followUp };
      ctl.usage({ input: 50, output: 5 });
      return { report: "b is in b.ts" };
    };
  })!;
  assert.equal(again.continued, 1);
  assert.equal(again.background, true);
  assert.equal(again.canContinue, undefined, "a going run cannot be continued");
  assert.match(again.steps.at(-1)!, /^continue\(user\): now find b$/);
  const done = (await runs.wait([info.id]))[0]!;
  assert.deepEqual(seen.saved, resumeSpec);
  assert.equal(seen.resumed, 2, "it goes on from its own conversation");
  assert.match(seen.followUp!, /The user continues your task[\s\S]*now find b/);
  assert.equal(done.state, "done");
  assert.equal(done.report, "b is in b.ts");
  assert.equal(done.usage!.input, 150, "its token totals go on");
  assert.equal(done.usage!.calls, 2);
});

test("continue: a run without a way to build it again (an outside agent) cannot be continued, and only the newest keep their conversation", async () => {
  let t = 0;
  const runs = new HelperRuns({ limit: () => 4, now: () => ++t });
  const plain = runs.start(job({ run: async (ctl) => { ctl.transcript([{ role: "user", content: "x" }]); return { report: "x" }; } }));
  await runs.wait([plain.id]);
  assert.equal(runs.get(plain.id)!.canContinue, undefined);
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const r = runs.start(job({ resume: { task: `t${i}` }, run: async (ctl) => { ctl.transcript([{ role: "user", content: `t${i}` }]); return { report: "ok" }; } }));
    await runs.wait([r.id]);
    ids.push(r.id);
  }
  assert.deepEqual(ids.map((id) => !!runs.get(id)!.canContinue), [false, false, true, true, true, true, true]);
  assert.equal(runs.saved("c1").filter((s) => s.transcript).length, 5);
});
