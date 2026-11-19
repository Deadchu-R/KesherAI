import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MEMBERS, SceneRooms } from "./scene-rooms.js";

test("each member sees the others with their own colour, camera and selection; checked and bounded", () => {
  const r = new SceneRooms();
  const a = r.beat("s", "a", "PC", { camera: { p: [0, 1, 5], t: [0, 0, 0], fov: 50 }, selection: ["./Box"] }, 1000);
  assert.deepEqual(a, { others: [] });
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
