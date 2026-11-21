import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertedCopyPath, convertTask, readUnityVersion, unitySupport, unrealSupport } from "./engine-support.js";
import { batchStateOf } from "./unreal-install.js";

test("engine versions: Unity 2021.3+ and Unreal 5.1+ supported; Unity 6 and Unreal 5.8 are 'full'; unknown is tried", () => {
  assert.deepEqual(unitySupport("2022.3.10f1"), { supported: true, known: true, full: false });
  assert.deepEqual(unitySupport("6000.2.0b6"), { supported: true, known: true, full: true });
  assert.equal(unitySupport("2021.3.0f1").supported, true);
  assert.equal(unitySupport("2021.2.19f1").supported, false);
  assert.equal(unitySupport("2019.4.40f1").supported, false);
  assert.deepEqual(unitySupport(undefined), { supported: true, known: false, full: false });
  assert.equal(unrealSupport("4.27").supported, false);
  assert.equal(unrealSupport("5.0").supported, false);
  for (const v of ["5.4", "5.6"]) assert.deepEqual(unrealSupport(v), { supported: true, known: true, full: false });
  assert.equal(unrealSupport("5.8").full, true);
  assert.equal(unrealSupport("{A1B2C3D4-0000}").supported, true, "a source build id is tried");
});

test("readUnityVersion: UTF-8, a byte-order mark, UTF-16, and missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-uver-"));
  await mkdir(join(dir, "ProjectSettings"));
  const file = join(dir, "ProjectSettings", "ProjectVersion.txt");
  await writeFile(file, "m_EditorVersion: 2022.3.16f1\nm_EditorVersionWithRevision: 2022.3.16f1 (abc)\n");
  assert.equal(await readUnityVersion(dir), "2022.3.16f1");
  await writeFile(file, "\uFEFFm_EditorVersion: 6000.2.0b6\r\n");
  assert.equal(await readUnityVersion(dir), "6000.2.0b6");
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("m_EditorVersion: 2022.3.12f1\r\n", "utf16le")]));
  assert.equal(await readUnityVersion(dir), "2022.3.12f1");
  assert.equal(await readUnityVersion(join(dir, "nothing")), undefined);
});

test("convertTask: a copy's folder only, the errors cut and without user paths, bad input refused", () => {
  const t = convertTask({ engine: "unreal", version: "4.27", project: "Old\nGame", errors: ["C:\\Users\\someone\\x.cpp(3): error C2039: 'Foo'", ...Array(30).fill("e")], executor: "local" });
  assert.equal(t.copy, "integrations/unreal/KesherAIBridge-ue4.27");
  assert.deepEqual(t.extraPaths, ["integrations/unreal/KesherAIBridge-ue4.27/**"]);
  assert.equal(t.executor, "local");
  assert.match(t.goal, /Do not change `integrations\/unreal\/KesherAIBridge\/`/);
  assert.match(t.goal, /may not work well/);
  assert.match(t.goal, /project "Old Game"/);
  assert.ok(!t.goal.includes("someone"), "no user name from a path");
  assert.equal(t.goal.split("\n").filter((l) => l.startsWith("- ")).length, 20);
  assert.equal(convertTask({ engine: "unity", version: "2020.3.48f1" }).executor, "antigravity");
  assert.equal(convertedCopyPath("unity", "2020.3.48f1"), "integrations/unity/com.kesherai.bridge-unity2020.3");
  assert.throws(() => convertTask({ engine: "unity", version: "../../x" }));
  assert.throws(() => convertTask({ engine: "godot" as "unity", version: "4.7" }));
});

test("install in all projects: already current is skipped, an old engine is offered conversion, the rest queued", () => {
  assert.equal(batchStateOf({ engine: "5.4", plugin: "0.1.28" }, "0.1.28"), "skipped");
  assert.equal(batchStateOf({ engine: "4.27", plugin: null }, "0.1.28"), "unsupported");
  assert.equal(batchStateOf({ engine: "5.8", plugin: "0.1.20" }, "0.1.28"), "queued");
  assert.equal(batchStateOf({ plugin: null }, "0.1.28"), "queued");
});
