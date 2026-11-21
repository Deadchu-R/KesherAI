import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSymlink, NO_SYMLINK } from "./test-utils.js";
import { GameCheckpoints, insideProject, pruneList, realInside, type GameCheckpoint } from "./game-checkpoints.js";

const meta = (project: string, group: string) => ({ engine: "unity" as const, project, name: "Demo", source: "chat" as const, label: "make the door open", group });

test("one checkpoint per group keeps each file's first state, binaries too, and restores them", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-gcp-"));
  try {
    const project = join(root, "Demo");
    await mkdir(join(project, "Assets"), { recursive: true });
    await writeFile(join(project, "Assets", "Door.cs"), "class Door {}\n");
    await writeFile(join(project, "Assets", "Door.prefab"), Buffer.from([0, 1, 2, 3]));
    const store = new GameCheckpoints(() => join(root, "store"));
    const a = await store.capture(meta(project, "chat:c1:t1"), [join(project, "Assets", "Door.cs"), "Assets/Door.prefab", "Assets/New.cs"]);
    assert.equal(a?.created, true);
    assert.equal(a?.checkpoint.files.length, 3);
    // The tool writes; a second write in the same turn does not replace the first copy.
    await writeFile(join(project, "Assets", "Door.cs"), "class Door { void Open() {} }\n");
    await writeFile(join(project, "Assets", "Door.prefab"), Buffer.from([9, 9]));
    await writeFile(join(project, "Assets", "New.cs"), "class New {}\n");
    const b = await store.capture(meta(project, "chat:c1:t1"), ["Assets/Door.cs"]);
    assert.equal(b?.created, false);
    assert.equal((await store.list(project)).length, 1);

    const diff = await store.compare(a!.checkpoint.id, "Assets/Door.cs");
    assert.equal(diff.binary, false);
    assert.equal(diff.before, "class Door {}\n");
    assert.equal((await store.compare(a!.checkpoint.id, "Assets/Door.prefab")).binary, true);

    const r = await store.restore(a!.checkpoint.id);
    assert.equal(r.restored, 3);
    assert.equal(await readFile(join(project, "Assets", "Door.cs"), "utf8"), "class Door {}\n");
    assert.deepEqual([...(await readFile(join(project, "Assets", "Door.prefab")))], [0, 1, 2, 3]);
    assert.equal(existsSync(join(project, "Assets", "New.cs")), false);
    // The restore is itself undoable.
    assert.equal(r.before?.source, "restore");
    assert.equal((await store.list(project)).length, 2);
    assert.ok((await store.usage()).bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files outside the project are never kept", () => {
  assert.throws(() => insideProject("/p/Demo", "../other/x.cs"));
  assert.throws(() => insideProject("/p/Demo", "/etc/passwd"));
  assert.equal(insideProject("/p/Demo", "Assets/x.cs").rel, "Assets/x.cs");
});

test("prune drops old ones, then the oldest until the size fits, keeping the newest", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-11-20T00:00:00Z");
  const cp = (id: string, ageDays: number, size: number): GameCheckpoint => ({ id, engine: "unreal", project: "/p", name: "p", source: "sync", label: id, group: id, at: new Date(now - ageDays * day).toISOString(), files: [{ rel: `${id}.uasset`, size, blob: id }] });
  const list = [cp("old", 40, 10), cp("a", 3, 600 * 1024 * 1024), cp("b", 2, 600 * 1024 * 1024), cp("c", 1, 100)];
  assert.deepEqual(pruneList(list, { days: 30, maxMB: 1000 }, now).map((c) => c.id), ["b", "c"]);
  assert.deepEqual(pruneList([cp("big", 1, 5e9)], { days: 30, maxMB: 1 }, now).map((c) => c.id), ["big"]);
});

