import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { cleanExternalInput, ExternalAgents, externalNote, parseHelperTrailer, type ExternalNote, type GitRun } from "./external-agents.js";
import type { RunSnapshot } from "./agent-activity.js";
import { externalAgentRoutes } from "./routes/external-agents.js";

const SHA = (n: number) => n.toString(16).padStart(40, "0");

/** A registry with a fake clock, a fake git (the listing it returns) and the observed outputs. */
function setup(log = () => "") {
  const clock = { t: 1_000_000 };
  const snaps: RunSnapshot[] = [];
  const notes: ExternalNote[] = [];
  const head = { sha: SHA(1) };
  const calls: string[][] = [];
  const git: GitRun = async (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return `${head.sha}\n`;
    if (args[0] === "log") return log();
    return "";
  };
  const ext = new ExternalAgents({ observe: (s) => snaps.push(s), phone: (n) => notes.push(n), git: () => git, now: () => clock.t, manual: true });
  return { ext, clock, snaps, notes, head, calls };
}

test("trailer parser: the Helper line, the last one wins, only a whole line", () => {
  assert.equal(parseHelperTrailer("Fix x\n\nbody\n\nHelper: claude-live-notify\nCo-Authored-By: C"), "claude-live-notify");
  assert.equal(parseHelperTrailer("a\n\nHelper: one\nHelper: two\n"), "two");
  assert.equal(parseHelperTrailer("a\n\nHelper: a b\n"), undefined, "a space inside is not an id");
  assert.equal(parseHelperTrailer("see Helper: x in the text"), undefined);
  assert.equal(parseHelperTrailer("a\r\n\r\nHelper: win\r\n"), "win");
  assert.equal(parseHelperTrailer("no trailer"), undefined);
});

test("input check: id, status and limits", () => {
  assert.equal(cleanExternalInput({ status: "running" }).ok, false);
  assert.equal(cleanExternalInput({ id: "../x", status: "running" }).ok, false);
  assert.equal(cleanExternalInput({ id: "a", status: "paused" }).ok, false);
  assert.equal(cleanExternalInput({ id: "a", status: "running", steps: 0 }).ok, false);
  assert.equal(cleanExternalInput({ id: "a", status: "running", steps: 1.5 }).ok, false);
  assert.equal(cleanExternalInput({ id: "a", status: "running", title: 5 }).ok, false);
  const c = cleanExternalInput({ id: "a-1", status: "done", title: `T\n${"x".repeat(500)}`, result: "ok\u0000\n done", step: " s ", steps: 5 });
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal(c.input.title!.length, 120);
    assert.ok(!c.input.title!.includes("\n"));
    assert.equal(c.input.result, "ok done");
    assert.equal(c.input.step, "s");
  }
});

