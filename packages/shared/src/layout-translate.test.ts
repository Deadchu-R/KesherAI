import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  unityToUnreal,
  unrealToUnity,
  parseUnityLayout,
  parseUnrealLayout,
  type UnityLayout,
  type UnrealLayout,
} from "./layout-translate.js";

describe("layout-translate", () => {
  const u: UnityLayout = {
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 10, y: 20, z: 30 },
    scale: { x: 1, y: 1, z: 1 },
  };

  test("unityToUnreal swaps Y/Z on position and maps euler to pitch/yaw/roll", () => {
    const r = unityToUnreal(u);
    assert.deepEqual(r.location, { x: 1, y: 3, z: 2 });
    assert.deepEqual(r.rotation, { pitch: 10, yaw: 20, roll: 30 });
    assert.deepEqual(r.scale, { x: 1, y: 1, z: 1 });
  });

  test("unrealToUnity is the inverse of unityToUnreal for the preview subset", () => {
    const r: UnrealLayout = unityToUnreal(u);
    const back = unrealToUnity(r);
    assert.deepEqual(back.position, u.position);
    assert.deepEqual(back.rotation, u.rotation);
    assert.deepEqual(back.scale, u.scale);
  });

  test("parseUnityLayout accepts localPosition/localRotation/localScale aliases", () => {
    const got = parseUnityLayout({
      localPosition: { x: 4, y: 5, z: 6 },
      localRotation: { x: 40, y: 50, z: 60 },
      localScale: { x: 2, y: 2, z: 2 },
    });
    assert.ok(got);
    assert.deepEqual(got.position, { x: 4, y: 5, z: 6 });
    assert.deepEqual(got.rotation, { x: 40, y: 50, z: 60 });
    assert.deepEqual(got.scale, { x: 2, y: 2, z: 2 });
  });

  test("parseUnityLayout returns undefined when position is missing", () => {
    assert.equal(parseUnityLayout({ rotation: { x: 0, y: 0, z: 0 } }), undefined);
    assert.equal(parseUnityLayout(null), undefined);
  });

  test("parseUnrealLayout accepts Location/Rotation/Scale capitalised keys", () => {
    const got = parseUnrealLayout({
      Location: { x: 7, y: 8, z: 9 },
      Rotation: { Pitch: 15, Yaw: 25, Roll: 35 },
      Scale: { x: 3, y: 3, z: 3 },
    });
    assert.ok(got);
    assert.deepEqual(got.location, { x: 7, y: 8, z: 9 });
    assert.deepEqual(got.rotation, { pitch: 15, yaw: 25, roll: 35 });
    assert.deepEqual(got.scale, { x: 3, y: 3, z: 3 });
  });

  test("parseUnrealLayout defaults rotation and scale when absent", () => {
    const got = parseUnrealLayout({ location: { x: 1, y: 2, z: 3 } });
    assert.ok(got);
    assert.deepEqual(got.rotation, { pitch: 0, yaw: 0, roll: 0 });
    assert.deepEqual(got.scale, { x: 1, y: 1, z: 1 });
  });
});