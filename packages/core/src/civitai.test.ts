import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTriggers, pickFile, safeLoraFile, toLoras } from "./civitai.js";

test("CivitAI LoRAs become cards with their trigger words; unsafe names and pictures are cleaned", () => {
  const items = [
    {
      id: 7,
      name: "Pixel Art",
      creator: { username: "maker" },
      modelVersions: [
        {
          id: 70,
          name: "v2",
          baseModel: "SDXL 1.0",
          trainedWords: ["pixel art, 8bit", "pixel art"],
          files: [
            { name: "notes.txt", type: "Training Data" },
            { name: "../../evil name.safetensors", sizeKB: 1024, primary: true, type: "Model", hashes: { SHA256: "ABC" } },
          ],
          images: [{ url: "https://image.civitai.com/x/nsfw.jpeg", nsfwLevel: 8 }, { url: "https://image.civitai.com/x/ok.jpeg", nsfwLevel: 1 }],
          stats: { downloadCount: 5 },
        },
      ],
    },
    { id: 8, name: "No file", modelVersions: [{ id: 80, files: [] }] },
  ];
  const [l, ...rest] = toLoras(items);
  assert.equal(rest.length, 0, "a version without a model file is left out");
  assert.deepEqual(l?.triggers, ["pixel art", "8bit"]);
  assert.equal(l?.fileName, "evil_name.safetensors");
  assert.equal(l?.sha256, "abc");
  assert.equal(l?.sizeBytes, 1024 * 1024);
  assert.equal(l?.image, "https://image.civitai.com/x/ok.jpeg");
  assert.equal(l?.baseModel, "SDXL 1.0");
});

test("helpers", () => {
  assert.equal(safeLoraFile("..."), "lora.safetensors");
  assert.equal(pickFile({ files: [{ name: "a.safetensors" }, { name: "b.safetensors", primary: true }] })?.name, "b.safetensors");
  assert.equal(cleanTriggers(new Array(30).fill(0).map((_, i) => `w${i}`)).length, 12);
});
