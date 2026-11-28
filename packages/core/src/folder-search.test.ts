import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFolder } from "./folder-search.js";

test("searchFolder finds lines, skips dependencies and binary files, and honours the limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "fs-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "a.ts"), "const Foo = 1;\nlet x;\nfoo();\n");
  await writeFile(join(root, "node_modules", "b.js"), "foo");
  await writeFile(join(root, "bin.dat"), Buffer.from([102, 111, 111, 0]));
  const hits = await searchFolder(root, "FOO");
  assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`), ["src/a.ts:1", "src/a.ts:3"]);
  assert.equal((await searchFolder(root, "foo", 1)).length, 1);
  assert.deepEqual(await searchFolder(root, "f"), []);
});
