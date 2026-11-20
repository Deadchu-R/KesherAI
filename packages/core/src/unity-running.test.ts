import { test } from "node:test";
import assert from "node:assert/strict";
import { editorOpen, parseUnityProcesses } from "./unity-running.js";

test("editor open: a stale lock file without a running Unity for the project is not open", () => {
  const none = parseUnityProcesses([]);
  const other = parseUnityProcesses(['"C:\\Program Files\\Unity\\Editor\\Unity.exe" -projectpath "D:\\Games\\Other"']);
  const mine = parseUnityProcesses(['Unity.exe -projectPath D:\\Games\\Mine -useHub']);
  assert.deepEqual(mine.projects, ["D:\\Games\\Mine"]);
  assert.equal(editorOpen("/p/Game", true, none), false, "crash left the lock file, no Unity runs");
  assert.equal(editorOpen("/p/Game", true, parseUnityProcesses(["Unity -projectpath /p/Other"])), false, "Unity runs on another project");
  assert.equal(editorOpen("D:\\Games\\Mine", false, mine), false, "no lock file, not open");
  assert.equal(editorOpen("/p/Game", true, parseUnityProcesses(["Unity -projectpath /p/Game"])), true);
  assert.equal(editorOpen("/p/Game", true, parseUnityProcesses(["Unity -batchmode"])), true, "a Unity that named no project may have it");
  assert.equal(editorOpen("/p/Game", true, undefined), true, "process list unreadable: the lock file decides");
  assert.equal(other.unnamed, false);
});
