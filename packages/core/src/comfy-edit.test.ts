import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow, editFlow, jsonFrom, type ApiFlow, type NodeInfo } from "./comfy-edit.js";

const nodes: Record<string, NodeInfo> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd15.safetensors", "flux.safetensors"]] } }, output: ["MODEL", "CLIP", "VAE"] },
  CLIPTextEncode: { input: { required: { text: ["STRING"], clip: ["CLIP"] } }, output: ["CONDITIONING"] },
  KSampler: { input: { required: { model: ["MODEL"], seed: ["INT"], steps: ["INT"], positive: ["CONDITIONING"] } }, output: ["LATENT"] },
  LoraLoader: { input: { required: { model: ["MODEL"], clip: ["CLIP"], lora_name: [["anime.safetensors"]], strength_model: ["FLOAT"], strength_clip: ["FLOAT"] } }, output: ["MODEL", "CLIP"] },
};
const flow: ApiFlow = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a dog", clip: ["1", 1] } },
  "3": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 1, steps: 20, positive: ["2", 0] } },
};

test("checks nodes, required inputs, links and choices", () => {
  assert.deepEqual(checkFlow(flow, nodes), []);
  const bad = { ...flow, "4": { class_type: "Nope", inputs: {} }, "3": { class_type: "KSampler", inputs: { model: ["9", 0], seed: 1, positive: ["2", 0] } }, "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } } };
  const p = checkFlow(bad, nodes);
  assert.ok(p.some((x) => /no node "Nope"/.test(x)));
  assert.ok(p.some((x) => /missing the input "steps"/.test(x)));
  assert.ok(p.some((x) => /links to node 9/.test(x)));
  assert.ok(p.some((x) => /only has: "sd15.safetensors"/.test(x)));
  assert.deepEqual(jsonFrom('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
});

test("edits a flow, and sends the mistakes back once", async () => {
  const asked: number[] = [];
  const answers = [
    JSON.stringify({ note: "x", flow: { ...flow, "4": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: "wrong.safetensors", strength_model: 1, strength_clip: 1 } } } }),
    "```json\n" + JSON.stringify({ note: "הוספתי LoRA", flow: { ...flow, "2": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } }, "3": { class_type: "KSampler", inputs: { model: ["4", 0], seed: 1, steps: 20, positive: ["2", 0] } }, "4": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: "anime.safetensors", strength_model: 0.8, strength_clip: 0.8 } } } }) + "\n```",
  ];
  const r = await editFlow(flow, "add the anime LoRA and make it a cat", nodes, async (m) => {
    asked.push(m.length);
    if (m.length > 2) assert.match(m.at(-1)!.content, /only has: "anime.safetensors"/);
    return answers.shift()!;
  });
  assert.deepEqual(asked, [2, 4]);
  assert.equal(r.note, "הוספתי LoRA");
  assert.equal(r.flow["4"]!.class_type, "LoraLoader");
  assert.match(String((asked.length, r.flow["2"]!.inputs.text)), /cat/);
  await assert.rejects(editFlow(flow, "x", nodes, async () => "no json here"), /could not make a flow/);
});
