import assert from "node:assert/strict";
import { test } from "node:test";
import { folderOf, nativeProjectFile, normalizePath, projectFileInFolder, samePath } from "./project-path.js";

test("Unreal 4's forward-slash project file matches the scan's Windows folder", () => {
  const file = "C:/Users/someone/OneDrive/Documents/Unreal Projects/ForMigration/ForMigration.uproject";
  assert.equal(projectFileInFolder(file, "C:\\Users\\someone\\OneDrive\\Documents\\Unreal Projects\\ForMigration"), true);
  assert.equal(projectFileInFolder(file, "c:\\users\\someone\\onedrive\\documents\\unreal projects\\formigration\\"), true);
  assert.equal(projectFileInFolder(file, "C:\\Users\\someone\\Documents\\Unreal Projects\\Other"), false);
  assert.equal(projectFileInFolder(undefined, "C:\\x"), false);
});

test("paths are compared whatever their slashes, case (Windows) and trailing slash", () => {
  assert.equal(samePath("D:\\Games\\A\\", "d:/games/a"), true);
  assert.equal(samePath("D:\\Games\\A", "D:\\Games\\B"), false);
  assert.equal(samePath("", ""), false);
  assert.equal(normalizePath("\\\\host\\Share\\P"), "\\\\host\\share\\p");
  assert.equal(folderOf("C:/g/P/P.uproject"), "C:\\g\\P");
  if (process.platform !== "win32") assert.equal(folderOf("/home/u/g/P.uproject"), "/home/u/g"); // a POSIX path only on POSIX
  assert.equal(nativeProjectFile("C:/g/P/P.uproject"), "C:\\g\\P\\P.uproject");
});

test("a link to the same folder counts as the same place", async () => {
  const { mkdtempSync, symlinkSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "kesher-pp-"));
  try {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"), "dir");
    assert.equal(samePath(join(root, "alias"), join(root, "real")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
