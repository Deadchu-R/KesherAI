import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixActions, runFixes, type FixContext } from "./pc-fix.js";

// Each setup writes ~150 MB of model files: all removed at the end (they filled the disk before).
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fix-"));
  roots.push(root);
  const models = join(root, "models");
  mkdirSync(join(models, "org", "old"), { recursive: true });
  mkdirSync(join(models, "new"), { recursive: true });
  const big = Buffer.alloc(51 * 1024 * 1024);
  const old = join(models, "org", "old", "old.gguf");
  const fresh = join(models, "new", "fresh.gguf");
  const loaded = join(models, "new", "loaded.gguf");
  for (const f of [old, fresh, loaded]) writeFileSync(f, big);
  const longAgo = (Date.now() - 60 * 86_400_000) / 1000;
  utimesSync(old, longAgo, longAgo);
  utimesSync(loaded, longAgo, longAgo);
  const repo = join(root, "repo");
  const cur = join(root, "wt", "cur");
  const clean = join(root, "wt", "clean");
  const dirty = join(root, "wt", "dirty");
  for (const d of [repo, cur, clean, dirty]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clean, "a.txt"), "x".repeat(1000));
  const calls: string[][] = [];
  const git: FixContext["git"] = async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (args[0] === "worktree" && args[1] === "list") return { code: 0, out: [`worktree ${repo}\nHEAD a\nbranch refs/heads/main`, `worktree ${cur}\nHEAD b\nbranch refs/heads/kesher-self/cur`, `worktree ${clean}\nHEAD c\nbranch refs/heads/kesher-self/clean`, `worktree ${dirty}\nHEAD d\nbranch refs/heads/kesher-self/dirty`, `worktree ${join(root, "other")}\nHEAD e\nbranch refs/heads/feature`].join("\n\n") };
    if (args[0] === "status") return { code: 0, out: cwd === dirty ? " M x.ts\n" : "" };
    return { code: 0, out: "" };
  };
  let unloaded = 0;
  const ctx: FixContext = { loadedModel: loaded, busy: false, memoryShort: true, modelsDir: models, modelUse: { [fresh]: new Date().toISOString() }, selfWork: { repo, worktree: cur }, unload: async () => void unloaded++, git };
  return { ctx, old, fresh, loaded, clean, dirty, calls, unloaded: () => unloaded };
}

test("fix it: lists unload, old self-work copies (dirty not ticked) and unused own models, never the loaded one", async () => {
  const t = setup();
  const a = await fixActions(t.ctx);
  const ids = a.map((x) => x.id);
  assert.ok(ids.includes("unload"));
  assert.equal(a.find((x) => x.id === "unload")!.safe, true);
  assert.equal(a.find((x) => x.id === "self-work:kesher-self/clean")!.safe, true);
  assert.equal(a.find((x) => x.id === "self-work:kesher-self/dirty")!.safe, false);
  assert.ok(!ids.some((i) => i.includes("cur") || i.includes("feature")));
  const models = a.filter((x) => x.kind === "model");
  assert.deepEqual(models.map((m) => m.name), ["old.gguf"]);
  assert.equal(models[0]!.safe, false);
  assert.equal((await fixActions({ ...t.ctx, busy: true })).find((x) => x.id === "unload")!.safe, false);
});

test("fix it: does only the chosen ids from a fresh list; unknown ids and outside paths do nothing", async () => {
  const t = setup();
  const model = (await fixActions(t.ctx)).find((x) => x.kind === "model")!;
  const r = await runFixes(["unload", "self-work:kesher-self/clean", model.id, "model:../../etc/passwd:1", "self-work:main"], t.ctx);
  assert.deepEqual(r.done.sort(), ["self-work:kesher-self/clean", "unload", model.id].sort());
  assert.equal(r.failed.length, 2);
  assert.equal(t.unloaded(), 1);
  assert.ok(!existsSync(t.old));
  assert.ok(existsSync(t.fresh) && existsSync(t.loaded));
  assert.ok(t.calls.some((c) => c.includes("remove") && c.includes(t.clean)));
  assert.ok(!t.calls.some((c) => c.includes("remove") && c.includes(t.dirty)));
  const busy = await runFixes(["unload"], { ...t.ctx, busy: true });
  assert.equal(busy.failed[0]!.id, "unload");
});

test("pc fix: a KesherAI engine left running on the card is offered and closed; the current ones and other programs are not", async () => {
  const { fixActions, runFixes, parseGpuApps } = await import("./pc-fix.js");
  const apps = parseGpuApps("1111, C:\\\\KesherAI\\\\engines\\\\llamacpp\\\\llama-server.exe, 17000\n2222, C:\\\\Games\\\\game.exe, 4000\n3333, C:\\\\KesherAI\\\\engines\\\\llamacpp\\\\llama-server.exe, 9000\n");
  assert.equal(apps.length, 3);
  assert.equal(apps[0]!.bytes, 17000 * 1024 * 1024);
  const killed: number[] = [];
  // 1111's starter is gone (left over); 3333 is the current engine (its starter is this server).
  const parentOf = async (pid: number) => (pid === 1111 ? 999_999_9 : process.pid);
  const ctx = { busy: false, memoryShort: false, modelsDir: "/nonexistent-models", modelUse: {}, unload: async () => undefined, gpuApps: async () => apps, ownPids: [3333], enginesDir: "C:\\\\KesherAI\\\\engines", kill: (p: number) => void killed.push(p), parentOf };
  const list = await fixActions(ctx);
  const engines = list.filter((a) => a.kind === "engine");
  assert.deepEqual(engines.map((a) => a.id), ["engine:1111"]);
  assert.equal(engines[0]!.safe, true);
  const r = await runFixes(["engine:1111", "engine:2222"], ctx);
  assert.deepEqual(killed, [1111]);
  assert.deepEqual(r.done, ["engine:1111"]);
});

test("pc fix: before the card is used, KesherAI's own engine programs left running are closed by themselves (not ComfyUI, not others)", async () => {
  const { closeLeftOverEngines } = await import("./pc-fix.js");
  const killed: number[] = [];
  const apps = [
    { pid: 10, name: "E:\\KesherAI\\engines\\llamacpp\\llama-server.exe", bytes: 1 },
    { pid: 11, name: "E:\\KesherAI\\engines\\llamacpp\\llama-server.exe", bytes: 1 },
    { pid: 12, name: "E:\\KesherAI\\engines\\comfyui\\python.exe", bytes: 1 },
    { pid: 13, name: "C:\\Games\\game.exe", bytes: 1 },
  ];
  // 10's starter is gone; 11 is not on the guard's list (as on the PC) but this server started it: kept.
  const closed = await closeLeftOverEngines({ gpuApps: async () => apps, ownPids: [], kill: (p) => void killed.push(p), parentOf: async (pid) => (pid === 10 ? 999_999_9 : process.pid) });
  assert.deepEqual(killed, [10]);
  assert.equal(closed.length, 1);
  // A starter that cannot be read: nothing is closed.
  killed.length = 0;
  await closeLeftOverEngines({ gpuApps: async () => apps, ownPids: [], kill: (p) => void killed.push(p), parentOf: async () => undefined });
  assert.deepEqual(killed, []);
});
