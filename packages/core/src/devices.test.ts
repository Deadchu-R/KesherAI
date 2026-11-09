import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSynced, type DevicesConfig } from "./devices.js";

test("settings sync: new items arrive, the newer change wins, nothing ping-pongs", () => {
  const laptop: DevicesConfig["stamps"] = {};
  const pc: DevicesConfig["stamps"] = {};
  // The PC has OpenAI; the laptop has nothing yet.
  const r1 = mergeSynced({ openai: { key: "a" } }, {}, pc, "p:", 1000);
  assert.deepEqual(r1.apply, []);
  const drive = r1.merged;
  // The laptop gets it.
  const r2 = mergeSynced<{ key: string }>({}, drive, laptop, "p:", 2000);
  assert.deepEqual(r2.apply, [{ key: "a" }]);
  // Nothing changes on either side: no more work.
  assert.deepEqual(mergeSynced({ openai: { key: "a" } }, r2.merged, laptop, "p:", 3000).apply, []);
  // The laptop changes the key later: Drive takes it, and the PC applies it.
  const r3 = mergeSynced({ openai: { key: "b" } }, r2.merged, laptop, "p:", 4000);
  assert.equal(r3.merged.openai!.config.key, "b");
  const r4 = mergeSynced({ openai: { key: "a" } }, r3.merged, pc, "p:", 5000);
  assert.deepEqual(r4.apply, [{ key: "b" }]);
  assert.equal(r4.merged.openai!.config.key, "b");
});

test("the home-network signal only makes a known, unreachable computer be checked again", async () => {
  const { Devices } = await import("./devices.js");
  const d = new Devices({
    config: { id: "me", share: true, syncSettings: false, stamps: {} },
    remote: { enabled: true, anywhere: false },
    port: () => 7420,
    providers: () => [],
    addProvider: async () => undefined,
    registry: { setAway: () => undefined, get: () => undefined } as never,
    google: { connected: false } as never,
    mcp: {} as never,
    tunnelUrl: () => undefined,
    startTunnel: async () => undefined,
    gpu: async () => undefined,
    version: async () => "0",
    save: async () => undefined,
  });
  const inner = d as unknown as { entries: Array<{ id: string; name: string; platform: string; urls: string[]; token: string; updatedAt: string }>; views: Array<{ id: string; online: boolean }> };
  inner.entries = [{ id: "laptop", name: "Laptop", platform: "win32", urls: [], token: "t", updatedAt: new Date().toISOString() }];
  inner.views = [{ id: "laptop", online: false }];
  assert.equal(d.heard("not json"), false);
  assert.equal(d.heard(JSON.stringify({ t: "other", id: "laptop" })), false);
  assert.equal(d.heard(JSON.stringify({ t: "kesher-here", id: "me" })), false, "itself");
  assert.equal(d.heard(JSON.stringify({ t: "kesher-here", id: "laptop" })), true, "known and unreachable: checked again");
  inner.views = [{ id: "laptop", online: true }];
  assert.equal(d.heard(JSON.stringify({ t: "kesher-here", id: "laptop" })), false, "already reachable");
  assert.equal(d.heard(JSON.stringify({ t: "kesher-here", id: "new-pc" })), true, "a new computer: read the list again");
  assert.equal(d.heard(JSON.stringify({ t: "kesher-here", id: "new-pc-2" })), false, "at most once a minute");
  d.close();
});
