import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uefnProjects, uefnTools } from "./uefn-tools.js";

test("UEFN projects are found, and Verse files are written only inside their Content folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "uefn-"));
  const content = join(home, "Documents", "Fortnite Projects", "Arena", "Plugins", "Arena", "Content");
  await mkdir(content, { recursive: true });
  assert.deepEqual((await uefnProjects(home)).map((p) => p.name), ["Arena"]);
  const [list, file] = uefnTools(home);
  await file!.run({ project: "arena", file: "game/my_device.verse", action: "write", text: "my_device := class(creative_device):\n" }, {} as never);
  assert.match(await readFile(join(content, "game", "my_device.verse"), "utf8"), /creative_device/);
  assert.match((await list!.run({}, {} as never)).output, /Arena: game[\\/]my_device\.verse/);
  await assert.rejects(file!.run({ project: "Arena", file: "../../x.verse", action: "write", text: "" }, {} as never), /Content folder/);
  await assert.rejects(file!.run({ project: "Arena", file: "a.txt", action: "write", text: "" }, {} as never), /\.verse/);
  await assert.rejects(file!.run({ project: "Nope", file: "a.verse", action: "read" }, {} as never), /No UEFN project/);
});
