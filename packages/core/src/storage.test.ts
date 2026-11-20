import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { copyLooksWhole, driveOf, fileKind, isProjectRoot, parseDuration, parseSize, Storage } from "./storage.js";

test("storage: kinds, cards (large, old downloads, installers, duplicates, screenshots) and trash by id only", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "st-"));
  // 300+ MB of test files: never left behind.
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const d of ["Downloads", "Pictures", "Videos", "Documents"]) mkdirSync(join(home, d));
  const MB = 1024 * 1024;
  const old = (Date.now() - 120 * 86_400_000) / 1000;
  writeFileSync(join(home, "Videos", "trip.mp4"), Buffer.alloc(301 * MB));
  writeFileSync(join(home, "Downloads", "setup.exe"), Buffer.alloc(2 * MB));
  utimesSync(join(home, "Downloads", "setup.exe"), old, old);
  writeFileSync(join(home, "Downloads", "notes.pdf"), Buffer.alloc(MB));
  utimesSync(join(home, "Downloads", "notes.pdf"), old, old);
  writeFileSync(join(home, "Pictures", "Screenshot 2025.png"), Buffer.alloc(10));
  utimesSync(join(home, "Pictures", "Screenshot 2025.png"), old, old);
  const same = Buffer.alloc(3 * MB, 7);
  writeFileSync(join(home, "Documents", "a.pdf"), same);
  utimesSync(join(home, "Documents", "a.pdf"), old, old);
  writeFileSync(join(home, "Downloads", "a (1).pdf"), same);
  const st = new Storage(home);
  const r = await st.scan();
  assert.ok(r.kinds.video >= 301 * MB);
  const card = (id: string) => r.cards.find((c) => c.id === id)?.files.map((f) => f.name) ?? [];
  assert.deepEqual(card("compress-videos"), ["trip.mp4"]);
  assert.deepEqual(card("installers"), ["setup.exe"]);
  assert.deepEqual(card("old-downloads"), ["notes.pdf"]);
  assert.deepEqual(card("screenshots"), ["Screenshot 2025.png"]);
  assert.deepEqual(card("duplicates"), ["a (1).pdf"]);
  const dup = r.cards.find((c) => c.id === "duplicates")!.files[0]!;
  assert.equal(dup.folder, `~${sep}Downloads`);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const res = await st.remove([dup.id, "nope"], async (p) => renameSync(p, join(bin, "x")));
  assert.deepEqual(res.done, [dup.id]);
  assert.equal(res.failed[0]!.id, "nope");
  assert.ok(!existsSync(join(home, "Downloads", "a (1).pdf")));
  assert.ok(!st.last!.cards.some((c) => c.id === "duplicates"));
});

test("storage: files inside projects are never offered as duplicates and are marked for Select all", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "st-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const MB = 1024 * 1024;
  const hdri = Buffer.alloc(2 * MB, 9);
  // The same starter asset in two Unreal projects: both must stay.
  for (const name of ["GameA", "GameB"]) {
    const sc = join(home, "Documents", "Unreal Projects", name, "Content", "StarterContent");
    mkdirSync(sc, { recursive: true });
    writeFileSync(join(home, "Documents", "Unreal Projects", name, `${name}.uproject`), "{}");
    writeFileSync(join(sc, "HDRI_Epic_Courtyard_Daylight.uasset"), hdri);
  }
  // A loose copy in Downloads is a real extra (the project copy is the one kept).
  mkdirSync(join(home, "Downloads"));
  writeFileSync(join(home, "Downloads", "HDRI_Epic_Courtyard_Daylight.uasset"), hdri);
  // Two copies inside a git repository, and a big file under a Saved folder.
  mkdirSync(join(home, "Desktop", "site", ".git"), { recursive: true });
  writeFileSync(join(home, "Desktop", "site", "a.bin"), Buffer.alloc(MB, 3));
  writeFileSync(join(home, "Desktop", "site", "b.bin"), Buffer.alloc(MB, 3));
  mkdirSync(join(home, "Desktop", "Saved"));
  writeFileSync(join(home, "Desktop", "Saved", "big.mp4"), Buffer.alloc(501 * MB));
  const r = await new Storage(home).scan();
  const card = (id: string) => r.cards.find((c) => c.id === id)?.files ?? [];
  assert.deepEqual(card("duplicates").map((f) => f.folder), [`~${sep}Downloads`]);
  const big = card("large").find((f) => f.name === "big.mp4");
  assert.equal(big?.inProject, true);
  assert.equal(r.top.other.find((f) => f.folder === `~${sep}Downloads`)?.inProject, undefined);
});

