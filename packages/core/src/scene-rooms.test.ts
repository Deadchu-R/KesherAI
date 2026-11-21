import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSymlink } from "./test-utils.js";
import { BeatLimit, MAX_GUESTS, MAX_MEMBERS, roomKey, SceneRooms } from "./scene-rooms.js";

test("each member sees the others with their own colour, camera and selection; checked and bounded", () => {
  const r = new SceneRooms();
  const a = r.beat("s", "a", "PC", { camera: { p: [0, 1, 5], t: [0, 0, 0], fov: 50 }, selection: ["./Box"] }, 1000);
  assert.deepEqual(a, { others: [], joined: true });
  const b = r.beat("s", "b", "Phone", { camera: { p: ["x", 0, 0], t: [0, 0, 0], fov: 50 }, selection: [1, "./Lamp"] }, 1500);
  assert.ok("others" in b);
  assert.equal(b.others.length, 1);
  assert.deepEqual(b.others[0]!.camera, { p: [0, 1, 5], t: [0, 0, 0], fov: 50 });
  assert.deepEqual(b.others[0]!.selection, ["./Box"]);
  const again = r.beat("s", "a", "PC", {}, 2000);
  assert.ok("others" in again);
  const phone = again.others[0]!;
  assert.equal(phone.camera, undefined); // a camera with a bad number is dropped
  assert.deepEqual(phone.selection, ["./Lamp"]);
  assert.notEqual(phone.colour, b.others[0]!.colour); // two people, two colours
});

test("members leave when not heard from, rooms are separate, and a room holds twelve at most", () => {
  const r = new SceneRooms();
  r.beat("s", "a", "PC", {}, 0);
  r.beat("other", "x", "PC", {}, 0);
  const late = r.beat("s", "b", "Phone", {}, 10_000);
  assert.ok("others" in late);
  assert.equal(late.others.length, 0); // "a" went quiet
  for (let i = 0; i < MAX_MEMBERS - 1; i++) r.beat("full", `m${i}`, "x", {}, 20_000);
  assert.ok("others" in r.beat("full", "last", "x", {}, 20_000));
  assert.ok("error" in r.beat("full", "one-more", "x", {}, 20_000));
  r.leave("full", "last");
  assert.ok("others" in r.beat("full", "one-more", "x", {}, 20_000));
});

test("guests: join only where the owner is, at most six, a read guest's selection dropped, opaque ids, kicked at once", () => {
  const r = new SceneRooms();
  // Alone, a guest cannot open the room.
  const alone = r.beat("s", "g1:t", "Dani", {}, 0, "read");
  assert.ok("error" in alone && alone.code === "not-open");
  assert.equal(r.open("s", 0), false);
  r.beat("s", "pc:t", "PC", { selection: ["./Box"] }, 0);
  assert.equal(r.open("s", 0), true);
  const g = r.beat("s", "g1:t", "Dani", { selection: ["./Lamp"] }, 100, "read");
  assert.ok("others" in g);
  assert.equal(g.joined, true);
  assert.equal(g.others.length, 1);
  assert.doesNotMatch(g.others[0]!.id, /pc/); // never the owner's device id
  assert.match(g.others[0]!.id, /^[0-9a-f]{16}$/);
  const owner = r.beat("s", "pc:t", "PC", {}, 200);
  assert.ok("others" in owner);
  assert.equal(owner.joined, false);
  assert.equal(owner.others[0]!.guest, true);
  assert.deepEqual(owner.others[0]!.selection, []); // read: seen, but chooses nothing for the others
  const e = r.beat("s", "g2:t", "Noa", { selection: ["./Lamp"] }, 300, "edit");
  assert.ok("others" in e);
  const seen = r.beat("s", "pc:t", "PC", {}, 400);
  assert.ok("others" in seen);
  assert.deepEqual(seen.others.find((m) => m.name === "Noa")!.selection, ["./Lamp"]); // edit: may select
  // Six guests at most; the seventh is refused.
  for (let i = 3; i <= MAX_GUESTS; i++) assert.ok("others" in r.beat("s", `g${i}:t`, "x", {}, 500, "read"));
  const seventh = r.beat("s", "g7:t", "x", {}, 500, "read");
  assert.ok("error" in seventh && seventh.code === "full");
  // Remove / Ban: gone now, in every room.
  assert.equal(r.kick("g1"), 1);
  const after = r.beat("s", "pc:t", "PC", {}, 600);
  assert.ok("others" in after);
  assert.equal(after.others.some((m) => m.name === "Dani"), false);
  // The owner leaves: the guests cannot stay alone.
  r.leave("s", "pc:t");
  const left = r.beat("s", "g2:t", "Noa", {}, 700, "edit");
  assert.ok("error" in left && left.code === "not-open");
});

test("the owner's devices always get a seat: the guest who came last makes room", () => {
  const r = new SceneRooms();
  for (let i = 0; i < MAX_MEMBERS - MAX_GUESTS; i++) r.beat("s", `own${i}:t`, "PC", {}, 0);
  for (let i = 0; i < MAX_GUESTS; i++) r.beat("s", `g${i}:t`, "Guest", {}, 0, "read");
  const mine = r.beat("s", "phone:t", "Phone", {}, 10);
  assert.ok("others" in mine);
  assert.equal(mine.others.filter((m) => m.guest).length, MAX_GUESTS - 1);
});

test("beats: two a second each, apart for each guest", () => {
  const l = new BeatLimit(2);
  assert.equal(l.allow("a", 0), true);
  assert.equal(l.allow("a", 100), true);
  assert.equal(l.allow("a", 200), false);
  assert.equal(l.allow("b", 200), true);
  assert.equal(l.allow("a", 1100), true);
});

test("a room's key is the same however the folder is written (project.godot, a link), and differs by scene", async () => {
  const links = await canSymlink();
  const root = await mkdtemp(join(tmpdir(), "kesher-rooms-"));
  const dir = join(root, "game");
  await mkdir(dir);
  await writeFile(join(dir, "project.godot"), "");
  if (links) await symlink(dir, join(root, "link"));
  const k = await roomKey(`godot|${dir}|res://a.tscn`);
  assert.equal(await roomKey(`godot|${join(dir, "project.godot")}|res://a.tscn`), k);
  assert.equal(await roomKey(`godot|${dir}/|res://a.tscn`), k);
  if (links) assert.equal(await roomKey(`godot|${join(root, "link")}|res://a.tscn`), k);
  assert.notEqual(await roomKey(`godot|${dir}|res://b.tscn`), k);
  assert.match(await roomKey("unreal||/Game/Map"), /^[0-9a-f]{32}$/);
});
