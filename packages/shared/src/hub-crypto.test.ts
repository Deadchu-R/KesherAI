import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPrivateJwk, fromB64url, generateHubKeys, importPrivateJwk, keyFingerprint, openEnvelope, ReplayGuard, sameText, sealMessage, sha256Hex, toB64url } from "./hub-crypto.js";
import { parseEnvelope, type SealedBody, type SealedEnvelope } from "./hub-protocol.js";

const task: SealedBody = { type: "task", taskId: "t-1", title: "Check the failing test", spec: "Run pnpm test", executor: "auto", ifOffline: "wait", createdAt: "2026-11-19T10:00:00.000Z" };

/** Made once with throwaway keys (test data only), so other runtimes can be checked against the same bytes. */
const VECTOR = {
  aPub: "BLR--mfX8sdgF65areK8erpKC95b7hU85m5C_WtTkvu1HNFzUVS-Vq-zZxYOu_saE481hWdFhXjGyDnxn8H0QTs",
  bJwk: '{"key_ops":["deriveBits"],"ext":true,"kty":"EC","x":"r2mwHfDR0_d2p6yJSdmVXP5nR1epakQYYj_9CAyk6Ac","y":"pD5zn1mIjt_skP-5qdexLAplrMim-gcMqYBEcX_ZMwc","crv":"P-256","d":"DjUz9MdLD9ySFXqP0df_krI5pvHW6vlVivH4_7aHN98"}',
  env: { v: 1, id: "vector-1", from: "phone1", to: "pc1", kind: "task", ttl: 3600, iv: "mhEYpl_kyaJgLAvE", ct: "Czf-_HbkLEYIpixYoyR5Pz8HXwbeDlf8Cmo4yZzpDCpjG2hPUU10ukD5S3-vuGkouvNZW_E_QjO53Qnz2ZKQ8mBuTRsrQ8jcIzXz7z7c2ZdQc-JFC5QMhHjHkNLbyhkGI90NeFreSkrhFh8wonfj7or81kEySErsjQwkk9f1pe5rzCjT32k4QPkUTnU85dSi24AZV3QNURU3ltFMx9P-BNLCKqHMIvvVrkA2YRuHlgrdPg" } as SealedEnvelope,
};

test("base64url round trip and constant-time compare", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(fromB64url(toB64url(bytes)), bytes);
  assert.ok(!toB64url(bytes).includes("=") && !toB64url(bytes).includes("+"));
  assert.ok(sameText("abc", "abc") && !sameText("abc", "abd") && !sameText("abc", "ab"));
});

test("seal and open between two devices", async () => {
  const phone = await generateHubKeys(false);
  const pc = await generateHubKeys(true);
  const env = await sealMessage({ from: "phone1", to: "pc1", kind: "task" }, task, phone.privateKey, pc.publicKey);
  assert.equal(parseEnvelope(env)?.id, env.id, "a sealed envelope passes the hub's shape check");
  assert.ok(!env.ct.includes("failing"), "no plain text in the envelope");
  assert.deepEqual(await openEnvelope(env, pc.privateKey, phone.publicKey), task);
  // The PC's key survives a trip through its config (JWK text).
  const again = await importPrivateJwk(await exportPrivateJwk(pc.privateKey));
  assert.equal(again.publicKey, pc.publicKey);
  assert.deepEqual(await openEnvelope(env, again.privateKey, phone.publicKey), task);
});

test("the fixed vector opens", async () => {
  const b = await importPrivateJwk(VECTOR.bJwk);
  assert.deepEqual(await openEnvelope(VECTOR.env, b.privateKey, VECTOR.aPub), task);
});

test("tampering, the wrong recipient and a swapped kind are refused", async () => {
  const b = await importPrivateJwk(VECTOR.bJwk);
  const flip = (s: string) => (s[5] === "A" ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
  for (const bad of [{ ct: flip(VECTOR.env.ct) }, { iv: flip(VECTOR.env.iv) }, { to: "pc2" }, { from: "phone2" }, { id: "vector-2" }, { kind: "cloud" as const }]) {
    await assert.rejects(openEnvelope({ ...VECTOR.env, ...bad }, b.privateKey, VECTOR.aPub), /could not be opened/, JSON.stringify(Object.keys(bad)));
  }
  const stranger = await generateHubKeys(false);
  await assert.rejects(openEnvelope(VECTOR.env, stranger.privateKey, VECTOR.aPub), /could not be opened/);
  // A sender cannot put a body of another type in an envelope kind.
  await assert.rejects(sealMessage({ from: "a", to: "b", kind: "result" }, task, stranger.privateKey, VECTOR.aPub), /cannot hold/);
});

test("replay guard: the same envelope twice is caught, until its time is over", () => {
  const g = new ReplayGuard(3);
  assert.equal(g.first("m1", 60, 0), true);
  assert.equal(g.first("m1", 60, 1000), false);
  assert.equal(g.first("m1", 60, 61_000), true, "after its ttl it is forgotten");
  for (const id of ["a", "b", "c", "d"]) g.first(id, 600, 70_000);
  assert.equal(g.first("d", 600, 70_001), false);
});

test("fingerprints and hashes are stable", async () => {
  assert.match(await keyFingerprint(VECTOR.aPub), /^\d{3} \d{3}$/);
  assert.equal(await keyFingerprint(VECTOR.aPub), await keyFingerprint(VECTOR.aPub));
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
