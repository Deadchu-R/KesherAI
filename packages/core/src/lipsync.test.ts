import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installScript, LipSync, parseLipCheck } from "./lipsync.js";

test("the lip sync install carries the Windows fixes found when testing it", () => {
  const s = installScript("E:\\K's\\engines\\lipsync");
  assert.match(s, /--no-build-isolation chumpy/);
  assert.match(s, /setuptools<70/);
  assert.match(s, /startswith\('619a316812'\)/);
  assert.match(s, /PYTHONIOENCODING = 'utf-8'/);
  assert.match(s, /K''s/);
  assert.match(s, /if \(\$LASTEXITCODE\) \{ exit 1 \}/);
});

test("lip sync is offered only with a strong NVIDIA card, and keeps her choices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lipsync-"));
  try {
    const weak = new LipSync(dir, () => "x.py", join(dir, "clip.webm"), async () => 4);
    assert.equal((await weak.status()).possible, false);
    await assert.rejects(weak.install(), /8 GB/);
    await weak.set({ enabled: true, cable: "CABLE Input (VB-Audio Virtual Cable)" });
    const st = await weak.status();
    assert.equal(st.enabled, true);
    assert.equal(st.cable, "CABLE Input (VB-Audio Virtual Cable)");
    assert.equal(st.installed, false);
    assert.equal(weak.upstream(), undefined);
    await assert.rejects(weak.start(), /not installed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the self-test's lip check line is read, with its time", () => {
  assert.deepEqual(parseLipCheck('07:51:02 {"lipcheck": {"moving": true, "vsClip": 6.3, "between": 2.1, "frames": 96}}', 5), { moving: true, vsClip: 6.3, between: 2.1, frames: 96, at: 5 });
  assert.equal(parseLipCheck('07:51:02 {"ready": true, "port": 28790}'), undefined);
  assert.equal(parseLipCheck('{"lipcheck": oops'), undefined);
});
