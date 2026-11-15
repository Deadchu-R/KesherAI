import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epicGame, parseVdf, steamGame, steamLibraries } from "./pc-games.js";
import { cleanSpots, cleanSpotsNow, measureSpots, type CleanSpot } from "./pc-clean.js";

test("Steam: libraries and games from its own files", () => {
  const vdf = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t\t"apps" { "570" "123" }\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}`;
  assert.deepEqual(steamLibraries(vdf), ["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]);
  const acf = `"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2"\n\t"installdir"\t\t"dota 2 beta"\n\t"SizeOnDisk"\t\t"45000000000"\n\t"LastPlayed"\t\t"1763200000"\n}`;
  const g = steamGame(acf, "D:\\SteamLibrary");
  assert.equal(g?.name, "Dota 2");
  assert.equal(g?.bytes, 45_000_000_000);
  assert.equal(g?.uninstallUrl, "steam://uninstall/570");
  assert.match(g?.lastPlayed ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(steamGame(`"AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" }`, "x"), undefined);
  assert.deepEqual(parseVdf(`"a" { "b" "c" }`), { a: { b: "c" } });
});

test("Epic: games from the launcher's manifests", () => {
  assert.equal(epicGame(JSON.stringify({ DisplayName: "Fortnite", InstallSize: 30_000_000_000, InstallLocation: "C:\\Games\\Fortnite" }))?.bytes, 30_000_000_000);
  assert.equal(epicGame("not json"), undefined);
});

test("cleaning: only old files in the chosen places, folders kept, other places untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-clean-"));
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(join(a, "sub"), { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(join(a, "old.tmp"), "x".repeat(1000));
  await writeFile(join(a, "sub", "old2.tmp"), "y".repeat(500));
  await writeFile(join(a, "new.tmp"), "z");
  await writeFile(join(b, "keep.tmp"), "k");
  const past = new Date(Date.now() - 3 * 24 * 3_600_000);
  await utimes(join(a, "old.tmp"), past, past);
  await utimes(join(a, "sub", "old2.tmp"), past, past);
  const spots: CleanSpot[] = [
    { id: "a", he: "", en: "", noteHe: "", noteEn: "", dirs: [a], olderThanHours: 24 },
    { id: "b", he: "", en: "", noteHe: "", noteEn: "", dirs: [b] },
  ];
  const before = await measureSpots(spots);
  assert.equal(before.find((x) => x.id === "a")?.bytes, 1500);
  const r = await cleanSpotsNow(["a"], spots);
  assert.equal(r.freed, 1500);
  assert.deepEqual((await readdir(a)).sort(), ["new.tmp"], "the new file stays; the emptied sub-folder goes");
  assert.ok(existsSync(a), "the place itself stays");
  assert.ok(existsSync(join(b, "keep.tmp")), "a place not chosen is untouched");
});

test("Windows places are inside the user's own folders", () => {
  const spots = cleanSpots({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", TEMP: "C:\\Users\\u\\AppData\\Local\\Temp", USERPROFILE: "C:\\Users\\u" }, "win32");
  for (const s of spots.filter((x) => x.id !== "steam-shaders")) for (const d of s.dirs) assert.ok(d.startsWith("C:\\Users\\u") || d.startsWith("C:/Users/u") || d.includes("Users"), d);
});
