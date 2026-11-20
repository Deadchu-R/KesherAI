import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageFileOf, packageNameOf, parseUassetHeader, readUassetFile, uassetSummary } from "./uasset.js";
import { build, doorSpec, EDITOR_ONLY, W } from "./uasset-fake.test.js";

test("reads a UE5.3 Blueprint header: class, parent, exports, references, tags, thumbnail", () => {
  const h = parseUassetHeader(build(doorSpec(-8, 522, 1010)));
  assert.equal(h.ok, true);
  assert.deepEqual(h.problems, []);
  assert.equal(h.engine, "5.3.2");
  assert.equal(h.fileVersionUE5, 1010);
  assert.equal(h.unversioned, false);
  assert.deepEqual(h.exports.map((e) => [e.objectName, e.className, e.superName ?? ""]), [["BP_Door", "Blueprint", ""], ["BP_Door_C", "BlueprintGeneratedClass", "Actor"], ["Default__BP_Door_C", "BP_Door_C", ""]]);
  assert.deepEqual(h.hardPackages, ["/Script/Engine", "/Game/Props/SM_Door"]);
  assert.deepEqual(h.softPackages, ["/Game/Audio/S_Creak"]);
  assert.equal(h.thumbnails, 1);
  assert.equal(h.tags[0]?.tags.BlueprintType, "BPTYPE_Normal");
  assert.deepEqual(uassetSummary(h, "BP_Door"), { name: "BP_Door", className: "Blueprint", kind: "Blueprint", parent: "Actor" });
});

test("reads UE4.27, UE5.0 and UE5.4+ (saved hash, Verse cells) layouts", () => {
  for (const [legacy, ue4, ue5] of [[-7, 522, 0], [-8, 522, 1004], [-8, 522, 1012], [-8, 522, 1017]] as const) {
    const h = parseUassetHeader(build(doorSpec(legacy, ue4, ue5)));
    assert.equal(h.ok, true, `${ue4}/${ue5}`);
    assert.deepEqual(h.problems, [], `${ue4}/${ue5}`);
    assert.equal(uassetSummary(h, "BP_Door").parent, "Actor", `${ue4}/${ue5}`);
    assert.equal(h.hardPackages.length, 2);
  }
  assert.equal(parseUassetHeader(build(doorSpec(-7, 522, 0))).engine, "4.27.2");
});

test("an older UE4 file (4.20-ish, no package owner, FString soft refs before 514) still reads", () => {
  const spec = doorSpec(-7, 508, 0, { soft: [], tags: undefined });
  const h = parseUassetHeader(build(spec));
  assert.equal(h.ok, true);
  assert.deepEqual(h.problems, []);
  assert.equal(h.exports[1]?.superName, "Actor");
});

test("unversioned (cooked) packages: the layout is guessed from what makes sense", () => {
  for (const ue5 of [1004, 1009, 1012]) {
    const h = parseUassetHeader(build(doorSpec(-8, 522, ue5, { unversioned: true, flags: EDITOR_ONLY | 0x2000, tags: undefined })));
    assert.equal(h.ok, true);
    assert.equal(h.unversioned, true);
    assert.equal(h.cooked, true);
    assert.deepEqual(h.exports.map((e) => e.objectName), ["BP_Door", "BP_Door_C", "Default__BP_Door_C"], `ue5 ${ue5}`);
  }
});

test("a level: World is its class and the kind is level", () => {
  const names = ["/Script/Engine", "Package", "Class", "World", "Level", "L_Main", "PersistentLevel", "StaticMeshActor", "Rock_1"];
  const h = parseUassetHeader(build({ legacy: -8, ue4: 522, ue5: 1009, flags: 0x20000, names, imports: [[0, 1, 0, 0], [0, 2, -1, 3], [0, 2, -1, 4], [0, 2, -1, 7]], exports: [[-2, 0, 0, 5, true], [-3, 0, 1, 6, false], [-4, 0, 2, 8, false]] }));
  assert.equal(h.isMap, true);
  assert.deepEqual(uassetSummary(h, "L_Main"), { name: "L_Main", className: "World", kind: "level" });
  assert.equal(h.exports[2]?.objectName, "Rock_1");
});

test("names with numbers and UTF-16 names", () => {
  const spec = doorSpec(-8, 522, 1010);
  spec.names[7] = "BP_דלת";
  const h = parseUassetHeader(build(spec));
  assert.equal(h.exports[0]?.objectName, "BP_דלת");
});

test("not a package, byte-swapped, empty: ok false with a reason, no throw", () => {
  assert.equal(parseUassetHeader(new Uint8Array()).ok, false);
  assert.match(parseUassetHeader(Buffer.from("hello world, this is not a package at all")).error ?? "", /Not an Unreal package/);
  const swapped = new W().u32(0xc1832a9e).zeros(64).bytes();
  assert.match(parseUassetHeader(swapped).error ?? "", /byte-swapped/);
});

test("fuzz: every truncation and random corruption returns without throwing", () => {
  const good = build(doorSpec(-8, 522, 1010));
  for (let n = 0; n < good.length; n += 3) {
    const h = parseUassetHeader(good.subarray(0, n));
    assert.equal(typeof h.ok, "boolean");
    if (n < good.length) assert.ok(!h.ok || h.problems.length > 0 || h.exports.length === 3, `cut at ${n}`);
  }
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 3000; i++) {
    const b = Uint8Array.from(good);
    const hits = 1 + Math.floor(rnd() * 8);
    for (let j = 0; j < hits; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const h = parseUassetHeader(b);
    assert.ok(Array.isArray(h.exports));
  }
  for (let i = 0; i < 500; i++) {
    const b = new Uint8Array(Math.floor(rnd() * 2048));
    for (let j = 0; j < b.length; j++) b[j] = Math.floor(rnd() * 256);
    if (i % 2) b.set([0xc1, 0x83, 0x2a, 0x9e]);
    parseUassetHeader(b);
  }
});

test("readUassetFile reads only the header of a big file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-uasset-"));
  try {
    const head = build(doorSpec(-8, 522, 1012));
    const file = join(dir, "BP_Door.uasset");
    // The header, then 3 MB of "export data" that must not be needed.
    await writeFile(file, Buffer.concat([Buffer.from(head), Buffer.alloc(3 * 1024 * 1024, 7)]));
    const h = await readUassetFile(file, { maxBytes: 64 * 1024 });
    assert.equal(h.ok, true);
    assert.equal(h.size, head.length + 3 * 1024 * 1024);
    assert.equal(uassetSummary(h, "BP_Door").kind, "Blueprint");
    const missing = await readUassetFile(join(dir, "nope.uasset"));
    assert.equal(missing.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("package names and files", () => {
  assert.equal(packageNameOf("Content/Props/SM_Rock.uasset"), "/Game/Props/SM_Rock");
  assert.equal(packageNameOf("Source/X.cpp"), undefined);
  assert.equal(packageFileOf("/Game/Props/SM_Rock"), "Content/Props/SM_Rock");
  assert.equal(packageFileOf("/Script/Engine"), undefined);
  assert.equal(packageFileOf("/Game/../x"), undefined);
});
