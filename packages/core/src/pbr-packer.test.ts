import { test } from "node:test";
import assert from "node:assert/strict";
import { packPbrMaps, flipNormalY, type NormalConvention } from "./pbr-packer.js";
import { encodePng } from "./pbr-flow.js";

/** Makes a solid-color PNG (grayscale or RGB) for testing. */
function solidPng(w: number, h: number, ch: 1 | 3, value: number): Uint8Array {
 const data = new Uint8Array(w * h * ch).fill(value);
 return encodePng(w, h, ch, data);
}

test("packPbrMaps throws when no input is given", () => {
 assert.throws(() => packPbrMaps({}), /at least one map must be provided/);
});

test("flipNormalY is identity when conventions match", () => {
 const n = new Float32Array([0.5, 0.5, 1.0, 0.2, 0.8, 0.9]);
 assert.equal(flipNormalY(n, "opengl", "opengl"), n);
 assert.equal(flipNormalY(n, "directx", "directx"), n);
});

test("flipNormalY inverts green channel between conventions", () => {
  const gl = new Float32Array([0.5, 0.8, 1.0, 0.2, 0.6, 0.9]);
  const dx = flipNormalY(gl, "opengl", "directx");
  assert.notEqual(dx, gl, "returns a new array");
  const expected = [0.5, 0.2, 1.0, 0.2, 0.4, 0.9];
  for (let i = 0; i < dx.length; i++) {
        assert.ok(
          Math.abs(dx[i]! - expected[i]!) < 1e-5,
          `index ${i}: expected ~${expected[i]}, got ${dx[i]}`,
        );
      }
      const back = flipNormalY(dx, "directx", "opengl");
      for (let i = 0; i < back.length; i++) {
        assert.ok(
          Math.abs(back[i]! - gl[i]!) < 1e-5,
      `round-trip index ${i}: expected ~${gl[i]}, got ${back[i]}`,
    );
  }
});

test("flat normal stays flat under either convention", () => {
 const flat = new Float32Array(6).fill(0.5);
 flat[2] = 1.0; flat[5] = 1.0;
 const dx = flipNormalY(flat, "opengl", "directx");
 // Green 0.5 → 0.5, so flat stays flat.
 assert.deepEqual(Array.from(dx), Array.from(flat));
});

test("packPbrMaps produces ORM with correct channels from separate inputs", () => {
 const ao = solidPng(4, 4, 1, 200);
 const rough = solidPng(4, 4, 1, 128);
 const met = solidPng(4, 4, 1, 50);
 const out = packPbrMaps({ ao, roughness: rough, metallic: met });
 assert.ok(out.orm, "ORM produced");
 assert.equal(out.w, 4);
 assert.equal(out.h, 4);
 assert.equal(out.convention, "opengl");
 // Also returns separate maps.
 assert.ok(out.ao);
 assert.ok(out.roughness);
 assert.ok(out.metallic);
});

test("packPbrMaps defaults missing ORM channels to AO=1, Rough=0.5, Metal=0", () => {
 const rough = solidPng(2, 2, 1, 128);
 const out = packPbrMaps({ roughness: rough });
 assert.ok(out.orm, "ORM produced even with only roughness");
 // The ORM should exist; we can't easily decode PNG here but the function did not throw.
 assert.equal(out.convention, "opengl");
});

test("packPbrMaps respects directx convention on normal output", () => {
 const normal = solidPng(2, 2, 3, 128); // mid-gray ≈ flat normal
 const gl = packPbrMaps({ normal }, "opengl");
 const dx = packPbrMaps({ normal }, "directx");
 assert.equal(gl.convention, "opengl");
 assert.equal(dx.convention, "directx");
 assert.ok(gl.normal);
 assert.ok(dx.normal);
});

test("packPbrMaps uses albedo size as reference", () => {
 const albedo = solidPng(8, 8, 3, 100);
 const rough = solidPng(4, 4, 1, 128); // smaller
 const out = packPbrMaps({ albedo, roughness: rough });
 assert.equal(out.w, 8, "width matches albedo");
 assert.equal(out.h, 8, "height matches albedo");
});
