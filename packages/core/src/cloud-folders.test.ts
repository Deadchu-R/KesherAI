import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudFolders } from "./cloud-folders.js";

test("finds OneDrive from the environment and Dropbox in the home folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-home-"));
  await mkdir(join(home, "OneDrive - Personal"));
  await mkdir(join(home, "Dropbox"));
  const found = cloudFolders({ OneDrive: join(home, "OneDrive - Personal") }, home);
  assert.deepEqual(found.map((f) => f.service), ["OneDrive", "Dropbox"]);
  assert.equal(found[0]!.folder, join(home, "OneDrive - Personal", "KesherAI"));
  assert.deepEqual(cloudFolders({}, join(home, "none")), []);
});
