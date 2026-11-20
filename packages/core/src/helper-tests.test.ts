import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, linkDependencies, runTestsTool } from "./helper-tests.js";

const temp = () => mkdtemp(join(tmpdir(), "kesher-tests-"));
const isLink = (p: string) => lstat(p).then((s) => s.isSymbolicLink(), () => false);

test("the check command comes from the project's own scripts", async () => {
  const dir = await temp();
  try {
    assert.equal(await checkCommand(dir), undefined);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc" } }));
    assert.deepEqual(await checkCommand(dir), { command: "npm test -s" });
    assert.deepEqual(await checkCommand(dir, "typecheck"), { command: "npm run -s typecheck" });
    assert.equal(await checkCommand(dir, "lint"), undefined);
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    assert.deepEqual(await checkCommand(dir), { command: "pnpm -s test" });
    const rust = await temp();
    await writeFile(join(rust, "Cargo.toml"), "");
    assert.deepEqual(await checkCommand(rust), { command: "cargo test" });
    assert.equal(await checkCommand(rust, "lint"), undefined);
    await rm(rust, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installed packages are linked into the copy and the links taken away after", async () => {
  const src = await temp();
  const copy = await temp();
  try {
    await mkdir(join(src, "node_modules", "x"), { recursive: true });
    await mkdir(join(src, "packages", "a", "node_modules"), { recursive: true });
    await mkdir(join(copy, "packages", "a"), { recursive: true });
    const unlink = await linkDependencies(copy, src);
    assert.ok(await isLink(join(copy, "node_modules")));
    assert.ok(await isLink(join(copy, "packages", "a", "node_modules")));
    await unlink();
    assert.equal(await isLink(join(copy, "node_modules")), false);
    // Only the link went: the project's own folder is still there.
    assert.ok((await lstat(join(src, "node_modules", "x"))).isDirectory());
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
  }
});

test("run_tests runs the project's test script in the copy and says whether it passed", async () => {
  const dir = await temp();
  try {
    const results: Array<{ ok: boolean; command: string }> = [];
    const t = runTestsTool(dir, undefined, (r) => results.push(r));
    assert.equal(t.risk, "exec");
    const ctx = { signal: new AbortController().signal, recordChange: () => undefined, workspace: dir };
    await assert.rejects(t.run({}, ctx), /no test script/);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(3)\"" } }));
    assert.equal(await t.preview!({}, ctx), "npm test -s");
    assert.match((await t.run({}, ctx)).output, /^PASSED: npm test -s/);
    assert.match((await t.run({ check: "lint" }, ctx)).output, /^FAILED: npm run -s lint/);
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
