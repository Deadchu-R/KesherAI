import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixActions, runFixes, type FixContext } from "./pc-fix.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fix-"));
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
