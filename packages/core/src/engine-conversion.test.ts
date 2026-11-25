import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxTaskView } from "@kesher/shared";
import { ConvertedCopies, extractCopy, hasLinks, parseTree, readConvertedMarker, readyCopies, revertConvertedCopy, writeConvertedMarker, type GitBytes, type ReadyCopy } from "./engine-conversion.js";
import { convertTask, parseConvertTitle } from "./engine-support.js";
import type { InstallJob } from "./unreal-install.js";

const COPY = "integrations/unity/com.kesherai.bridge-unity2020.3";

/** A finished inbox task, with only what the conversion reads. */
const task = (o: Partial<InboxTaskView>): InboxTaskView => ({ id: "r-1", title: "Convert the Unity package to Unity 2020.3.48f1", status: "done", branch: "agy/r-1-convert", runBy: "antigravity", files: [{ path: `${COPY}/package.json`, added: 3, removed: 1 }, { path: `${COPY}/CONVERTED.md`, added: 9, removed: 0 }], headSha: "a".repeat(40), endedAt: 10, ...o }) as InboxTaskView;

test("a convert task's title is read back, and only done tasks that changed only the copy are ready", () => {
  const t = convertTask({ engine: "unreal", version: "4.27" });
  assert.deepEqual(parseConvertTitle(t.title), { engine: "unreal", version: "4.27" });
  assert.equal(parseConvertTitle("Fix the build"), undefined);
  const ready = readyCopies([
    task({}),
    task({ id: "r-2", status: "partial" }),
    task({ id: "r-3", files: [{ path: "packages/core/x.ts", added: 1, removed: 0 }] }),
    task({ id: "r-4", files: [{ path: `${COPY}/a.cs`, added: 1, removed: 0 }, { path: "docs/x.md", added: 1, removed: 0 }] }),
    task({ id: "r-5", title: "Something else" }),
  ]);
  assert.equal(ready.length, 1);
  assert.deepEqual({ taskId: ready[0]!.taskId, filesChanged: ready[0]!.filesChanged, added: ready[0]!.added, removed: ready[0]!.removed, copy: ready[0]!.copy }, { taskId: "r-1", filesChanged: 2, added: 12, removed: 1, copy: COPY });
  assert.deepEqual(ready[0]!.files.map((f) => f.path), ["package.json", "CONVERTED.md"]);
  // A newer conversion for the same version replaces the older one.
  assert.equal(readyCopies([task({}), task({ id: "r-9", endedAt: 20 })])[0]!.taskId, "r-9");
});

test("the tree listing is parsed, odd entries are refused when a copy is read", async () => {
  assert.deepEqual(parseTree(`100644 blob ${"b".repeat(40)}     12\tx/a b.cs\0`), [{ mode: "100644", oid: "b".repeat(40), size: 12, path: "x/a b.cs" }]);
  const dir = await mkdtemp(join(tmpdir(), "kesher-conv-"));
  const sha = "c".repeat(40);
  const fake = (tree: string): GitBytes => async (_cwd, args) => {
    if (args[0] === "rev-parse") return { code: 0, out: Buffer.from(`${sha}\n`) };
    if (args[0] === "ls-tree") return { code: 0, out: Buffer.from(tree) };
    if (args[0] === "cat-file") return { code: 0, out: Buffer.from(`blob ${args[2]!.slice(0, 4)}`) };
    return { code: 1, out: Buffer.alloc(0) };
  };
  const line = (mode: string, path: string) => `${mode} blob ${"d".repeat(40)}      5\t${path}\0`;
  assert.equal(await extractCopy(fake(line("100644", `${COPY}/package.json`) + line("100755", `${COPY}/Editor/A.cs`)), "/repo", "agy/x", COPY, join(dir, "out")), sha);
  assert.equal(await readFile(join(dir, "out", "Editor", "A.cs"), "utf8"), "blob dddd");
  await assert.rejects(extractCopy(fake(line("120000", `${COPY}/link`)), "/repo", "x", COPY, join(dir, "o2")), /will not install/);
  await assert.rejects(extractCopy(fake(line("160000", `${COPY}/sub`)), "/repo", "x", COPY, join(dir, "o3")), /will not install/);
  await assert.rejects(extractCopy(fake(line("100644", `${COPY}/../../evil`)), "/repo", "x", COPY, join(dir, "o4")), /will not install/);
  await assert.rejects(extractCopy(fake(""), "/repo", "x", COPY, join(dir, "o5")), /no files/);
  await assert.rejects(extractCopy(async () => ({ code: 1, out: Buffer.alloc(0) }), "/repo", "x", COPY, join(dir, "o6")), /not found/);
  await assert.rejects(extractCopy(fake(""), "/repo", "x", "../x", join(dir, "o7")), /not valid/);
  assert.ok(!existsSync(join(dir, "o2")));
});

test("the marker is what makes a copy revertible: only a converted copy is removed", async () => {
  const project = await mkdtemp(join(tmpdir(), "kesher-conv-"));
  const pkg = join(project, "Packages", "com.kesherai.bridge");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), "{}");
  // KesherAI's own package has no marker: it stays.
  assert.equal(await revertConvertedCopy("unity", project), false);
  assert.ok(existsSync(pkg));
  await writeConvertedMarker(pkg, { taskId: "r-1", engine: "unity", version: "2020.3.48f1", sha: "a".repeat(40), at: 5 });
  assert.equal((await readConvertedMarker("unity", project))?.version, "2020.3.48f1");
  assert.equal(await revertConvertedCopy("unity", project), true);
  assert.ok(!existsSync(pkg));
  assert.equal(await readConvertedMarker("unreal", project), undefined);
});

