import { test } from "node:test";
import assert from "node:assert/strict";
import { musicKey, musicLanguage } from "./chat-tools-media.js";

test("make_music: the model's language and key words become what ACE-Step 1.5 lists", () => {
  assert.equal(musicLanguage("he"), "he");
  assert.equal(musicLanguage("Hebrew"), "he");
  assert.equal(musicLanguage("iw"), "he");
  assert.equal(musicLanguage("en-US"), "en");
  assert.equal(musicLanguage("yue"), "yue");
  assert.equal(musicLanguage("klingon"), "en");
  assert.equal(musicLanguage(undefined), "en");
  assert.equal(musicKey("a minor"), "A minor");
  assert.equal(musicKey("Am"), "A minor");
  assert.equal(musicKey("F#"), "F# major");
  assert.equal(musicKey("Bb maj"), "Bb major");
  assert.equal(musicKey("E♭ minor"), "Eb minor");
  assert.equal(musicKey("H major"), undefined);
  assert.equal(musicKey("E#"), undefined);
});

test("a song's cover: made with the active image model, no words asked for; none without a usable image model", async () => {
  const { songCover } = await import("./chat-tools-media.js");
  let asked: { prompt: string; width: number } | undefined;
  const saved: string[] = [];
  const deps = (image?: string) =>
    ({
      config: { activeModels: { image }, parts: {} },
      registry: { resolve: () => ({ providerModelId: "m", provider: { generateImage: async (r: { prompt: string; width: number }) => ((asked = r), [{ data: new Uint8Array([1]), mimeType: "image/png" }]) } }) },
      assets: { save: async (_d: Uint8Array, _m: string, extra: { meta?: { use?: string } }) => (saved.push(extra.meta?.use ?? ""), { id: "cover1" }) },
    }) as never;
  assert.equal(await songCover(deps("comfyui/sdxl.safetensors"), "happy pop, acoustic guitar", "בוקר של שבת"), "cover1");
  assert.match(asked!.prompt, /Album cover art for a happy pop, acoustic guitar song called "בוקר של שבת"\. .*No text/);
  assert.equal(asked!.width, 768);
  assert.deepEqual(saved, ["song-cover"]);
  assert.equal(await songCover(deps(undefined), "pop", undefined), undefined);
  assert.equal(await songCover(deps("comfyui/wan_2.1_vae.safetensors"), "pop", undefined), undefined, "a support file is not an image model");
});

test("pictureSize reads a PNG's and a JPEG's size from their first bytes", async () => {
  const { pictureSize } = await import("./chat-tools-media.js");
  // A PNG header: 8 signature bytes, the IHDR length and name, then width and height.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0xe0, 0, 0, 3, 0x56]);
  assert.deepEqual(pictureSize(png), { w: 480, h: 854 });
  // A JPEG: SOI, an APP0 segment, then SOF0 with height and width.
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 1, 0xe0, 2, 0x80, 3]);
  assert.deepEqual(pictureSize(jpg), { w: 640, h: 480 });
  assert.equal(pictureSize(new Uint8Array([1, 2, 3])), undefined);
});
