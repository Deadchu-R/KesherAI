import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_CARDS_PER_TURN } from "@kesher/shared";
import { resolveSendable, sendFileTool } from "./send-file.js";
import type { ToolContext } from "./tools.js";

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "kesher-send-"));
  const workspace = join(base, "chat");
  const granted = join(base, "project");
  const outside = join(base, "secret");
  for (const d of [workspace, granted, outside]) await mkdir(d);
  await writeFile(join(workspace, "a.md"), "# hi");
  await writeFile(join(granted, "p.txt"), "project file");
  await writeFile(join(outside, "key.txt"), "secret");
  const ctx = (): ToolContext => ({ workspace, extraRoots: [granted], signal: new AbortController().signal, recordChange: () => undefined });
  return { base, workspace, granted, outside, ctx };
}

test("send_file path guard: refuses .., outside folders and links out, folders and missing files", async () => {
  const { workspace, outside, ctx } = await setup();
  const c = ctx();
  await assert.rejects(resolveSendable(c, "../secret/key.txt"), /outside|folders/);
  await assert.rejects(resolveSendable(c, join(outside, "key.txt")), /outside|folders/);
  await symlink(outside, join(workspace, "link")).catch(() => undefined);
  await symlink(join(outside, "key.txt"), join(workspace, "k.txt")).catch(() => undefined);
  await assert.rejects(resolveSendable(c, "link/key.txt"), /outside|folders/);
  await assert.rejects(resolveSendable(c, "k.txt"), /outside|folders/);
  await mkdir(join(workspace, "dir"));
  await assert.rejects(resolveSendable(c, "dir"), /not a file/);
  await assert.rejects(resolveSendable(c, "nope.txt"), /not a file/);
  await assert.rejects(resolveSendable({ extraRoots: [] }, "a.md"), /no folder/);
});

test("send_file: a file of the chat's folder gets a card; one of a granted folder is copied to sent/", async () => {
  const { workspace, granted, ctx } = await setup();
  const own = await resolveSendable(ctx(), "a.md");
  assert.equal(own.rel, "a.md");
  assert.equal(own.size, 4);
  const given = await resolveSendable(ctx(), join(granted, "p.txt"));
  assert.equal(given.rel, "sent/p.txt");
  assert.equal(await readFile(join(workspace, "sent", "p.txt"), "utf8"), "project file");
  const again = await resolveSendable(ctx(), join(granted, "p.txt"));
  assert.equal(again.rel, "sent/p (2).txt");
});

test("send_file card model: kind, caption trimmed, display, and at most 20 cards per turn", async () => {
  const { workspace, ctx } = await setup();
  await writeFile(join(workspace, "pic.png"), "x");
  const c = ctx();
  const r = await sendFileTool.run({ path: "pic.png", caption: "  a\n  picture ", display: "attach" }, c);
  assert.deepEqual(r.cards, [{ path: "pic.png", name: "pic.png", size: 1, kind: "image", display: "attach", caption: "a picture" }]);
  assert.deepEqual(r.files, ["pic.png"]);
  const plain = await sendFileTool.run({ path: "a.md" }, c);
  assert.equal(plain.cards?.[0]?.display, "render");
  assert.equal(plain.cards?.[0]?.kind, "markdown");
  for (let i = 2; i < MAX_FILE_CARDS_PER_TURN; i++) await sendFileTool.run({ path: "a.md" }, c);
  await assert.rejects(sendFileTool.run({ path: "a.md" }, c), /already sent 20/);
  // A new turn (a new signal) starts again.
  assert.ok((await sendFileTool.run({ path: "a.md" }, ctx())).cards);
});