test("a run: start, step, done; activity rows and the phone note", () => {
  const { ext, clock, snaps, notes } = setup();
  ext.report({ id: "h1", title: "Live notify", status: "running", steps: 4 });
  assert.equal(snaps.at(-1)!.runId, "ext-h1");
  assert.equal(snaps.at(-1)!.source, "claude-chat");
  assert.equal(snaps.at(-1)!.state, "running");
  assert.equal(notes.at(-1)!.title, "Claude: Live notify");
  assert.equal(notes.at(-1)!.ref, "claude-h1");
  clock.t += 5 * 60_000;
  ext.report({ id: "h1", status: "running", step: "route done" });
  const n = notes.at(-1)!;
  assert.match(n.body, /^▓░░░░ 1\/4 · 5 דק'/);
  assert.match(n.body, /שלב: route done/);
  assert.deepEqual(n.progress, { v: 1, max: 4 });
  ext.report({ id: "h1", status: "done", result: "All green" });
  const end = notes.at(-1)!;
  assert.match(end.body, /^✓ הסתיים/);
  assert.match(end.body, /All green/);
  assert.equal(end.progress, undefined, "the summary has no bar");
  assert.equal(snaps.at(-1)!.state, "done");
  ext.report({ id: "h2", title: "Other", status: "failed", result: "tests fail" });
  assert.equal(snaps.at(-1)!.state, "failed");
  assert.equal(snaps.at(-1)!.failReason, "tests fail");
});

test("progress notes are throttled: a burst is one note, the tick refreshes the time", () => {
  const { ext, clock, notes } = setup();
  ext.report({ id: "h1", title: "T", status: "running" });
  const base = notes.length;
  ext.fromLog(`${SHA(5)}\x1f1000\x1fS1\n\nHelper: h1\x1e`);
  assert.equal(notes.length, base, "a step 0 s after the last note waits");
  clock.t += 4000;
  ext.fromLog(`${SHA(6)}\x1f1000\x1fS2\n\nHelper: h1\x1e`);
  assert.equal(notes.length, base + 1);
  clock.t += 10_000;
  ext.tick();
  assert.equal(notes.length, base + 1, "nothing new within 20 s");
  clock.t += 11_000;
  ext.tick();
  assert.equal(notes.length, base + 2);
});

test("commit watcher: fetch, log after the last seen head; trailer commits of open runs become steps once", async () => {
  const log = `${SHA(2)}\x1f1000\x1fAdd route\n\nbody\n\nHelper: h1\nCo-Authored-By: C\x1e${SHA(3)}\x1f1000\x1fOther work\x1e${SHA(4)}\x1f1000\x1fFor nobody\n\nHelper: zzz\x1e`;
  const s = setup(() => log);
  s.ext.report({ id: "h1", title: "T", status: "running" });
  assert.equal(await s.ext.watch(), 0, "the first round only learns where main is");
  assert.deepEqual(s.calls[0], ["fetch", "--quiet", "origin", "main"]);
  s.head.sha = SHA(4);
  assert.equal(await s.ext.watch(), 2, "h1 gets a step; zzz (no run) becomes a caught-up run");
  assert.equal(s.ext.list().find((r) => r.id === "zzz")?.status, "done");
  assert.deepEqual(s.calls.at(-1), ["log", "--reverse", "--max-count=300", "--format=%H%x1f%ct%x1f%B%x1e", `${SHA(1)}..${SHA(4)}`]);
  const run = s.ext.list().find((r) => r.id === "h1")!;
  assert.deepEqual(run.steps.map((x) => [x.text, x.sha]), [["Add route", SHA(2).slice(0, 8)]]);
  assert.equal(await s.ext.watch(), 0, "no new commits");
  assert.equal(s.ext.fromLog(log), 0, "the same commit is not added twice");
});

test("commit watcher: nothing to do without an open run or a project; a failing git is ignored", async () => {
  const s = setup();
  assert.equal(await s.ext.watch(), 0);
  assert.equal(s.calls.length, 0, "no run open: no git");
  s.ext.report({ id: "h1", title: "T", status: "running" });
  s.ext.report({ id: "h1", status: "done" });
  assert.equal(await s.ext.watch(), 0);
  const bad = new ExternalAgents({ observe: () => undefined, phone: () => undefined, git: () => async () => { throw new Error("offline"); }, manual: true });
  bad.report({ id: "x", title: "T", status: "running" });
  assert.equal(await bad.watch(), 0);
  const none = new ExternalAgents({ observe: () => undefined, phone: () => undefined, git: () => undefined, manual: true });
  none.report({ id: "x", title: "T", status: "running" });
  assert.equal(await none.watch(), 0);
});

test("catch-up: commits of an id no run knows make a finished run; one note, none when older than 12 h; base is kept", async () => {
  const hour = 3_600;
  const log = `${SHA(2)}\x1f${1_000_000 / 1000 - 600}\x1fFirst\n\nHelper: lost\x1e${SHA(3)}\x1f${1_000_000 / 1000 - 60}\x1fSecond\n\nHelper: lost\x1e${SHA(4)}\x1f${1_000_000 / 1000 - 20 * hour}\x1fOld\n\nHelper: ancient\x1e${SHA(5)}\x1f${1_000_000 / 1000}\x1fPlain\x1e`;
  const saved: string[] = [];
  const s = setup(() => log);
  const calls = s.calls;
  const ext = new ExternalAgents({ observe: () => undefined, phone: (n) => s.notes.push(n), git: () => async (a) => (calls.push(a), a[0] === "rev-parse" ? `${SHA(9)}\n` : a[0] === "log" ? log : ""), store: { load: async () => SHA(1), save: (b) => saved.push(b) }, now: () => 1_000_000, manual: true });
  assert.equal(await ext.catchUp(), 3);
  assert.deepEqual(calls.at(-1)!.slice(-1), [`${SHA(1)}..${SHA(9)}`]);
  assert.deepEqual(saved, [SHA(9)]);
  const lost = ext.list().find((r) => r.id === "lost")!;
  assert.equal(lost.status, "done");
  assert.deepEqual(lost.steps.map((x) => x.text), ["First", "Second"]);
  assert.equal(ext.list().find((r) => r.id === "ancient")!.status, "done");
  assert.deepEqual(s.notes.map((n) => n.ref), ["claude-lost"], "one summary note; the 20-hour-old run has none");
  assert.match(s.notes[0]!.body, /^✓ הסתיים/);
  assert.equal(await ext.catchUp(), 0, "the same head again: nothing");
});

test("catch-up with no earlier look reads back 12 hours; a plain open-run round does not", async () => {
  const s = setup(() => `${SHA(2)}\x1f1000\x1fX\n\nHelper: z\x1e`);
  const ext = new ExternalAgents({ observe: () => undefined, phone: () => undefined, git: () => async (a) => (s.calls.push(a), a[0] === "rev-parse" ? `${SHA(9)}\n` : a[0] === "log" ? `${SHA(2)}\x1f1000\x1fX\n\nHelper: z\x1e` : ""), manual: true });
  assert.equal(await ext.catchUp(), 1);
  assert.ok(s.calls.some((a) => a.includes("--since")));
});

test("an open run nobody reports on for 3 hours fails; at most 30 runs are kept", () => {
  const { ext, clock, snaps } = setup();
  ext.report({ id: "old", title: "T", status: "running" });
  clock.t += 3 * 3_600_000 + 1;
  ext.tick();
  assert.equal(ext.list()[0]!.status, "failed");
  assert.equal(snaps.at(-1)!.state, "failed");
  for (let i = 0; i < 40; i++) {
    clock.t += 10;
    ext.report({ id: `r${i}`, title: "T", status: "done" });
  }
  assert.equal(ext.list().length, 30);
});

test("a run that ended and starts again is a fresh run", () => {
  const { ext } = setup();
  ext.report({ id: "a", title: "One", status: "running", step: "s" });
  ext.report({ id: "a", status: "done" });
  const r = ext.report({ id: "a", status: "running" });
  assert.equal(r.status, "running");
  assert.equal(r.steps.length, 0);
  assert.equal(r.title, "One");
});

test("note text: running without a known total, and failed", () => {
  const run = { id: "a", title: "T", status: "running" as const, steps: [{ text: "x", at: 0 }], startedAt: 0, touchedAt: 0 };
  const n = externalNote(run, 120_000);
  assert.match(n.body, /1 צעדים עד עכשיו/);
  assert.deepEqual(n.progress, { v: 1, max: 0 });
  assert.match(externalNote({ ...run, status: "failed", endedAt: 60_000, result: "boom" }, 0).body, /^✕ נכשל/);
});

test("route: local or paired only, validates, registers", async () => {
  const { ext } = setup();
  const app = Fastify();
  await externalAgentRoutes(app, { externalAgents: ext } as never);
  const post = (payload: unknown, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") => app.inject({ method: "POST", url: "/api/agents/external", payload: payload as object, headers: { host: "127.0.0.1:3000", ...headers }, remoteAddress });
  assert.equal((await post({ id: "a", title: "T", status: "running" })).statusCode, 200);
  assert.equal((await post({ id: "a", status: "nope" })).statusCode, 400);
  assert.equal((await post({ id: "a", title: "T", status: "running" }, { "x-forwarded-for": "1.2.3.4" })).statusCode, 403, "through a tunnel without a paired key");
  assert.equal((await post({ id: "a", title: "T", status: "running" }, {}, "8.8.8.8")).statusCode, 403);
  const list = await app.inject({ method: "GET", url: "/api/agents/external" });
  assert.equal(JSON.parse(list.body).runs[0].id, "a");
  await app.close();
});
