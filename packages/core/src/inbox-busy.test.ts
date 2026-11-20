import { test } from "node:test";
import assert from "node:assert/strict";
import { gameFoldersForBusy, isSteamTool } from "./inbox-busy.js";
import { steamGame } from "./pc-games.js";

test("plain Store apps are not games for the busy check", () => {
  const out = gameFoldersForBusy([
    { name: "Windows.CrossDevice.StartExperiencesApp", source: "store", folder: "C:\\Program Files\\WindowsApps\\x" },
    { name: "Halo", source: "xbox", folder: "E:\\XboxGames\\Halo" },
    { name: "Hades", source: "steam", folder: "D:\\Steam\\common\\Hades" },
    { name: "NoFolder", source: "epic" },
  ]);
  assert.deepEqual(out.map((g) => g.name), ["Halo", "Hades"]);
});

test("Steam tools such as Wallpaper Engine are not games for the busy check", () => {
  const acf = (id: string, name: string, dir: string) => `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${dir}"\n}\n`;
  const we = steamGame(acf("431960", "Wallpaper Engine", "wallpaper_engine"), "D:\\Steam");
  assert.equal(we?.steamAppId, "431960");
  const out = gameFoldersForBusy([
    we!,
    steamGame(acf("250820", "SteamVR", "SteamVR"), "D:\\Steam")!,
    steamGame(acf("999999", "Some Game Dedicated Server", "srv"), "D:\\Steam")!,
    steamGame(acf("1145360", "Hades", "Hades"), "D:\\Steam")!,
    { name: "Wallpaper Engine", source: "epic", folder: "E:\\Epic\\X" },
  ]);
  assert.deepEqual(out.map((g) => g.name), ["Hades", "Wallpaper Engine"]);
});

test("isSteamTool: by app id first, then by name; games stay games", () => {
  assert.equal(isSteamTool({ name: "Renamed", source: "steam", steamAppId: "431960" }), true);
  assert.equal(isSteamTool({ name: "Proton 9.0", source: "steam" }), true);
  assert.equal(isSteamTool({ name: "Engine Evolution", source: "steam", steamAppId: "1" }), false);
  assert.equal(isSteamTool({ name: "Half-Life: Alyx", source: "steam", steamAppId: "546560" }), false);
});
