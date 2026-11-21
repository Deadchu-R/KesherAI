import { test } from "node:test";
import assert from "node:assert/strict";
import { addressOrder, findAddress } from "./device-address.js";

const urls = ["https://a.example/", "http://192.168.1.5:3000", "http://10.0.0.7:3000"];

test("the last-known address goes first, once; an unknown one is ignored", () => {
  assert.deepEqual(addressOrder(urls, "http://10.0.0.7:3000/"), ["http://10.0.0.7:3000", "https://a.example", "http://192.168.1.5:3000"]);
  assert.deepEqual(addressOrder(urls, "http://evil.example"), ["https://a.example", "http://192.168.1.5:3000", "http://10.0.0.7:3000"]);
  assert.deepEqual(addressOrder(urls, undefined).length, 3);
  assert.deepEqual(addressOrder([], "x"), []);
});

test("the last-known address that answers wins without asking the others", async () => {
  const asked: string[] = [];
  const hit = await findAddress(urls, "http://192.168.1.5:3000", async (u) => (asked.push(u), 7), 50);
  assert.equal(hit?.url, "http://192.168.1.5:3000");
  assert.deepEqual(asked, ["http://192.168.1.5:3000"]);
});

test("a last-known address that fails falls back to all the others at once", async () => {
  const asked: string[] = [];
  const hit = await findAddress(urls, "http://192.168.1.5:3000", async (u) => {
    asked.push(u);
    if (u !== "https://a.example") throw new Error("down");
    return "ok";
  }, 50);
  assert.equal(hit?.url, "https://a.example");
  assert.equal(hit?.value, "ok");
  assert.equal(asked[0], "http://192.168.1.5:3000");
});

test("a last-known address that hangs gives way after its short wait", async () => {
  const t0 = Date.now();
  const hit = await findAddress(urls, "http://192.168.1.5:3000", (u) => (u === "http://192.168.1.5:3000" ? new Promise(() => undefined) : Promise.resolve(u)), 30);
  assert.ok(hit && hit.url !== "http://192.168.1.5:3000");
  assert.ok(Date.now() - t0 < 1000);
});

test("nothing answers: undefined", async () => {
  assert.equal(await findAddress(urls, undefined, () => Promise.reject(new Error("no")), 10), undefined);
  assert.equal(await findAddress([], undefined, () => Promise.resolve(1)), undefined);
});
