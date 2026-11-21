import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describePlayTest, functionalTestStub, listPlans, loadPlan, parsePlan, planFile, playTestTool, runPlayTest, savePlan, type PlayStepResult, type PlayTestBridge, type PlayTestPlan } from "./play-test.js";
import { engineWrites } from "./chat-tools-games.js";
import { createKesherServer } from "./server.js";

const plan: PlayTestPlan = {
  name: "Jump over wall",
  steps: [
    { do: "input", action: "/Game/Input/IA_Jump", value: true, frames: 10 },
    { do: "wait", until: { actor: "player", property: "location.z", op: ">", value: 150 }, timeout: 2 },
    { do: "screenshot", name: "top" },
  ],
};

/** A fake plugin: answers play_test, gives one more step per status call, then play_test_stop. */
function fakeBridge(o: { version?: string; picture?: string; failAt?: number } = {}): PlayTestBridge & { calls: string[] } {
  const calls: string[] = [];
  let given = 0;
  const step = (i: number): PlayStepResult => ({ index: i, do: plan.steps[i]!.do, ok: i !== o.failAt, text: i === 1 ? "location.z = 180" : "done", ...(i === 2 && o.picture ? { picture: o.picture } : {}) });
  return {
    calls,
    connected: true,
    status: async () => ({ editor: { bridge: o.version ?? "0.1.25" } }),
    request: async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === "play_test") return { started: !!(args?.plan as PlayTestPlan).steps.length } as T;
      if (cmd === "play_test_status") {
        given = Math.min(3, given + 1);
        return { running: given < 3, done: given >= 3, steps: Array.from({ length: given }, (_, i) => step(i)) } as T;
      }
      return { done: true, steps: Array.from({ length: 3 }, (_, i) => step(i)), log: [{ kind: "log", category: "LogBlueprintUserMessages", text: "Jumped" }], seconds: 2 } as T;
    },
  };
}

test("a plan is checked: limits, asset paths, key names and conditions", () => {
  const p = parsePlan(JSON.stringify({ name: "a b/c", steps: [{ do: "key", key: "SpaceBar", frames: 9999 }, { do: "assert", actor: "player", property: "speed", op: ">", value: 10 }] }));
  assert.equal(p.name, "a_b_c");
  assert.deepEqual(p.steps[0], { do: "key", key: "SpaceBar", frames: 600 });
  assert.throws(() => parsePlan({ name: "x", steps: [] }), /no steps/);
  assert.throws(() => parsePlan({ name: "x", steps: [{ do: "input", action: "C:/evil" }] }), /Step 1: input needs/);
  assert.throws(() => parsePlan({ name: "x", steps: [{ do: "key", key: "rm -rf" }] }), /Step 1: key needs/);
  assert.throws(() => parsePlan({ name: "x", steps: [{ do: "assert", actor: "player", property: "a;b", op: "==", value: 1 }] }), /property/);
  assert.throws(() => parsePlan({ name: "x", steps: [{ do: "assert", actor: "player", property: "Health", op: "==" }] }), /needs a value/);
  assert.throws(() => parsePlan({ name: "x", steps: Array.from({ length: 41 }, () => ({ do: "wait", seconds: 1 })) }), /at most 40/);
  assert.throws(() => parsePlan({ name: "x", map: "../x", steps: [{ do: "wait", seconds: 1 }] }), /test map/);
});

test("a run streams each step once, always stops play, and reads only the plugin's own pictures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pt-"));
  await mkdir(join(dir, "Saved", "KesherAI", "play-test"), { recursive: true });
  const pic = join(dir, "Saved", "KesherAI", "play-test", "top.png");
  await writeFile(pic, Buffer.from("89504e47", "hex"));
  const b = fakeBridge({ picture: pic });
  const seen: number[] = [];
  const run = await runPlayTest(b, plan, { pollMs: 1, onStep: (r) => seen.push(r.index) });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(run.passed, true);
  assert.equal(run.pictures.length, 1);
  assert.equal(b.calls.at(-1), "play_test_stop");
  assert.match(describePlayTest(run, parsePlan(plan)), /PASSED[\s\S]*✓ 2\. wait until player\.location\.z > 150[\s\S]*Jumped/);

  const other = await runPlayTest(fakeBridge({ picture: join(dir, "secret.png"), failAt: 1 }), plan, { pollMs: 1 });
  assert.equal(other.pictures.length, 0, "a path outside Saved/KesherAI/play-test is never read");
  assert.equal(other.passed, false);
});

