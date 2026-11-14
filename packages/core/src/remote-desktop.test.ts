import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteDesktop, hashPin, pinMatches } from "./remote-desktop.js";
import type { Backend } from "./computer.js";

test("the PIN is kept hashed; wrong PINs lock after five", () => {
  const kept = hashPin("123456");
  assert.doesNotMatch(kept, /123456/);
  assert.ok(pinMatches("123456", kept));
  assert.ok(!pinMatches("654321", kept));
  const rd = new RemoteDesktop(() => ({ enabled: true, pinHash: kept }));
  for (let i = 0; i < 5; i++) assert.throws(() => rd.start("000000", "p"), /Wrong PIN/);
  assert.throws(() => rd.start("123456", "p"), /Too many/);
});

test("off, or no PIN: no session", () => {
  assert.throws(() => new RemoteDesktop(() => ({ enabled: false, pinHash: hashPin("123456") })).start("123456", "p"), /off/);
  assert.throws(() => new RemoteDesktop(() => ({ enabled: true })).start("123456", "p"), /off/);
});

test("a session maps taps from the picture to the desktop, and ends", async () => {
  const done: string[] = [];
  const be = {
    screenshot: async () => ({ png: Buffer.from("x"), scale: 2, width: 960, height: 540, left: -1920, top: 0 }),
    click: async (x: number, y: number, b: string, d: boolean) => void done.push(`${b}${d ? "2" : ""} ${x},${y}`),
    type: async (t: string) => void done.push(`type ${t}`),
    key: async (k: string) => void done.push(`key ${k}`),
  } as unknown as Backend;
  const rd = new RemoteDesktop(() => ({ enabled: true, pinHash: hashPin("246810") }), () => be);
  const s = rd.start("246810", "phone");
  await assert.rejects(rd.frame("nope", 960), /ended/);
  await rd.frame(s, 960);
  await rd.input(s, { kind: "click", x: 10, y: 20 });
  await rd.input(s, { kind: "double", x: 1, y: 1 });
  await rd.input(s, { kind: "type", text: "hi" });
  await assert.rejects(rd.input(s, { kind: "key", combo: "ctrl+c; rm" }), /Unknown key/);
  assert.deepEqual(done, ["left -1900,40", "left2 -1918,2", "type hi"]);
  assert.equal(rd.status().active, true);
  rd.end();
  await assert.rejects(rd.input(s, { kind: "type", text: "x" }), /ended/);
});

test("without the PIN: the owner allows once or always; an allowed phone starts at once", async () => {
  const { deviceHash } = await import("./remote-desktop.js");
  const settings = { enabled: true, trusted: [] as Array<{ id: string; name: string; at: string }> };
  const rd = new RemoteDesktop(() => settings);
  const phone = "a1b2c3d4e5f6a7b8c9d0";
  const r = rd.request("Android", phone);
  assert.ok(r.code && !r.token);
  assert.equal(rd.poll(r.id, phone).state, "waiting");
  assert.equal(rd.poll(r.id, "someone-else-0000000").state, "gone", "only the asking phone sees the answer");
  const d = rd.decide(r.code!, "always");
  assert.ok(d && d.keep && d.keep.id === deviceHash(phone) && !d.keep.id.includes(phone));
  const p = rd.poll(r.id, phone);
  assert.equal(p.state, "approved");
  assert.ok(p.token);
  assert.equal(rd.decide(r.code!, "once"), false, "a code works once");
  settings.trusted.push(d.keep!);
  assert.ok(rd.request("Android", phone).token, "allowed for good: no asking");
  const other = rd.request("Other", "zzzzzzzzzzzzzzzzzzzz");
  rd.decide(other.code!, "deny");
  assert.equal(rd.poll(other.id, "zzzzzzzzzzzzzzzzzzzz").state, "denied");
  settings.enabled = false;
  assert.throws(() => rd.request("Android", phone), /off/);
});
