import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHONES, chosenPhones, gpuFamilyOf, guessTier, maxFps, parseGetprop, phoneFromProps, phoneNote, summarize, targetFps, unityFrameRateScript } from "./phones.js";
import { createKesherServer } from "./server.js";

test("target phones: what a set has in common, the brief, and the frame rate", () => {
  const set = chosenPhones(["oneplus-13", "samsung-a35", "nope"], []);
  assert.deepEqual(set.map((p) => p.id), ["oneplus-13", "samsung-a35"]);
  const s = summarize(set);
  assert.equal(s.weakestTier, "mid");
  assert.deepEqual(s.gpuFamilies.sort(), ["adreno", "mali"]);
  assert.equal(targetFps(set), 60);
  assert.equal(targetFps(chosenPhones(["oneplus-13", "samsung-s25"], [])), 120);
  assert.equal(targetFps(chosenPhones(["samsung-a15"], [])), 30);
  const note = phoneNote(set);
  assert.match(note, /OnePlus 13/);
  assert.match(note, /Weakest is mid/);
  assert.ok(note.length < 900, "the brief stays short (it goes with every message)");
  assert.equal(phoneNote([]), "");
  assert.match(unityFrameRateScript(set), /Application\.targetFrameRate = .*60/);
  assert.equal(new Set(PHONES.map((p) => p.id)).size, PHONES.length, "ids are unique");
});

test("a phone read over USB: getprop, screen, GPU, refresh rate", () => {
  const props = parseGetprop("[ro.product.manufacturer]: [OnePlus]\n[ro.product.model]: [CPH2653]\n[ro.product.marketname]: [OnePlus 13]\n[ro.soc.model]: [SM8750]\n[ro.build.version.release]: [16]\n");
  const p = phoneFromProps(props, "Physical size: 1440x3168", "GLES: Qualcomm, Adreno (TM) 830, OpenGL ES 3.2 V@0800", 15_800_000, maxFps("mode 1: fps=60.0 ... mode 2: fps=120.00001"));
  assert.equal(p.name, "OnePlus 13");
  assert.equal(p.gpu, "Adreno 830");
  assert.equal(p.gpuFamily, "adreno");
  assert.equal(p.android, 16);
  assert.deepEqual(p.screen, { w: 3168, h: 1440, hz: 120 });
  assert.equal(p.tier, "high");
  assert.equal(p.id, "usb-cph2653");
  assert.equal(gpuFamilyOf("Mali-G715"), "mali");
  assert.equal(gpuFamilyOf("Xclipse 940"), "xclipse");
  assert.equal(guessTier("Adreno (TM) 610"), "low");
});

test("target phones API: choose known phones only", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-phones-")), autodetect: false, pluginRoots: [] });
  try {
    const put = await server.app.inject({ method: "PUT", url: "/api/phones/targets", payload: { targets: ["oneplus-13", "../evil", "oneplus-13"] } });
    assert.deepEqual(put.json().targets, ["oneplus-13"]);
    const got = (await server.app.inject({ method: "GET", url: "/api/phones" })).json() as { brief?: string; catalog: unknown[] };
    assert.match(String(got.brief), /OnePlus 13/);
    assert.ok(got.catalog.length > 10);
  } finally {
    await server.app.close();
  }
});
