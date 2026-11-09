import { test } from "node:test";
import assert from "node:assert/strict";
import { runShell } from "./shell.js";

test("a program left running in the background does not hold the command", { skip: process.platform === "win32" }, async () => {
  const t0 = Date.now();
  // The background sleep keeps stdout open after the shell exits.
  const r = await runShell("echo started; sleep 20 &", process.cwd(), 30_000, new AbortController().signal);
  assert.match(r.output, /started/);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
});