test("storage helpers: the drive of an install folder or command line", () => {
  assert.equal(driveOf("E:\\SteamLibrary"), "E:");
  assert.equal(driveOf("c:/Games"), "C:");
  assert.equal(driveOf('"D:\\Tools\\uninst.exe" /S'), "D:");
  assert.equal(driveOf("MsiExec.exe /X{1234}"), undefined);
  assert.equal(driveOf("\\\\server\\share\\app"), undefined);
  assert.equal(driveOf("/usr/bin"), undefined);
  assert.equal(driveOf(undefined), undefined);
});

test("storage helpers: project roots", () => {
  assert.ok(isProjectRoot(["Game.uproject", "Content"]));
  assert.ok(isProjectRoot(["Assets", "ProjectSettings", "Packages"]));
  assert.ok(isProjectRoot(["project.godot"]));
  assert.ok(isProjectRoot(["App.SLN"]));
  assert.ok(isProjectRoot(["package.json"]));
  assert.ok(isProjectRoot([".git", "README.md"]));
  assert.ok(!isProjectRoot(["Assets", "photos"]));
  assert.ok(!isProjectRoot(["notes.pdf", "Projects"]));
});

test("storage helpers: kinds by name, Flatpak sizes", () => {
  assert.equal(fileKind("a.MKV"), "video");
  assert.equal(fileKind("b.heic"), "image");
  assert.equal(fileKind("c.msi"), "archive");
  assert.equal(parseSize("1.5 GB"), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseSize("300 MB"), 300 * 1024 ** 2);
});

test("storage: a compressed video's original stays removable after a new scan, and all ready originals go at once", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "st-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "Videos"));
  const v = (n: string, bytes: number) => {
    writeFileSync(join(home, "Videos", n), Buffer.alloc(bytes, 1));
    return join(home, "Videos", n);
  };
  const st = new Storage(home);
  const a = await st.addCompressed(v("a.mp4", 1000), v("a.compressed.mp4", 400), true);
  const b = await st.addCompressed(v("b.mp4", 1000), v("b.compressed.mp4", 5), true); // under 1%: broken copy
  const c = await st.addCompressed(v("c.mp4", 1000), v("c.compressed.mp4", 400), false); // never checked to play
  const d = await st.addCompressed(v("d.mp4", 1000), v("d.compressed.mp4", 300), true);
  assert.ok(a && b && c && d);
  assert.equal(await st.addCompressed(join(home, "Videos", "none.mp4"), join(home, "Videos", "a.mp4"), true), undefined);
  // A new scan clears the scan's ids (small files are not listed); the originals still resolve.
  await st.scan();
  assert.equal(st.pathOf(a.original.id), join(home, "Videos", "a.mp4"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const toBin = async (p: string) => renameSync(p, join(bin, p.split(sep).pop()!));
  const one = await st.remove([d.original.id], toBin);
  assert.deepEqual(one.done, [d.original.id]);
  const state = await st.compressedOriginals();
  assert.deepEqual(state.map((o) => [o.gone, o.ready]), [[false, true], [false, false], [false, false], [true, false]]);
  const all = await st.removeOriginals(toBin);
  assert.deepEqual(all.done, [a.original.id]);
  assert.equal(all.freed, 1000);
  assert.ok(existsSync(join(home, "Videos", "a.compressed.mp4")) && existsSync(join(home, "Videos", "b.mp4")) && existsSync(join(home, "Videos", "c.mp4")));
  assert.equal((await st.compressedOriginals([a.original.id]))[0]!.gone, true);
  // An id KesherAI never listed is still refused.
  assert.equal((await st.remove(["0123456789abcdef"], toBin)).failed.length, 1);
});

test("storage helpers: whole copies and ffmpeg's length", () => {
  assert.ok(copyLooksWhole(1000, 400));
  assert.ok(!copyLooksWhole(1000, 0));
  assert.ok(!copyLooksWhole(1000, 10));
  assert.ok(!copyLooksWhole(1000, 1000));
  assert.equal(parseDuration("  Duration: 01:02:03.50, start: 0.000000, bitrate: 5000 kb/s"), 3723.5);
  assert.equal(parseDuration("Invalid data found when processing input"), undefined);
});
