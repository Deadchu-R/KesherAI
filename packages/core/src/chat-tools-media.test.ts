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