test("a chat turn's engine writes share one checkpoint; reads and unnamed writes keep nothing", async () => {
  const { engineWrites, withCheckpoints } = await import("./chat-tools-games.js");
  const dirs = { unity: "/p/U", unreal: "/p/R", godot: "/p/G" };
  assert.deepEqual(engineWrites("unreal_change_graph", { path: "/Game/Doors/BP_Door.BP_Door" }, dirs)?.files, [join("/p/R", "Content", "Doors", "BP_Door.uasset")]);
  assert.deepEqual(engineWrites("godot_file", { action: "write", file: "res://player.gd" }, dirs)?.files, [join("/p/G", "player.gd")]);
  assert.equal(engineWrites("godot_file", { action: "read", file: "res://player.gd" }, dirs), undefined);
  assert.equal(engineWrites("unity_scene", { action: "save" }, dirs), undefined);
  assert.equal(engineWrites("unity_write_script", { path: "Assets/A.cs" }, {}), undefined);

  const root = await mkdtemp(join(tmpdir(), "kesher-gcp-"));
  try {
    const project = join(root, "U");
    await mkdir(join(project, "Assets"), { recursive: true });
    await writeFile(join(project, "Assets", "A.cs"), "a");
    const store = new GameCheckpoints(() => join(root, "store"));
    const made: string[] = [];
    const tool = (name: string, risk: "read" | "write") => ({ risk, spec: { name, description: "", inputSchema: { type: "object" } }, run: async () => ({ output: "ok" }) });
    const [w, r] = withCheckpoints([tool("unity_write_script", "write"), tool("unity_read_script", "read")], { store, chatId: "c1", dirs: () => ({ unity: project }), turn: () => ({ id: "t1", label: "fix A" }), onCreated: (id) => made.push(id) });
    const ctx = {} as Parameters<typeof w.run>[1];
    await w!.run({ path: "Assets/A.cs" }, ctx);
    await w!.run({ path: "Assets/B.cs" }, ctx);
    await r!.run({ path: "Assets/A.cs" }, ctx);
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(made.length, 1);
    assert.deepEqual(list[0]!.files.map((f) => f.rel), ["Assets/A.cs", "Assets/B.cs"]);
    assert.equal(list[0]!.chatId, "c1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a link put in the project is never copied, read or written through (scan 168)", { skip: !(await canSymlink()) && NO_SYMLINK }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-gcp-"));
  try {
    const project = join(root, "Demo");
    const outside = join(root, "outside");
    await mkdir(join(project, "Assets"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.cs"), "secret\n");
    await writeFile(join(project, "Assets", "Door.cs"), "class Door {}\n");
    await symlink(join(outside, "secret.cs"), join(project, "Assets", "Link.cs"));
    await symlink(outside, join(project, "Assets", "Out"));
    await assert.rejects(realInside(project, join(project, "Assets", "Link.cs")));
    await assert.rejects(realInside(project, join(project, "Assets", "Out", "new.cs")));
    await realInside(project, join(project, "Assets", "Door.cs"));
    await realInside(project, join(project, "Assets", "Sub", "new.cs"));
    const store = new GameCheckpoints(() => join(root, "store"));
    const a = await store.capture(meta(project, "g1"), ["Assets/Door.cs", "Assets/Link.cs"]);
    assert.deepEqual(a?.checkpoint.files.map((f) => f.rel), ["Assets/Door.cs"]);
    // Door.cs becomes a link out of the project after the checkpoint: the restore skips it, the outside file stays.
    await rm(join(project, "Assets", "Door.cs"));
    await symlink(join(outside, "secret.cs"), join(project, "Assets", "Door.cs"));
    await assert.rejects(store.compare(a!.checkpoint.id, "Assets/Door.cs"));
    const r = await store.restore(a!.checkpoint.id);
    assert.equal(r.restored, 0);
    assert.equal(r.skipped, 1);
    assert.equal(await readFile(join(outside, "secret.cs"), "utf8"), "secret\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prune counts a content shared by checkpoints once, until the last one using it goes", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const mb = 1024 * 1024;
  const cp = (id: string, blobs: Array<[string, number]>): GameCheckpoint => ({ id, engine: "unity", project: "/p", name: "p", source: "chat", label: id, group: id, at: new Date(now - 1000).toISOString(), files: blobs.map(([b, size]) => ({ rel: `${b}.prefab`, size, blob: b })) });
  // 160 MB in all; x (60 MB) is shared by a and b, so dropping a frees only y: 100 MB, still over 90, so b goes too.
  const list = [cp("a", [["x", 60 * mb], ["y", 60 * mb]]), cp("b", [["x", 60 * mb]]), cp("c", [["z", 40 * mb]])];
  assert.deepEqual(pruneList(list, { days: 30, maxMB: 90 }, now).map((c) => c.id), ["c"]);
  assert.deepEqual(pruneList(list, { days: 30, maxMB: 110 }, now).map((c) => c.id), ["b", "c"]);
});
