import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveForTool } from "./workspace.js";

test("a relative path whose first folder is in a given folder goes there (Unity project in a chat)", async () => {
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = await mkdtemp(join(tmpdir(), "kesher-roots-"));
  const ws = join(base, "chat");
  const project = join(base, "Game");
  await mkdir(ws, { recursive: true });
  await mkdir(join(project, "Assets"), { recursive: true });
  assert.equal(await resolveForTool(ws, [project], "Assets/Scripts/A.cs"), join(project, "Assets", "Scripts", "A.cs"));
  assert.equal(await resolveForTool(ws, [project], "notes.md"), join(ws, "notes.md"));
});
