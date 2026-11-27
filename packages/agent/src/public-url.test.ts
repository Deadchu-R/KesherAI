import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicUrl, fetchPublic, privateAddress, privateHostName } from "./public-url.js";

test("privateAddress: loopback, private, link-local, Tailscale and IPv6 forms", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "100.127.255.255", "::", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1"]) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:808:808"]) assert.equal(privateAddress(ip), false, ip);
});

test("privateHostName: localhost names, literals and single-label hosts", () => {
  for (const u of ["http://localhost:3000/", "http://app.localhost/", "http://LOCALHOST./", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://printer.local/", "http://router/", "http://127.1/", "http://2130706433/"]) {
    assert.equal(privateHostName(new URL(u)), true, u);
  }
  assert.equal(privateHostName(new URL("https://example.com/")), false);
});

test("assertPublicUrl: a public name that resolves to a private address is refused", async () => {
  await assert.rejects(assertPublicUrl(new URL("https://rebind.example/"), async () => ["127.0.0.1"]), /home network/);
  await assert.rejects(assertPublicUrl(new URL("file:///etc/passwd")), /http and https/);
  await assertPublicUrl(new URL("https://example.com/"), async () => ["93.184.215.14"]);
  // A name that does not resolve is left to the fetch.
  await assertPublicUrl(new URL("https://nothing.invalid/"), async () => {
    throw new Error("ENOTFOUND");
  });
});

test("fetchPublic: follows public redirects, refuses one into this computer", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: URL | string) => {
    const href = String(u);
    asked.push(href);
    if (href === "https://a.example/") return new Response(null, { status: 302, headers: { location: "/b" } });
    if (href === "https://a.example/b") return new Response("ok", { status: 200 });
    if (href === "https://evil.example/") return new Response(null, { status: 301, headers: { location: "http://127.0.0.1:47820/api/settings" } });
    if (href === "https://loop.example/") return new Response(null, { status: 302, headers: { location: "https://loop.example/" } });
    throw new Error(`unexpected ${href}`);
  }) as typeof fetch;
  const pub = async () => ["93.184.215.14"];
  try {
    const r = await fetchPublic(new URL("https://a.example/"), {}, pub);
    assert.equal(await r.res.text(), "ok");
    assert.equal(r.url.href, "https://a.example/b");
    await assert.rejects(fetchPublic(new URL("https://evil.example/"), {}, pub), /public web pages/);
    assert.ok(!asked.some((u) => u.includes("127.0.0.1")), "the private address was never fetched");
    await assert.rejects(fetchPublic(new URL("https://loop.example/"), {}, pub), /too many times/);
  } finally {
    globalThis.fetch = real;
  }
});
