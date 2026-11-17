import { test } from "node:test";
import assert from "node:assert/strict";
import { privateAddress } from "./web-image.js";

test("addresses on this computer or the local network are never fetched", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.20.1.1", "169.254.1.1", "::1", "fd00::1", "::ffff:192.168.0.1", "100.64.0.1"]) assert.ok(privateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "142.250.1.1", "2a00:1450::1"]) assert.ok(!privateAddress(ip), ip);
});
