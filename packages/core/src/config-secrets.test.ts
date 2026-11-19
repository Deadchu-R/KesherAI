import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataPaths, loadConfig, saveConfig, useSecretBox, withSecrets, type SecretBox } from "./config.js";

/** A stand-in for the system's protection: reversible, and not the plain text. */
const box: SecretBox = { seal: (t) => Buffer.from(`x${t}`).toString("base64"), unseal: (t) => Buffer.from(t, "base64").toString().slice(1) };

test("keys at rest: written encrypted, read back, and a plain config still loads", async () => {
  const paths = dataPaths(await mkdtemp(join(tmpdir(), "kesher-sec-")));
  // An older, plain config.
  await writeFile(paths.config, JSON.stringify({ providers: [{ id: "openai", type: "openai", apiKey: "sk-plain" }], telegram: { token: "tg-1" } }));
  useSecretBox(box);
  try {
    const c = await loadConfig(paths);
    assert.equal(c.providers.find((p) => p.id === "openai")?.apiKey, "sk-plain");
    await saveConfig(paths, c);
    const raw = await readFile(paths.config, "utf8");
    assert.ok(!raw.includes("sk-plain") && !raw.includes("tg-1"), "no secret in plain text on disk");
    assert.match(raw, /enc:v1:/);
    const again = await loadConfig(paths);
    assert.equal(again.providers.find((p) => p.id === "openai")?.apiKey, "sk-plain");
    assert.equal(again.telegram.token, "tg-1");
  } finally {
    useSecretBox(undefined);
  }
});

test("a secret this run cannot read is kept as it was, not lost", () => {
  const sealed = withSecrets({ providers: [{ id: "g", apiKey: "k1" }], github: { token: "gh" } }, "seal", box);
  const read = withSecrets(sealed, "unseal", undefined);
  assert.equal((read.providers as Array<{ apiKey?: string }>)[0]?.apiKey, undefined);
  const written = withSecrets(read, "seal", undefined);
  assert.deepEqual(written, sealed);
  // A new key typed in this run wins over the kept one.
  (read.providers as Array<{ apiKey?: string }>)[0]!.apiKey = "k2";
  const replaced = withSecrets(read, "seal", undefined);
  assert.equal((replaced.providers as Array<{ apiKey?: string }>)[0]?.apiKey, "k2");
});

test("the cloud hub's device token and private key are secrets too", () => {
  const sealed = withSecrets({ hub: { enabled: true, url: "https://hub.example.test", token: "kh_tok", key: '{"d":"x"}' } }, "seal", box);
  const raw = JSON.stringify(sealed);
  assert.ok(!raw.includes("kh_tok") && !raw.includes('\\"d\\"'), "neither is written in plain text");
  assert.ok(raw.includes("https://hub.example.test"), "the address is not a secret");
  const back = withSecrets(sealed, "unseal", box).hub as { token?: string; key?: string };
  assert.equal(back.token, "kh_tok");
  assert.equal(back.key, '{"d":"x"}');
});
