import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryTools } from "./memory-tools.js";

test("memory tools: remember adds a note once, refuses secrets; forget removes matching notes", async () => {
  let p = { notes: ["writes in Hebrew"], analysed: 0 } as { notes: string[]; analysed: number };
  const coach = { profile: async () => structuredClone(p), save: async (x: typeof p) => void (p = x) };
  const [remember, forget] = memoryTools(coach as never);
  const ctx = { signal: new AbortController().signal } as never;
  await remember!.run({ note: "Makes games in Unreal" }, ctx);
  await remember!.run({ note: "makes games in unreal" }, ctx);
  assert.deepEqual(p.notes, ["writes in Hebrew", "Makes games in Unreal"]);
  await assert.rejects(remember!.run({ note: "my password is hunter2" }, ctx), /passwords/);
  assert.match((await forget!.run({ about: "unreal" }, ctx)).output, /Forgot 1/);
  assert.deepEqual(p.notes, ["writes in Hebrew"]);
});