test("an older plugin is asked to update; Stop still ends play; Unreal closed runs headless", async () => {
  await assert.rejects(runPlayTest(fakeBridge({ version: "0.1.24" }), plan), /plugin 0\.1\.25/);
  const b = fakeBridge();
  const ac = new AbortController();
  ac.abort();
  const stopped = await runPlayTest(b, plan, { signal: ac.signal, pollMs: 1 });
  assert.equal(stopped.reason, "Stopped.");
  assert.equal(stopped.passed, false);
  assert.deepEqual(b.calls, ["play_test", "play_test_stop"]);

  let asked: unknown;
  const closed: PlayTestBridge = { connected: false, canPlayHeadless: true, status: async () => ({}), request: async () => assert.fail("no socket"), playHeadless: async (p) => ((asked = p), { done: true, passed: true, steps: plan.steps.map((s, i) => ({ index: i, do: s.do, ok: true, text: "" })) }) };
  const run = await runPlayTest(closed, plan);
  assert.equal(run.mode, "headless");
  assert.equal(run.passed, true);
  assert.equal((asked as PlayTestPlan).name, "Jump_over_wall");
  await assert.rejects(runPlayTest({ ...closed, canPlayHeadless: false }, plan), /Open the project in Unreal/);
});

test("a test is kept in Content/KesherTests, listed and read back; the chat tool streams and keeps it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pt-"));
  const file = await savePlan(dir, plan);
  assert.equal(file, planFile(dir, "Jump_over_wall"));
  assert.equal(JSON.parse(await readFile(file, "utf8")).steps.length, 3);
  assert.deepEqual((await listPlans(dir)).map((t) => t.name), ["Jump_over_wall"]);
  assert.equal((await loadPlan(dir, "Jump_over_wall")).steps[0]?.do, "input");
  await assert.rejects(loadPlan(dir, "nope"), /No test named nope/);

  const tool = playTestTool({ bridge: fakeBridge(), projectDir: () => dir, saveImage: async () => "asset1" });
  const lines: string[] = [];
  const out = await tool.run({ plan: { ...plan, name: "Second" }, save: true }, { signal: new AbortController().signal, recordChange: () => undefined, progress: (t) => lines.push(t) });
  assert.match(lines.join(""), /▶ Second: 3 steps\n✓ 1\. press IA_Jump/);
  assert.match(out.output, /PASSED[\s\S]*Kept as/);
  assert.equal((await listPlans(dir)).length, 2);
  assert.match((await tool.run({ action: "stub", name: "Second" }, { signal: new AbortController().signal, recordChange: () => undefined })).output, /class YOURGAME_API AKesherSecondTest : public AFunctionalTest/);
  assert.match(functionalTestStub(parsePlan(plan), "blueprint"), /Inject Input for Action \(\/Game\/Input\/IA_Jump/);

  // The checkpoint wrapper keeps the plan file before a save, and nothing for a plain run.
  assert.deepEqual(engineWrites("unreal_play_test", { plan: { name: "Second" }, save: true }, { unreal: dir })?.files, [planFile(dir, "Second")]);
  assert.equal(engineWrites("unreal_play_test", { plan: { name: "Second" } }, { unreal: dir }), undefined);
});

test("the page runs a kept test through the bridge and polls each step", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-ptr-"));
  const project = join(dataDir, "Game");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "Game.uproject"), "{}");
  await savePlan(project, plan);
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as { port: number }).port;
  const fake = fakeBridge();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/unreal/ws`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { id: string; cmd: string; plan?: unknown };
    void fake.request(m.cmd, m).then((result) => ws.send(JSON.stringify({ id: m.id, ok: true, result })), () => ws.send(JSON.stringify({ id: m.id, ok: true, result: { ok: true } })));
  });
  try {
    ws.send(JSON.stringify({ event: "hello", project: "Game", engine: "5.8.4", bridge: "0.1.25", projectFile: join(project, "Game.uproject") }));
    await new Promise((r) => setTimeout(r, 200));
    const list = (await server.app.inject({ method: "GET", url: "/api/unreal/play-tests" })).json() as { tests: Array<{ name: string }> };
    assert.deepEqual(list.tests.map((t) => t.name), ["Jump_over_wall"]);
    const start = await server.app.inject({ method: "POST", url: "/api/unreal/play-tests/run", payload: { name: "Jump_over_wall" } });
    assert.equal(start.statusCode, 200, start.body);
    let state: { running: boolean; steps: Array<{ line: string }>; passed?: boolean } = { running: true, steps: [] };
    for (let i = 0; i < 100 && state.running; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = (await server.app.inject({ method: "GET", url: "/api/unreal/play-tests/run" })).json();
    }
    assert.equal(state.passed, true);
    assert.equal(state.steps.length, 3);
    const bad = await server.app.inject({ method: "POST", url: "/api/unreal/play-tests", payload: { plan: { name: "x", steps: [{ do: "key", key: "a b" }] } } });
    assert.equal(bad.statusCode, 400);
  } finally {
    ws.close();
    await server.close();
  }
});
