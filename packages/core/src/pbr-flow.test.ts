import { test } from "node:test";
import assert from "node:assert/strict";
import { albedoGraph, deriveMaps, encodePng, materialName, pickCheckpoint, readPicture, samplerFor, SEAM_LIMIT, seamFixGraph, seamScore, wrapBlur, type Picture } from "./pbr-flow.js";

/** A tiling RGB picture (sines with whole periods) and one with a hard seam (a ramp). */
function tilingPicture(w = 64, h = 64): Picture {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 128 + 60 * Math.sin((2 * Math.PI * x * 3) / w) + 40 * Math.cos((2 * Math.PI * y * 2) / h);
    data.set([v, v * 0.8, v * 0.6], (y * w + x) * 3);
  }
  return { w, h, ch: 3, data };
}
function seamPicture(w = 64, h = 64): Picture {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.round((x / w) * 200 + (y / h) * 50), (y * w + x) * 3, (y * w + x) * 3 + 3);
  return { w, h, ch: 3, data };
}

test("PNG round trip: grey, RGB and RGBA", () => {
  for (const ch of [1, 3, 4] as const) {
    const data = Uint8Array.from({ length: 5 * 3 * ch }, (_, i) => (i * 37) % 256);
    const back = readPicture(encodePng(5, 3, ch, data))!;
    assert.deepEqual([back.w, back.h, back.ch], [5, 3, ch]);
    assert.deepEqual([...back.data], [...data]);
  }
  assert.equal(readPicture(new Uint8Array([1, 2, 3])), undefined);
});

test("the seam check tells a tiling picture from one with a seam", () => {
  assert.ok(seamScore(tilingPicture()) < SEAM_LIMIT, String(seamScore(tilingPicture())));
  assert.ok(seamScore(seamPicture()) > SEAM_LIMIT, String(seamScore(seamPicture())));
});

test("the wrap blur keeps a flat picture flat and wraps around the edges", () => {
  const flat = new Float32Array(16).fill(10);
  assert.ok(wrapBlur(flat, 4, 4, 1).every((v) => Math.abs(v - 10) < 1e-4));
  const spot = new Float32Array(16);
  spot[0] = 9;
  const b = wrapBlur(spot, 4, 4, 1);
  // The corner's neighbours across the edges get their share.
  assert.ok(Math.abs(b[3]! - 1) < 1e-4 && Math.abs(b[15]! - 1) < 1e-4 && Math.abs(b[5]! - 1) < 1e-4);
});

test("maps from an albedo: flat gives a straight-up normal; slopes tilt it the OpenGL way; maps tile", () => {
  const flat = deriveMaps({ w: 8, h: 8, ch: 3, data: new Uint8Array(8 * 8 * 3).fill(120) });
  const n = readPicture(flat.normal)!;
  assert.equal(n.ch, 3);
  assert.deepEqual([...n.data.slice(0, 3)], [128, 128, 255]);
  for (const k of ["roughness", "ao", "height"] as const) assert.equal(readPicture(flat[k])!.ch, 1);
  assert.equal(readPicture(flat.ao)!.data[0], 255, "nothing lies below a flat surface");
  // A horizontal ridge of light in the middle: left of it the height rises to the right → normal leans left (red < 128).
  const w = 32;
  const ridge = new Uint8Array(w * 4 * 3);
  for (let y = 0; y < 4; y++) for (let x = 0; x < w; x++) ridge.fill(Math.round(255 * Math.max(0, 1 - Math.abs(x - 16) / 8)), (y * w + x) * 3, (y * w + x) * 3 + 3);
  const nm = readPicture(deriveMaps({ w, h: 4, ch: 3, data: ridge }).normal)!;
  assert.ok(nm.data[(w + 12) * 3]! < 128 && nm.data[(w + 20) * 3]! > 128);
  // Derived maps of a tiling albedo tile too.
  const maps = deriveMaps(tilingPicture());
  for (const k of ["normal", "roughness", "ao", "height"] as const) assert.ok(seamScore(readPicture(maps[k])!) < SEAM_LIMIT, k);
});

test("checkpoints: the active one, else an SDXL-sized picture model; never music, video or 3D", () => {
  const list = ["ace_step_1.5_turbo_aio.safetensors", "music\\ace.safetensors", "wan2.2_ti2v_5B.safetensors", "sd15.safetensors", "juggernautXL.safetensors"];
  assert.equal(pickCheckpoint(list), "juggernautXL.safetensors");
  assert.equal(pickCheckpoint(list, "sd15.safetensors"), "sd15.safetensors");
  assert.equal(pickCheckpoint(list, "wan2.2_ti2v_5B.safetensors"), "juggernautXL.safetensors");
  assert.equal(pickCheckpoint(["ace_step.safetensors"]), undefined);
  assert.deepEqual(samplerFor("flux1-schnell-fp8.safetensors"), { size: 1024, steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" });
  assert.equal(samplerFor("sd15.safetensors").size, 512);
  assert.equal(samplerFor("sdxl_lightning.safetensors").steps, 8);
});

test("the albedo graph tiles in the model when ComfyUI has the nodes, plain otherwise", () => {
  const tiled = albedoGraph({ ckpt: "x.safetensors", prompt: "red brick", count: 9, tiling: true, seed: 1 });
  assert.equal(tiled["2"]!.class_type, "SeamlessTile");
  assert.deepEqual(tiled["6"]!.inputs.model, ["2", 0]);
  assert.equal(tiled["7"]!.class_type, "CircularVAEDecode");
  assert.equal(tiled["5"]!.inputs.batch_size, 4);
  assert.match(String(tiled["3"]!.inputs.text), /^red brick, seamless tileable texture/);
  const plain = albedoGraph({ ckpt: "x.safetensors", prompt: "red brick", count: 1, tiling: false, seed: 1 });
  assert.equal(plain["2"], undefined);
  assert.equal(plain["7"]!.class_type, "VAEDecode");
  assert.deepEqual(plain["6"]!.inputs.model, ["1", 0]);
});

test("the seam fix graph moves the picture by half and paints over the middle cross only", () => {
  const g = seamFixGraph({ image: "a.png", w: 512, h: 256, ckpt: "x", prompt: "p", seed: 2 });
  assert.equal(g["10"]!.inputs.image, "a.png");
  // The bottom-right quarter goes to the top-left corner, and so on.
  assert.deepEqual([g["11"]!.inputs.x, g["11"]!.inputs.y, g["15"]!.inputs.x, g["15"]!.inputs.y], [256, 128, 0, 0]);
  assert.deepEqual([g["14"]!.inputs.x, g["14"]!.inputs.y, g["18"]!.inputs.x, g["18"]!.inputs.y], [0, 0, 256, 128]);
  assert.equal(g["23"]!.inputs.x, 256 - 32 / 2);
  assert.equal(g["24"]!.inputs.y, 128 - 32 / 2);
  assert.deepEqual(g["29"]!.inputs.mask, ["28", 0], "the rest stays pixel for pixel");
  // Only ComfyUI's own nodes.
  for (const n of Object.values(g)) assert.doesNotMatch(n.class_type, /Seamless|Circular/);
});

test("a material's name from the request", () => {
  assert.equal(materialName("a seamless weathered red brick wall texture"), "Weathered Red Brick");
  assert.equal(materialName("!!"), "Texture");
});
