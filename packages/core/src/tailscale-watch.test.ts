import { test } from "node:test";
import assert from "node:assert/strict";
import { TailscaleWatch } from "./tailscale-watch.js";

test("TailscaleWatch closes a Funnel the user did not choose, then reports address changes", async () => {
  const closed: Array<string | undefined> = [];
  let direct: { ip?: string; url?: string } | undefined = { ip: "100.64.0.9" };
  const changes: unknown[] = [];
  const fake = {
    self: async () => ({ ip: "100.64.0.9" }),
    direct: async () => direct,
    closeFunnel: async (_port: number, target?: string) => (closed.push(target), true),
  };
  let allow = false;
  const w = new TailscaleWatch(fake, { port: () => 7420, allowFunnel: () => allow, remoteOn: () => true, onChange: (d) => changes.push(d) });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await w.start(), true);
  } finally {
    console.warn = warn;
    w.stop();
  }
  assert.deepEqual(closed, ["100.64.0.9"], "serves the tailnet instead (remote access on)");
  assert.deepEqual(w.current(), { ip: "100.64.0.9" });
  await w.refresh();
  assert.equal(changes.length, 1, "no change, no new hello");
  direct = { ip: "100.64.0.9", url: "https://pc.tail1.ts.net" };
  await w.refresh();
  assert.equal(changes.length, 2);
  allow = true;
  const w2 = new TailscaleWatch(fake, { port: () => 7420, allowFunnel: () => allow, remoteOn: () => true });
  assert.equal(await w2.start(), false, "an allowed Funnel is left alone");
  w2.stop();
  assert.equal(closed.length, 1);
});
