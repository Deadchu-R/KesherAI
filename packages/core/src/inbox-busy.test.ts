import { test } from "node:test";
import assert from "node:assert/strict";
import { gameFoldersForBusy } from "./inbox-busy.js";

test("plain Store apps are not games for the busy check", () => {
  const out = gameFoldersForBusy([
    { name: "Windows.CrossDevice.StartExperiencesApp", source: "store", folder: "C:\\Program Files\\WindowsApps\\x" },
    { name: "Halo", source: "xbox", folder: "E:\\XboxGames\\Halo" },
    { name: "Hades", source: "steam", folder: "D:\\Steam\\common\\Hades" },
    { name: "NoFolder", source: "epic" },
  ]);
  assert.deepEqual(out.map((g) => g.name), ["Halo", "Hades"]);
});
