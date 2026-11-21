import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSecretBox } from "./secret-file.js";
import { withSecrets } from "./config.js";

test("file secret box: round trip, key file 0600, a second box reads the first's values", () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-sec-"));
  const file = join(dir, "k.key");
  const a = fileSecretBox(file);
  const sealed = a.seal("hf_abcdefgh1234");
  assert.ok(!sealed.includes("hf_abcdefgh1234"));
  assert.notEqual(sealed, a.seal("hf_abcdefgh1234"), "a fresh iv each time");
  assert.equal(fileSecretBox(file).unseal(sealed), "hf_abcdefgh1234");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0);
  assert.throws(() => a.unseal("plain"));
  assert.throws(() => a.unseal(sealed.slice(0, -4) + "AAAA"), "tampering is caught");
});

test("headless config: plain keys are written sealed, never as text", () => {
  const box = fileSecretBox(join(mkdtempSync(join(tmpdir(), "kesher-sec-")), "k.key"));
  const plain = { huggingFaceToken: "hf_abcdefgh1234", webKeys: { tavily: "tvly-secret", brave: "bsa-secret" }, providers: [{ id: "gemini", apiKey: "AIzaSECRET0000" }] };
  const out = withSecrets(plain, "seal", box);
  assert.ok(!JSON.stringify(out).match(/hf_abcdefgh1234|tvly-secret|bsa-secret|AIzaSECRET0000/));
  assert.deepEqual(withSecrets(out, "unseal", box), plain);
});
