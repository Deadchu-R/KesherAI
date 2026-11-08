import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Training, fillDefaults, slug } from "./training.js";

const info = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd_xl_base_1.0.safetensors", "v1-5-pruned.safetensors"]] } } },
  LoadImageDataSetFromFolder: { input: { required: { folder: [["kesher-train-x"]] } } },
  TrainLoraNode: { input: { required: { steps: ["INT", { default: 16 }], bucket_mode: ["BOOLEAN", { default: false }], algorithm: ["COMBO", { options: ["LoRA", "LoHa"] }] } } },
  SaveLoRA: { input: { required: { prefix: ["STRING", { default: "loras/x" }] } } },
};

test("fillDefaults fills what the flow did not set from ComfyUI's node list", () => {
  const flow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = { "5": { class_type: "TrainLoraNode", inputs: { steps: 600 } } };
  fillDefaults(flow, info);
  assert.deepEqual(flow["5"]!.inputs, { steps: 600, bucket_mode: false, algorithm: "LoRA" });
  assert.equal(slug("My Cat Style!"), "my-cat-style");
});

test("a picture LoRA trains in ComfyUI and lands in the LoRA folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-train-"));
  const comfyDir = join(root, "ComfyUI");
  await mkdir(join(comfyDir, "models"), { recursive: true });
  const loraDir = join(root, "loras");
  let ran: Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined;
  const t = new Training({
    comfy: () => ({ installed: true, running: true, folder: comfyDir, url: "http://127.0.0.1:8188" }),
    vramGb: async () => 16,
    objectInfo: async () => info,
    runFlow: async (flow) => {
      ran = flow;
      await mkdir(join(comfyDir, "output", "loras"), { recursive: true });
      await writeFile(join(comfyDir, "output", "loras", "kesher-cats_600_steps_00001_.safetensors"), "lora");
    },
    loraDir: () => loraDir,
  });
  const kinds = await t.kinds();
  assert.equal(kinds[0]!.ready, true);
  assert.equal(kinds[0]!.bases!.find((b) => b.name.startsWith("sd_xl"))!.family, "sdxl");
  await assert.rejects(t.startImageLora({ name: "cats", trigger: "mycat", base: "sd_xl_base_1.0.safetensors", images: [] }), /5 to 60/);
  const img = { data: new Uint8Array([1]), mimeType: "image/jpeg" };
  const job = await t.startImageLora({ name: "Cats", trigger: "mycat", base: "sd_xl_base_1.0.safetensors", images: Array(6).fill(img) });
  for (let i = 0; i < 50 && t.list()[0]!.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.list()[0]!.status, "done", t.list()[0]!.message);
  assert.equal(job.file, "cats.safetensors");
  assert.deepEqual(await readdir(loraDir), ["cats.safetensors"]);
  assert.equal(ran!["2"]!.class_type, "LoadImageDataSetFromFolder");
  assert.equal(ran!["4"]!.inputs.text, "mycat");
  assert.equal(ran!["5"]!.inputs.algorithm, "LoRA");
});

test("a chat dataset is made from chats and documents, in the chat JSONL format", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-ds-"));
  const turns = Array.from({ length: 12 }, (_, i) => [{ role: "user" as const, text: `question ${i}` }, { role: "assistant" as const, text: `answer ${i}` }]).flat();
  const t = new Training({
    comfy: () => ({ installed: false, running: false, url: "" }),
    vramGb: async () => 0,
    objectInfo: async () => ({}),
    runFlow: async () => undefined,
    loraDir: () => root,
    chats: async () => [{ id: "a", title: "A", turns }, { id: "b", title: "B", turns }],
    documents: async () => [{ title: "My essay", content: Array.from({ length: 10 }, (_, i) => `Paragraph ${i} `.repeat(30)).join("\n\n") }],
    datasetDir: () => join(root, "datasets"),
  });
  await assert.rejects(t.buildChatDataset({ name: "x", chats: ["a"], documents: false }), /at least 20/);
  const ds = await t.buildChatDataset({ name: "My Texts", chats: ["a", "b"], documents: true });
  assert.equal(ds.name, "my-texts");
  assert.ok(ds.examples > 24);
  const { readFile } = await import("node:fs/promises");
  const first = JSON.parse((await readFile(ds.file, "utf8")).split("\n")[0]!) as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(first.messages, [{ role: "user", content: "question 0" }, { role: "assistant", content: "answer 0" }]);
  assert.equal((await t.datasets())[0]!.examples, ds.examples);
});
