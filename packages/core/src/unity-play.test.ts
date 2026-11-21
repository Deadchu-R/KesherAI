import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlayFile, unityInPlay, type UnityPlayDeps } from "./unity-play.js";

test("parsePlayFile reads only the package's own format", () => {
  assert.equal(parsePlayFile('{"event":"play","on":true}'), true);
  assert.equal(parsePlayFile('{"event":"play","on":false}'), false);
  assert.equal(parsePlayFile('{"event":"other","on":true}'), undefined);
  assert.equal(parsePlayFile('{"event":"play","on":"yes"}'), undefined);
  assert.equal(parsePlayFile("not json"), undefined);
});

const deps = (files: Record<string, string>, lock: boolean, procs: string[] | undefined): UnityPlayDeps => ({
  read: async (f) => files[f.replace(/\\/g, "/")],
  lockfile: () => lock,
  processes: async () => (procs ? { projects: procs, unnamed: false } : undefined),
});

test("in Play only while the editor is open on the project", async () => {
  const files = { "/p/Game/Temp/KesherPlay.json": '{"event":"play","on":true}' };
  assert.equal(await unityInPlay(["/p/Game"], deps(files, true, ["/p/Game"])), true);
  // A crash left "on" and the lock file, but no Unity runs: not in Play.
  assert.equal(await unityInPlay(["/p/Game"], deps(files, true, ["/p/Other"])), false);
  assert.equal(await unityInPlay(["/p/Game"], deps(files, false, ["/p/Game"])), false);
  assert.equal(await unityInPlay(["/p/Game"], deps({}, true, ["/p/Game"])), false);
  assert.equal(await unityInPlay(["/p/Game"], deps({ "/p/Game/Temp/KesherPlay.json": '{"event":"play","on":false}' }, true, ["/p/Game"])), false);
});
