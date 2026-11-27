import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentTool } from "@kesher/agent";
import type { ChildProcess } from "node:child_process";
import { BackgroundCommands, duration, RUNNING_PER_CHAT, RUNNING_TOTAL, tailLines } from "./background-commands.js";

/** A fake process: write to `out`, end it with `exit(code)`. */
class Fake extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4000 + Math.floor(Math.random() * 1000);
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
  exit(code: number | null) {
    this.emit("close", code);
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "bg-"));
  const sent: Array<{ convId: string; text: string }> = [];
  const woke: string[] = [];
  const procs: Fake[] = [];
  const killed: Array<number | undefined> = [];
  let t = 1_000_000;
  const mk = () =>
    new BackgroundCommands({
      dir,
      send: async (convId, text) => void sent.push({ convId, text }),
      onWake: (c) => void woke.push(c),
      spawn: () => {
        const f = new Fake();
        procs.push(f);
        return f as unknown as ChildProcess;
      },
      kill: (pid, child) => {
        killed.push(pid);
        (child as unknown as Fake | undefined)?.kill();
      },
      now: () => t,
    });
  return { dir, sent, woke, procs, killed, mk, tick: (ms: number) => (t += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

test("duration and tailLines", () => {
  assert.equal(duration(134_000), "2m 14s");
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(3_900_000), "1h 05m");
  assert.deepEqual(tailLines("a\nb\nc\n", 2), ["b", "c"]);
  assert.deepEqual(tailLines("ok 1\nERROR x\nok 2\nerror y\n", 5, "error"), ["ERROR x", "error y"]);
  assert.equal(tailLines(Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"), 9999).length, 200);
});

test("start returns at once; output tail and grep; the output is a file", async () => {
  const s = await setup();
  const bg = s.mk();
  const c = await bg.run("c1", "npm run build", "/p");
  assert.equal(c.state, "running");
  s.procs[0]!.stdout.write("compiling\nwarning: a\nERROR boom\n");
  await flush();
  assert.match(await readFile(c.file, "utf8"), /ERROR boom/);
  const tools = bg.tools("c1");
  const out = tools.find((t) => t.spec.name === "command_output")!;
  const r = await out.run({ id: c.id, grep: "error" }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(r.output, /ERROR boom/);
  assert.doesNotMatch(r.output, /compiling/);
  await assert.rejects(out.run({ id: "nope" }, { signal: new AbortController().signal, recordChange: () => undefined }), /No background command/);
  const list = await tools.find((t) => t.spec.name === "commands")!.run({}, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(list.output, /npm run build/);
});

test("stop kills the process; no wake turn for a stop", async () => {
  const s = await setup();
  const bg = s.mk();
  const c = await bg.run("c1", "node server.js", "/p");
  assert.equal(await bg.stop("c1", c.id), true);
  assert.equal(c.state, "stopped");
  assert.equal(s.procs[0]!.killed, true);
  s.procs[0]!.exit(null);
  await flush();
  assert.equal(s.sent.length, 0);
  assert.equal(await bg.stop("c1", c.id), false);
  assert.equal(await bg.stop("other", c.id), false);
});

test("an exit wakes the chat with the last 30 lines, once, and tells the phone", async () => {
  const s = await setup();
  const bg = s.mk();
  const c = await bg.run("c1", "npm test", "/p");
  s.procs[0]!.stdout.write(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
  s.tick(134_000);
  s.procs[0]!.exit(2);
  await flush();
  assert.equal(c.state, "exited");
  assert.equal(c.exit, 2);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.woke, ["c1"]);
  const m = s.sent[0]!.text;
  assert.match(m, /^\[KesherAI\] Background command finished: npm test \(exit 2, 2m 14s\)/);
  assert.match(m, /line 49/);
  assert.match(m, /line 20/);
  assert.doesNotMatch(m, /line 19\b/);
});

test("limits: 4 per chat, 12 in all", async () => {
  const s = await setup();
  const bg = s.mk();
  for (let i = 0; i < RUNNING_PER_CHAT; i++) await bg.run("c1", `cmd ${i}`, "/p");
  await assert.rejects(bg.run("c1", "one more", "/p"), /already has 4/);
  for (const chat of ["c2", "c3"]) for (let i = 0; i < RUNNING_PER_CHAT; i++) await bg.run(chat, `cmd ${i}`, "/p");
  assert.equal(bg.list().filter((c) => c.state === "running").length, RUNNING_TOTAL);
  await assert.rejects(bg.run("c4", "x", "/p"), /already 12/);
});

test("deleting the chat kills its processes and removes its files", async () => {
  const s = await setup();
  const bg = s.mk();
  const a = await bg.run("c1", "a", "/p");
  const b = await bg.run("c2", "b", "/p");
  await bg.forget("c1");
  assert.equal(s.procs[0]!.killed, true);
  assert.equal(s.procs[1]!.killed, false);
  assert.equal(bg.list("c1").length, 0);
  assert.equal(bg.list("c2")[0]!.id, b.id);
  await flush();
  await assert.rejects(stat(a.file));
  assert.equal(s.sent.length, 0);
});

test("on restart a command still marked running is killed by pid and marked ended with KesherAI", async () => {
  const s = await setup();
  const first = s.mk();
  const c = await first.run("c1", "npm run dev", "/p");
  const second = s.mk();
  await second.start();
  assert.deepEqual(s.killed, [c.pid]);
  const again = second.list("c1")[0]!;
  assert.equal(again.state, "ended");
  const listed = await second.tools("c1").find((t) => t.spec.name === "commands")!.run({}, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(listed.output, /ended with KesherAI/);
});

test("the output file is a ring: past 5 MB the older half is dropped", async () => {
  const s = await setup();
  const bg = s.mk();
  const c = await bg.run("c1", "yes", "/p");
  const chunk = "x".repeat(1023) + "\n";
  for (let i = 0; i < 5300; i++) s.procs[0]!.stdout.write(chunk);
  s.procs[0]!.stdout.write("THE END\n");
  // The writes are queued: wait until the last line is in the file.
  for (let i = 0; i < 100 && !(await readFile(c.file, "utf8")).endsWith("THE END\n"); i++) await new Promise((r) => setTimeout(r, 100));
  const text = await readFile(c.file, "utf8");
  assert.ok(text.endsWith("THE END\n"));
  assert.ok(text.length <= 5 * 1024 * 1024 + 1024, `size ${text.length}`);
  assert.ok(text.length > 1024 * 1024, "keeps the recent part");
});

test("run_command wrap: background starts one, plain calls pass through", async () => {
  const s = await setup();
  const bg = s.mk();
  const calls: unknown[] = [];
  const orig: AgentTool = { risk: "exec", spec: { name: "run_command", description: "", inputSchema: { type: "object", properties: {} } }, run: async (i) => (calls.push(i), { output: "plain" }) };
  const w = bg.wrap("c1", orig);
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined, workspace: "/p" };
  assert.equal((await w.run({ command: "ls" }, ctx)).output, "plain");
  const r = await w.run({ command: "npm run build", background: true }, ctx);
  assert.match(r.output, /Started in the background \(id [0-9a-f]{8}\)/);
  assert.equal(calls.length, 1);
  assert.equal(w.risk, "exec");
  assert.equal(bg.wrap("c1", { ...orig, spec: { ...orig.spec, name: "read_file" } }).spec.name, "read_file");
  await assert.rejects(w.run({ command: "x", background: true }, { ...ctx, workspace: undefined as unknown as string }), /no project folder/);
});
