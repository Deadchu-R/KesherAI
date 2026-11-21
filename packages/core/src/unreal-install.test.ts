import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BatchItem,
  type InstallJob,
  bridgeSource,
  prepareBuildFolder,
  runBatchItems,
  launcherEngines,
  readProject,
} from "./unreal-install.js";

test("launcherEngines reads the Epic Games Launcher's list, newest first", () => {
  const text = JSON.stringify({
    InstallationList: [
      {
        InstallLocation: "C:\\Program Files\\Epic Games\\UE_5.3",
        AppName: "UE_5.3",
      },
      {
        InstallLocation: "C:\\Program Files\\Epic Games\\Fortnite",
        AppName: "Fortnite",
      },
      { InstallLocation: "D:\\Epic\\UE_5.5", AppName: "UE_5.5" },
    ],
  });
  assert.deepEqual(
    launcherEngines(text).map((e) => e.version),
    ["5.5", "5.3"],
  );
  assert.deepEqual(launcherEngines("not json"), []);
});

test("readProject finds the .uproject and the engine it wants (a Blueprint-only project too)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ue-proj-"));
  await writeFile(
    join(dir, "Door.uproject"),
    "\uFEFF" +
      JSON.stringify({
        FileVersion: 3,
        EngineAssociation: "5.4",
        Category: "",
        Description: "",
      }),
  );
  const p = await readProject(dir);
  assert.equal(p.engine, "5.4");
  assert.equal(p.dir, dir);
  await assert.rejects(
    readProject(tmpdir() + "/nope-" + Date.now()),
    /No Unreal project/,
  );
});

test("the plugin's source is found in the repository", () => {
  assert.ok(bridgeSource());
});

test("setIniKey changes a key in its section, or adds it", async () => {
  const { setIniKey } = await import("./unreal-install.js");
  const ini =
    "[/Script/A]\nx=1\n\n[/Script/UnrealEd.ProjectPackagingSettings]\nbShareMaterialShaderCode=True\nbUseIoStore=True\n";
  const out = setIniKey(
    ini,
    "[/Script/UnrealEd.ProjectPackagingSettings]",
    "bShareMaterialShaderCode",
    "False",
  );
  assert.match(out, /bShareMaterialShaderCode=False\nbUseIoStore=True/);
  assert.match(out, /\[\/Script\/A\]\nx=1/);
  const added = setIniKey(
    out,
    "[/Script/UnrealEd.ProjectPackagingSettings]",
    "bSharedMaterialNativeLibraries",
    "False",
  );
  assert.match(
    added,
    /ProjectPackagingSettings\]\nbSharedMaterialNativeLibraries=False/,
  );
  assert.match(setIniKey("", "[/S]", "k", "v"), /\[\/S\]\nk=v/);
});

/** A build folder whose files are locked: `remove` rejects for the paths in `locked`, and records every try. */
function fakeFolders(locked: string[], existing: string[] = []) {
  const tries: string[] = [];
  let waits = 0;
  return {
    tries,
    waits: () => waits,
    deps: {
      remove: async (path: string) => {
        tries.push(path);
        if (locked.includes(path)) throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
      },
      exists: (path: string) => existing.includes(path),
      sleep: async () => {
        waits++;
      },
    },
  };
}

test("prepareBuildFolder: a folder that frees up within the tries is used as it is", async () => {
  let n = 0;
  const f = fakeFolders([]);
  const deps = { ...f.deps, remove: async (p: string) => { if (++n < 3) throw new Error("EPERM"); f.tries.push(p); } };
  assert.equal(await prepareBuildFolder("/b/5.4-0.1.28", 5, 1, deps), "/b/5.4-0.1.28");
  assert.equal(f.tries.length, 1);
});

test("prepareBuildFolder: a folder that stays locked is tried 5 times with waits, then a fresh sibling is used", async () => {
  const f = fakeFolders(["/b/5.4-0.1.28"]);
  assert.equal(await prepareBuildFolder("/b/5.4-0.1.28", 5, 1, f.deps), "/b/5.4-0.1.28-b2");
  assert.equal(f.tries.filter((p) => p === "/b/5.4-0.1.28").length, 5);
  assert.equal(f.waits(), 4);
});

test("prepareBuildFolder: a locked sibling is skipped for the next free one; all locked throws", async () => {
  const f = fakeFolders(["/b/x", "/b/x-b2"], ["/b/x-b2"]);
  assert.equal(await prepareBuildFolder("/b/x", 2, 1, f.deps), "/b/x-b3");
  const all = fakeFolders(["/b/y", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `/b/y-b${n}`)], [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `/b/y-b${n}`));
  await assert.rejects(prepareBuildFolder("/b/y", 1, 1, all.deps), /locked/);
});

const item = (name: string, engine?: string): BatchItem => ({ name, path: `/p/${name}`, ...(engine ? { engine } : {}), state: "queued" });

test("runBatchItems: after a failed build, the other projects on that engine fail at once with the first error, without building", async () => {
  const items = [item("a", "5.4"), item("b", "5.4"), item("c", "5.6"), item("d", "5.4")];
  const built: string[] = [];
  await runBatchItems(items, async (path) => {
    built.push(path);
    const engine = path.endsWith("/c") ? "5.6" : "5.4";
    if (engine === "5.6") return { state: "done", project: path, engine, log: [], message: "Installed" } satisfies InstallJob;
    return {
      state: "failed", project: path, engine, log: [], buildFailed: true,
      message: "The plugin did not compile for Unreal 5.4:\nSource\\Runtime\\Core\\X.h(31): error C4668: boom",
      errors: ["Source\\Runtime\\Core\\X.h(31): error C4668: boom"],
    } satisfies InstallJob;
  });
  assert.deepEqual(built, ["/p/a", "/p/c"]);
  assert.equal(items[0]!.state, "failed");
  assert.equal(items[1]!.state, "failed");
  assert.equal(items[1]!.message, "Build failed for 5.4: Source\\Runtime\\Core\\X.h(31): error C4668: boom");
  assert.equal(items[3]!.message, items[1]!.message);
  assert.equal(items[2]!.state, "done");
});

test("runBatchItems: a failure that is not the build (the copy) does not stop the next project of the same engine", async () => {
  const items = [item("a", "5.4"), item("b", "5.4")];
  const built: string[] = [];
  await runBatchItems(items, async (path) => {
    built.push(path);
    return { state: path.endsWith("/a") ? "failed" : "done", project: path, engine: "5.4", log: [], message: "in use" };
  });
  assert.deepEqual(built, ["/p/a", "/p/b"]);
  assert.equal(items[1]!.state, "done");
});