test("a link inside a copy is found", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-conv-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "a.txt"), "x");
  assert.equal(await hasLinks(dir), false);
  try {
    await symlink(join(dir, "sub", "a.txt"), join(dir, "sub", "l"));
  } catch {
    t.skip("symlinks are not allowed here");
    return;
  }
  assert.equal(await hasLinks(dir), true);
});

const copyOf = (engine: "unity" | "unreal"): ReadyCopy => ({ taskId: "r-1", engine, version: engine === "unity" ? "2020.3.48f1" : "4.27", copy: COPY, branch: "agy/r-1-convert", sha: "e".repeat(40), filesChanged: 1, added: 1, removed: 0, files: [], runBy: "antigravity" });

/** A git that serves a one-file copy. */
const oneFileGit: GitBytes = async (_c, args) => (args[0] === "rev-parse" ? { code: 0, out: Buffer.from(`${"e".repeat(40)}\n`) } : args[0] === "ls-tree" ? { code: 0, out: Buffer.from(`100644 blob ${"f".repeat(40)}      2\t${COPY}/package.json\0`) } : { code: 0, out: Buffer.from("{}") });

test("install state machine, Unity: reading, installing, done; never twice at once; failures say why", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-conv-"));
  const project = await mkdtemp(join(tmpdir(), "kesher-proj-"));
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const c = new ConvertedCopies({
    repo: () => "/repo",
    git: oneFileGit,
    root,
    installUnity: async (p, source) => {
      calls.push(`unity ${source.endsWith("unity-r-1")}`);
      await gate;
      await mkdir(join(p, "Packages", "com.kesherai.bridge"), { recursive: true });
      return "Added.";
    },
    installUnreal: async () => undefined,
    unrealJob: () => undefined,
    now: () => 42,
  });
  assert.equal(c.current(), undefined);
  const first = c.install(copyOf("unity"), project);
  // The slow Windows runner may still be reading after 30 ms: wait for the step, up to 3 s.
  for (let i = 0; i < 100 && c.current()?.state !== "installing"; i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.current()?.state, "installing");
  await assert.rejects(c.install(copyOf("unity"), project), /being installed/);
  release();
  await first;
  assert.deepEqual({ state: c.current()?.state, message: c.current()?.message }, { state: "done", message: "Added." });
  assert.deepEqual(calls, ["unity true"]);
  assert.deepEqual(await readConvertedMarker("unity", project), { taskId: "r-1", engine: "unity", version: "2020.3.48f1", sha: "e".repeat(40), at: 42 });
  // A failure is kept, and the next press can try again.
  const bad = new ConvertedCopies({ repo: () => "/repo", git: async () => ({ code: 1, out: Buffer.alloc(0) }), root, installUnity: async () => "", installUnreal: async () => undefined, unrealJob: () => undefined });
  await assert.rejects(bad.install(copyOf("unity"), project), /not found/);
  assert.equal(bad.current()?.state, "failed");
  const none = new ConvertedCopies({ repo: () => undefined, git: oneFileGit, root, installUnity: async () => "", installUnreal: async () => undefined, unrealJob: () => undefined });
  await assert.rejects(none.install(copyOf("unity"), project), /source folder/);
});

test("install state machine, Unreal: follows the build job to done or failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-conv-"));
  let job: InstallJob | undefined;
  const given: Array<{ tag: string; version: string }> = [];
  const c = new ConvertedCopies({
    repo: () => "/repo",
    git: oneFileGit,
    root,
    installUnity: async () => "",
    installUnreal: async (_p, copy) => {
      given.push({ tag: copy.tag, version: copy.marker.version });
      job = { state: "building", project: "p", engine: "4.27", log: [] };
    },
    unrealJob: () => job,
  });
  await c.install(copyOf("unreal"), "D:/Projects/Old");
  assert.deepEqual(given, [{ tag: "eeeeeeee", version: "4.27" }]);
  assert.equal(c.current()?.state, "installing");
  assert.equal(c.current()?.project, "Old");
  job = { ...job!, state: "failed", message: "did not compile", errors: ["Source/A.cpp(1): error C1: x"] };
  assert.deepEqual({ s: c.current()?.state, e: c.current()?.errors }, { s: "failed", e: ["Source/A.cpp(1): error C1: x"] });
  await c.install(copyOf("unreal"), "D:/Projects/Old");
  job = { ...job!, state: "done", message: "Installed in X." };
  assert.deepEqual({ s: c.current()?.state, m: c.current()?.message }, { s: "done", m: "Installed in X." });
});

test("newestRef: a fix commit after the task's commit is used; a rewritten branch is not", async () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const make = (ancestor: boolean) => {
    const calls: string[][] = [];
    const git: GitBytes = async (_cwd, args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { code: 0, out: Buffer.from(`${B}\n`) };
      if (args[0] === "merge-base") return { code: ancestor ? 0 : 1, out: Buffer.alloc(0) };
      return { code: 0, out: Buffer.alloc(0) };
    };
    return { calls, copies: new ConvertedCopies({ repo: () => "/repo", git, root: "/r", installUnity: async () => "", installUnreal: async () => undefined, unrealJob: () => undefined }) };
  };
  const copy = { taskId: "r-1", engine: "unreal", version: "4.27", copy: "integrations/unreal/X", branch: "agy/r-1-x", sha: A } as unknown as ReadyCopy;
  const fixed = make(true);
  assert.equal(await fixed.copies.newestRef(copy), B);
  assert.equal(await fixed.copies.newestRef(copy), B);
  assert.equal(fixed.calls.filter((c) => c[0] === "fetch").length, 1, "fetched once per 10 minutes");
  assert.equal(await make(false).copies.newestRef(copy), A);
  assert.equal(await make(true).copies.newestRef({ ...copy, branch: "-x" }), A);
});
