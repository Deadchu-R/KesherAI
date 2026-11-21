import test from "node:test";
import assert from "node:assert/strict";
import { smokeLaunch, type SmokeSpawn } from "./night-build-runners.js";

test("smoke: passes when the game is still up after the time, fails when it ends sooner", async () => {
  let killed = false;
  const stays: SmokeSpawn = () => ({ onExit: () => undefined, kill: () => { killed = true; } });
  assert.deepEqual(await smokeLaunch("g.exe", 0.02, stays), { ok: true, note: "Stayed up 0.02 s" });
  assert.equal(killed, true);
  const crashes: SmokeSpawn = () => ({ onExit: (cb) => setTimeout(() => cb(139, null), 5), kill: () => undefined });
  const r = await smokeLaunch("g.exe", 5, crashes);
  assert.equal(r.ok, false);
  assert.match(r.note, /exit 139/);
});
