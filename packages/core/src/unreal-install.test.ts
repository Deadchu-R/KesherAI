import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeSource, launcherEngines, readProject } from "./unreal-install.js";

test("launcherEngines reads the Epic Games Launcher's list, newest first", () => {
  const text = JSON.stringify({ InstallationList: [
    { InstallLocation: "C:\\Program Files\\Epic Games\\UE_5.3", AppName: "UE_5.3" },
    { InstallLocation: "C:\\Program Files\\Epic Games\\Fortnite", AppName: "Fortnite" },
    { InstallLocation: "D:\\Epic\\UE_5.5", AppName: "UE_5.5" },
  ] });
  assert.deepEqual(launcherEngines(text).map((e) => e.version), ["5.5", "5.3"]);
  assert.deepEqual(launcherEngines("not json"), []);
});

test("readProject finds the .uproject and the engine it wants (a Blueprint-only project too)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ue-proj-"));
  await writeFile(join(dir, "Door.uproject"), "\uFEFF" + JSON.stringify({ FileVersion: 3, EngineAssociation: "5.4", Category: "", Description: "" }));
  const p = await readProject(dir);
  assert.equal(p.engine, "5.4");
  assert.equal(p.dir, dir);
  await assert.rejects(readProject(tmpdir() + "/nope-" + Date.now()), /No Unreal project/);
});

test("the plugin's source is found in the repository", () => {
  assert.ok(bridgeSource());
});
