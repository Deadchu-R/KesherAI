import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestEngines } from "./unreal-install.js";
import { newProjectFiles, unrealTools } from "./unreal-tools.js";

test("manifestEngines reads the launcher's .item manifests", () => {
  const items = [JSON.stringify({ AppName: "UE_5.6", InstallLocation: "D:\\Epic\\UE_5.6" }), JSON.stringify({ AppName: "Fortnite", InstallLocation: "C:\\F" }), "junk"];
  assert.deepEqual(manifestEngines(items), [{ version: "5.6", path: "D:\\Epic\\UE_5.6", kind: "launcher" }]);
});

test("a new project is a C++ game for phones with MCP on 5.8", () => {
  const f = newProjectFiles("AutoShooter", "5.8");
  const up = JSON.parse(f["AutoShooter.uproject"]!) as { Modules: Array<{ Name: string }>; Plugins: Array<{ Name: string }> };
  assert.equal(up.Modules[0]!.Name, "AutoShooter");
  assert.ok(up.Plugins.some((p) => p.Name === "ModelContextProtocol"));
  assert.match(f["Config/DefaultEngine.ini"]!, /GlobalDefaultGameMode=\/Script\/AutoShooter\.AutoShooterGameMode/);
  assert.match(f["Config/DefaultEngine.ini"]!, /TargetedHardwareClass=Mobile/);
  // UE 5.8: a plugin pulls in GameFeatures, and the cook fails without this asset-manager rule (seen packaging AutoShooter).
  assert.match(f["Config/DefaultGame.ini"]!, /PrimaryAssetType="GameFeatureData"/);
  assert.match(f["Source/AutoShooter/AutoShooterGameMode.h"]!, /class AUTOSHOOTER_API AAutoShooterGameMode/);
  const old = JSON.parse(newProjectFiles("Game", "5.6")["Game.uproject"]!) as { Plugins: Array<{ Name: string }> };
  assert.ok(!old.Plugins.some((p) => p.Name === "ModelContextProtocol"));
});

test("source tools stay inside the project and its code folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ue-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  await writeFile(join(dir, "Game.uproject"), JSON.stringify({ EngineAssociation: "5.8" }));
  await mkdir(join(dir, "Source"), { recursive: true });
  const state = { project: dir };
  const tools = unrealTools(state, join(dir, "logs"));
  const write = tools.find((t) => t.spec.name === "unreal_write_source")!;
  const ok = await write.run({ path: "Source/Game/A.cpp", content: "int x;" }, {} as never);
  assert.match(ok.output, /Wrote Source\/Game\/A.cpp/);
  await assert.rejects(() => write.run({ path: "../evil.cpp", content: "x" }, {} as never));
  await assert.rejects(() => write.run({ path: "Content/Maps/x.umap", content: "x" }, {} as never));
  await assert.rejects(() => write.run({ path: "Source/run.bat", content: "x" }, {} as never));
});

test("loggedEngines reads install folders from the Epic launcher's log", async () => {
  const { loggedEngines } = await import("./unreal-install.js");
  const log = [
    "[x]LogCommunityPortalAppManager: PopulateInstallConfigFromCurrent: FINAL DestinationPath='E:\\EpicGames\\UE_5.8'",
    "[x]LogCommunityPortalAppManager: RequestAppInstall:     .DestinationPath: E:\\EpicGames\\UE_5.6\\UE_5.6",
    "[x] DestinationPath='E:\\EpicGames\\Fortnite\\Fortnite'",
  ].join("\n");
  assert.deepEqual(loggedEngines(log).map((e) => [e.version, e.path]), [["5.8", "E:\\EpicGames\\UE_5.8"], ["5.6", "E:\\EpicGames\\UE_5.6\\UE_5.6"]]);
});
