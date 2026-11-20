import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCloudReadError, looksCloudOnly, resetCloudOnlyCheck } from "./cloud-only.js";

test("a file with a size but no space on disk is a placeholder on Windows only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-cloud-"));
  try {
    // A sparse file stands in for a placeholder: 64 KB long, nothing on disk.
    const hole = join(dir, "BP_Cloud.uasset");
    await writeFile(hole, "");
    await truncate(hole, 64 * 1024);
    const real = join(dir, "BP_Here.uasset");
    await writeFile(real, Buffer.alloc(64 * 1024, 1));
    const fh = await open(real, "r+");
    await fh.sync();
    await fh.close();
    const probe = real;
    resetCloudOnlyCheck();
    const st = await stat(hole);
    if (st.blocks === 0) assert.equal(looksCloudOnly(st, "win32", probe), true);
    assert.equal(looksCloudOnly(st, "linux", probe), false);
    assert.equal(looksCloudOnly(await stat(real), "win32", probe), false);
    // Small files may sit inside the MFT record: left to the read-error check.
    assert.equal(looksCloudOnly({ size: 900, blocks: 0 }, "win32", probe), false);
    // When this Node reports no sizes on disk at all, nothing is taken for a placeholder.
    // (Only where truncate makes a real sparse file: on Windows it allocates, so the probe does report sizes.)
    resetCloudOnlyCheck();
    if ((await stat(hole)).blocks === 0) assert.equal(looksCloudOnly({ size: 64 * 1024, blocks: 0 }, "win32", hole), false);
    resetCloudOnlyCheck();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read errors of a cloud-only file: EIO, UNKNOWN, cloud codes, on Windows, for a file with a size", () => {
  const err = (code: string) => Object.assign(new Error(`${code}: unknown error, read`), { code });
  assert.equal(isCloudReadError(err("UNKNOWN"), 26_000, "win32"), true);
  assert.equal(isCloudReadError(err("EIO"), 26_000, "win32"), true);
  assert.equal(isCloudReadError(err("ECLOUD_FILE_NOT_IN_SYNC"), 26_000, "win32"), true);
  assert.equal(isCloudReadError(err("EACCES"), 26_000, "win32"), false);
  assert.equal(isCloudReadError(err("EIO"), 0, "win32"), false);
  assert.equal(isCloudReadError(err("EIO"), 26_000, "linux"), false);
  assert.equal(isCloudReadError(undefined, 26_000, "win32"), false);
});
