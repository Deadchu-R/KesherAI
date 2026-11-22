import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain browser module (no types), shared by the 3D editor's page and this test
import { brushBox, classifyActor, levelFrame, unrealToThree } from "../../../plugins/model-editor/ui/unreal-frame.js";

type A = { id: string; name: string; class: string; position?: number[]; rotation?: number[]; scale?: number[]; mesh?: string; parent?: string; meshAt?: object; bounds?: object };
const at = (id: string, cls: string, position = [0, 0, 0], extra: Partial<A> = {}): A => ({ id, name: id, class: cls, position, rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...extra });
/** Every model is a 100 cm cube around its own origin (three.js space: 1 m). */
const cube = () => ({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
const near = (a: number[], b: number[]) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, `${a} vs ${b}`));

test("cm and Z up become metres and Y up", () => {
  near(unrealToThree([100, 200, 300], [0, 0, 0, 1], [1, 2, 3]).p, [1, 3, 2]);
  near(unrealToThree([0, 0, 0], [0.1, 0.2, 0.3, 0.9], [1, 2, 3]).s, [1, 3, 2]);
});

test("a model's box follows its position, scale and rotation", () => {
  const f = levelFrame([at("a", "StaticMeshActor", [1000, 0, 200], { mesh: "/Game/M" })], cube);
  near(f.box.min, [9.5, 1.5, -0.5]);
  near(f.box.max, [10.5, 2.5, 0.5]);
  // Scaled 4x in Unreal's X and turned 90 degrees about Z (up): the length lies along three.js's Z.
  const s = Math.SQRT1_2;
  const g = levelFrame([at("a", "StaticMeshActor", [0, 0, 0], { mesh: "/Game/M", scale: [4, 1, 1], rotation: [0, 0, s, s] })], cube);
  assert.ok(g.box.max[0] - g.box.min[0] < 1.01 && g.box.max[2] - g.box.min[2] > 3.9, JSON.stringify(g.box));
});

test("children sit inside their parent, a mesh component at its own offset", () => {
  const actors = [at("p", "Empty", [100, 0, 0], { scale: [2, 2, 2] }), at("c", "StaticMeshActor", [100, 0, 0], { mesh: "/Game/M", parent: "p", meshAt: { position: [0, 0, 100] } })];
  const f = levelFrame(actors, cube);
  // Parent at 1 m, the child 2 m further (the parent's scale) = 3 m; the offset up 1 m, doubled = 2 m.
  near(f.box.min, [2, 1, -1]);
  near(f.box.max, [4, 3, 1]);
});

test("the sky, fog, lights, markers, zero scale and a backdrop stay out of the box", () => {
  const actors = [
    at("floor", "StaticMeshActor", [0, 0, 0], { mesh: "/Game/Floor" }),
    at("sky", "BP_Sky_Sphere_C", [0, 0, 0], { mesh: "/Engine/Sphere" }),
    at("skyMesh", "StaticMeshActor", [0, 0, 0], { mesh: "/Game/SM_SkySphere" }),
    at("fog", "ExponentialHeightFog"),
    at("post", "PostProcessVolume"),
    at("sun", "DirectionalLight", [50000, 0, 90000]),
    at("start", "PlayerStart", [90000, 0, 0]),
    at("gone", "StaticMeshActor", [70000, 0, 0], { mesh: "/Game/M", scale: [1, 0, 1] }),
    at("dome", "StaticMeshActor", [0, 0, 0], { mesh: "/Game/Dome" }),
  ];
  const f = levelFrame(actors, (a: A) => (a.id === "dome" ? { min: [-6000, -6000, -6000], max: [6000, 6000, 6000] } : cube()));
  near(f.box.min, [-0.5, -0.5, -0.5]);
  near(f.box.max, [0.5, 0.5, 0.5]);
  assert.deepEqual(f.counts, { mesh: 2, brush: 0, light: 1, marker: 1, setting: 4, other: 0, hidden: 1 });
  assert.equal(classifyActor(actors[0]), "mesh");
});

test("a brush without bounds is a 2 m box, with bounds the bridge's box", () => {
  const f = levelFrame([at("Brush1", "Brush", [0, 0, 100])]);
  assert.equal(f.visual, true);
  near(f.box.min, [-1, 0, -1]);
  near(f.box.max, [1, 2, 1]);
  const b = brushBox(at("b", "Brush", [0, 0, 0], { bounds: { min: [-100, -200, 0], max: [100, 200, 300] } }));
  near(b.min, [-1, 0, -2]);
  near(b.max, [1, 3, 2]);
  assert.equal(b.approx, false);
});

test("a level with only lights and settings still frames its lights, and says it has no models", () => {
  const f = levelFrame([at("sun", "DirectionalLight", [0, 0, 1000]), at("sky", "SkyLight"), at("fog", "ExponentialHeightFog"), at("s", "PlayerStart", [500, 0, 0])]);
  assert.equal(f.visual, false);
  assert.ok(f.box);
  near(f.box.min, [-0.5, -0.5, -0.5]);
  near(f.box.max, [5.5, 10.5, 0.5]);
  const none = levelFrame([at("fog", "ExponentialHeightFog")]);
  assert.equal(none.box, null);
  assert.equal(none.visual, false);
});

test("a model that is not read yet adds no box, a parent loop does not hang", () => {
  const f = levelFrame([at("a", "StaticMeshActor", [0, 0, 0], { mesh: "/Game/M", parent: "b" }), at("b", "Empty", [0, 0, 0], { parent: "a" })]);
  assert.equal(f.box, null);
  assert.equal(f.visual, true);
});
