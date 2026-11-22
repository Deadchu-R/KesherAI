import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePath, cleanTailscaleDirect, directUrls, hubUsable, isTailscaleIp } from "./direct-path.js";

const direct = { url: "https://pc.tail1234.ts.net", ip: "100.101.102.103" };

test("cleanTailscaleDirect keeps only tailnet addresses", () => {
  assert.deepEqual(cleanTailscaleDirect({ url: "https://pc.tail1234.ts.net/", ip: "100.64.0.1", dns: "PC.tail1234.ts.net." }), { url: "https://pc.tail1234.ts.net", ip: "100.64.0.1", dns: "pc.tail1234.ts.net" });
  for (const url of ["http://pc.tail1234.ts.net", "https://evil.example.com", "https://pc.ts.net.evil.com", "https://u:p@pc.tail1.ts.net", "https://pc.tail1.ts.net/x", "https://pc.tail1.ts.net?token=1", "https://pc.tail1.ts.net:8443"]) {
    assert.equal(cleanTailscaleDirect({ url }), undefined, url);
  }
  assert.equal(cleanTailscaleDirect({ ip: "192.168.1.5" }), undefined);
  assert.equal(cleanTailscaleDirect("x"), undefined);
  assert.equal(isTailscaleIp("100.128.0.1"), false);
  assert.equal(isTailscaleIp("100.127.255.254"), true);
});

test("directUrls: the HTTPS address first, then the 100.x address on the port", () => {
  assert.deepEqual(directUrls(direct, 7420), ["https://pc.tail1234.ts.net", "http://100.101.102.103:7420"]);
  assert.deepEqual(directUrls(undefined), []);
});

test("hubUsable: 2xx-4xx yes; no answer, 5xx and the storage limit no", () => {
  assert.equal(hubUsable({ status: 200 }), true);
  assert.equal(hubUsable({ status: 401 }), true);
  assert.equal(hubUsable({}), false);
  assert.equal(hubUsable({ status: 500 }), false);
  assert.equal(hubUsable({ status: 503, error: "hub-storage-limit" }), false);
  assert.equal(hubUsable({ status: 429, error: "hub-storage-limit" }), false);
});

test("choosePath: hub first, Tailscale when the hub is down and the address is known", () => {
  assert.deepEqual(choosePath({ status: 200 }, direct), { path: "hub", urls: [] });
  assert.deepEqual(choosePath({ status: 503, error: "hub-storage-limit" }, direct).path, "tailscale");
  assert.deepEqual(choosePath({}, direct).urls[0], "https://pc.tail1234.ts.net");
  assert.deepEqual(choosePath({}, undefined), { path: "none", urls: [] });
  assert.deepEqual(choosePath({ status: 502 }, undefined), { path: "hub", urls: [] });
});
