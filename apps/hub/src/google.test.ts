import { test } from "node:test";
import assert from "node:assert/strict";
import { toB64url } from "../../../packages/shared/src/hub.js";
import { fireClaudeTask, claudeTrigger, ROUTINE_BETA } from "./claude-cloud.js";
import { ownerCheck, verifyGoogleIdToken, type RsaJwk } from "./google.js";

const enc = new TextEncoder();
const b64json = (x: unknown) => toB64url(enc.encode(JSON.stringify(x)));

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as RsaJwk;
  const jwk: RsaJwk = { kid: "k1", kty: "RSA", n: pub.n, e: pub.e };
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const head = b64json({ alg: "RS256", kid, typ: "JWT" });
    const body = b64json(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(`${head}.${body}`));
    return `${head}.${body}.${toB64url(sig)}`;
  };
  return { jwk, sign };
}

test("Google ID tokens: signature, issuer, audience, expiry and verified email are checked", async () => {
  const { jwk, sign } = await signer();
  const keyFor = async (kid: string) => (kid === "k1" ? jwk : undefined);
  const now = 1_700_000_000_000;
  const good = { iss: "https://accounts.google.com", aud: "client", sub: "123", email: "a@b.c", email_verified: true, exp: now / 1000 + 600 };
  assert.equal((await verifyGoogleIdToken(await sign(good), "client", keyFor, now)).sub, "123");
  await assert.rejects(verifyGoogleIdToken(await sign({ ...good, aud: "other" }), "client", keyFor, now), /audience/);
  await assert.rejects(verifyGoogleIdToken(await sign({ ...good, iss: "evil.com" }), "client", keyFor, now), /issuer/);
  await assert.rejects(verifyGoogleIdToken(await sign({ ...good, exp: now / 1000 - 3600 }), "client", keyFor, now), /Expired/);
  await assert.rejects(verifyGoogleIdToken(await sign({ ...good, email_verified: false }), "client", keyFor, now), /not verified/);
  await assert.rejects(verifyGoogleIdToken(await sign(good, "k2"), "client", keyFor, now), /Unknown signing key/);
  const t = await sign(good);
  const forged = t.split(".");
  forged[1] = b64json({ ...good, sub: "456" });
  await assert.rejects(verifyGoogleIdToken(forged.join("."), "client", keyFor, now), /Bad signature/);
  const none = `${b64json({ alg: "none", kid: "k1" })}.${b64json(good)}.`;
  await assert.rejects(verifyGoogleIdToken(none, "client", keyFor, now), /algorithm/);
  await assert.rejects(verifyGoogleIdToken(t, "", keyFor, now), /client id/);
});

test("owner check: email only before the pin, sub after", () => {
  const c = { sub: "s1", email: "Owner@Example.com", email_verified: true, aud: "a", iss: "accounts.google.com", exp: 0 };
  assert.equal(ownerCheck(c, "owner@example.com", undefined), "pin");
  assert.equal(ownerCheck(c, "someone@example.com", undefined), "refuse");
  assert.equal(ownerCheck(c, undefined, undefined), "refuse", "no allowed email set: nobody");
  assert.equal(ownerCheck(c, "owner@example.com", "s1"), "ok");
  assert.equal(ownerCheck({ ...c, sub: "s2" }, "owner@example.com", "s1"), "refuse");
});

test("Claude fire: the documented request, the session link back, no token in errors", async () => {
  assert.equal(claudeTrigger({ triggerId: "trig_1" }), undefined);
  assert.equal(claudeTrigger({ triggerId: "../x", token: "t" }), undefined);
  const trig = claudeTrigger({ triggerId: "trig_1", token: "secret-token" })!;
  let seen: { url: string; init: RequestInit } | undefined;
  const ok = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ claude_code_session_id: "session_1", claude_code_session_url: "https://claude.ai/code/session_1" }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await fireClaudeTask("Task: x", trig, ok), { ok: true, sessionUrl: "https://claude.ai/code/session_1", sessionId: "session_1" });
  assert.equal(seen?.url, "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire");
  const h = seen?.init.headers as Record<string, string>;
  assert.equal(h.authorization, "Bearer secret-token");
  assert.equal(h["anthropic-beta"], ROUTINE_BETA);
  assert.deepEqual(JSON.parse(String(seen?.init.body)), { text: "Task: x" });

  const evil = (async () => new Response(JSON.stringify({ claude_code_session_url: "https://evil.example/phish" }))) as unknown as typeof fetch;
  assert.deepEqual(await fireClaudeTask("x", trig, evil), { ok: true }, "a link that is not claude.ai is dropped");
  for (const status of [401, 429, 500]) {
    const r = await fireClaudeTask("x", trig, (async () => new Response("{}", { status })) as unknown as typeof fetch);
    assert.ok(!r.ok && !r.error.includes("secret-token"));
  }
  const down = await fireClaudeTask("x", trig, (async () => { throw new Error("secret-token in a stack"); }) as unknown as typeof fetch);
  assert.ok(!down.ok && !down.error.includes("secret-token"));
});
