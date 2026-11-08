import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingReset, listBackups, requestFullReset, requestSettingsReset, resetSettings } from "./reset.js";

test("reset settings keeps a backup; a full reset moves the folder aside at the next start and keeps models", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kesher-reset-"));
  const root = join(parent, ".kesher");
  await mkdir(join(root, "models"), { recursive: true });
  await mkdir(join(root, "library"), { recursive: true });
  await writeFile(join(root, "config.json"), '{"port":1}');
  await writeFile(join(root, "models", "m.gguf"), "model");
  const saved = await resetSettings(root);
  assert.ok(!existsSync(join(root, "config.json")));
  assert.equal(await readFile(saved, "utf8"), '{"port":1}');
  await writeFile(join(root, "config.json"), '{"port":2}');
  await requestSettingsReset(root);
  assert.ok(existsSync(join(root, "config.json")), "nothing moves until the next start");
  assert.match((await applyPendingReset(root))!, /config-/);
  assert.ok(!existsSync(join(root, "config.json")));

  assert.equal(await applyPendingReset(root), undefined, "nothing happens unless asked");
  await requestFullReset(root, true);
  const backup = (await applyPendingReset(root))!;
  assert.ok(existsSync(join(backup, "library")));
  assert.ok(!existsSync(join(root, "library")));
  assert.equal(await readFile(join(root, "models", "m.gguf"), "utf8"), "model");
  const b = await listBackups(root);
  assert.equal(b.folders.length, 1);
});
