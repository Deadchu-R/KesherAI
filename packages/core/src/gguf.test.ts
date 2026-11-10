import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mtpLayers, readGgufHeader } from "./gguf.js";

/** A tiny GGUF header: a string, an array of strings (skipped), a u32. */
function gguf(kv: Array<[string, "str" | "u32" | "strs", unknown]>): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF", "latin1")];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(u32(3), u64(0), u64(kv.length));
  for (const [k, t, v] of kv) {
    parts.push(str(k));
    if (t === "str") parts.push(u32(8), str(v as string));
    if (t === "u32") parts.push(u32(4), u32(v as number));
    if (t === "strs") parts.push(u32(9), u32(8), u64((v as string[]).length), ...(v as string[]).map(str));
  }
  return Buffer.concat(parts);
}

test("reads a GGUF header and finds the MTP layers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gguf-"));
  const a = join(dir, "a.gguf");
  await writeFile(a, gguf([["general.architecture", "str", "qwen35"], ["tokenizer.ggml.tokens", "strs", ["a", "bb", "ccc"]], ["qwen35.nextn_predict_layers", "u32", 1]]));
  const h = await readGgufHeader(a);
  assert.equal(h?.get("general.architecture"), "qwen35");
  assert.equal(await mtpLayers(a), 1);
  const b = join(dir, "b.gguf");
  await writeFile(b, gguf([["general.architecture", "str", "llama"]]));
  assert.equal(await mtpLayers(b), 0);
  const c = join(dir, "c.gguf");
  await writeFile(c, "not a model");
  assert.equal(await readGgufHeader(c), undefined);
});

test("MTP: on for a model with an MTP head, with the chosen guesses ahead; 0 turns it off; own --spec args win", async () => {
  const { LlamaEngine } = await import("./llamacpp.js");
  const dir = await mkdtemp(join(tmpdir(), "gguf-"));
  const a = join(dir, "Qwen3.8-27B.gguf");
  await writeFile(a, gguf([["qwen35.nextn_predict_layers", "u32", 1]]));
  assert.deepEqual(await LlamaEngine.mtpArgs(a, [], "b12110"), ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"], "2 unless set (measured on the PC)");
  assert.deepEqual(await LlamaEngine.mtpArgs(a, [], "b12110", 4), ["--spec-type", "draft-mtp", "--spec-draft-n-max", "4"]);
  assert.deepEqual(await LlamaEngine.mtpArgs(a, [], "b12110", 0), []);
  assert.deepEqual(await LlamaEngine.mtpArgs(a, ["--spec-type", "ngram"], "b12110", 2), []);
  assert.deepEqual(await LlamaEngine.mtpArgs(a, [], "b11000", 2), [], "older engines have no MTP");
});
