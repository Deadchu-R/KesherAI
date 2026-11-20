import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneGameBackups } from "./game-backups.js";

test("backups: older than 30 days go, then the oldest until the total fits", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-gbak-"));
  try {
    const now = Date.now();
    await mkdir(join(root, "unity"));
    const put = async (name: string, ageDays: number, size: number) => {
      await writeFile(join(root, "unity", name), "x".repeat(size));
      const t = new Date(now - ageDays * 86_400_000);
      await utimes(join(root, "unity", name), t, t);
    };
    await put("old", 40, 10);
    await put("a", 3, 10);
    await put("b", 2, 10);
    await put("c", 1, 10);
    assert.equal(await pruneGameBackups(root, { now, maxBytes: 20 }), 2);
    assert.deepEqual((await readdir(join(root, "unity"))).sort(), ["b", "c"]);
    assert.equal(await pruneGameBackups(join(root, "missing"), { now }), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
