import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "./assets.js";
import { AssetBank, bankKindOf } from "./asset-bank.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bank-"));
  const assetsDir = join(root, "assets");
  await mkdir(assetsDir);
  const store = new AssetStore(assetsDir);
  const chats = [{ id: A, title: "Cats", kind: "chat" }, { id: B, title: "Code", kind: "code" }];
  const bank = new AssetBank({ assets: store, chats: () => chats, folderOf: (c) => join(root, "out", c.id) });
  await mkdir(join(root, "out", A, "shared"), { recursive: true });
  await mkdir(join(root, "out", B), { recursive: true });
  return { root, store, bank };
}

test("bankKindOf names the media kinds", () => {
  assert.equal(bankKindOf("a.PNG"), "image");
  assert.equal(bankKindOf("x/song.mp3"), "audio");
  assert.equal(bankKindOf("chair.glb"), "model");
  assert.equal(bankKindOf("clip.mp4"), "video");
  assert.equal(bankKindOf("notes.txt"), undefined);
});

test("the bank lists assets and chats' media, not code sessions or other files", async () => {
  const { root, store, bank } = await setup();
  await store.save(new Uint8Array([1, 2, 3]), "image/png", { meta: { prompt: "a cat" } });
  await writeFile(join(root, "out", A, "song.mp3"), "abc");
  await writeFile(join(root, "out", A, "notes.txt"), "x");
  await writeFile(join(root, "out", B, "game.png"), "x");
  const items = await bank.list();
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.kind === "image" && i.prompt === "a cat"));
  assert.ok(items.some((i) => i.kind === "audio" && i.chat?.title === "Cats"));
  assert.equal((await bank.list("audio")).length, 1);
});

test("ids cannot leave the chat's folder", async () => {
  const { bank } = await setup();
  const bad = (p: string) => `f.${A}.${Buffer.from(p).toString("base64url")}`;
  assert.equal(await bank.pathOf(bad("../../x.png")), undefined);
  assert.equal(await bank.pathOf(bad("/etc/x.png")), undefined);
  assert.equal(await bank.pathOf(bad("C:/x.png")), undefined);
  assert.equal(await bank.pathOf(`f.${B}.${Buffer.from("game.png").toString("base64url")}`), undefined);
  assert.equal(await bank.pathOf("a.not-an-id"), undefined);
});

test("duplicates group the same bytes, oldest kept; copy and delete", async () => {
  const { root, store, bank } = await setup();
  const asset = await store.save(new Uint8Array(Buffer.from("same bytes")), "image/png");
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(join(root, "out", A, "copy.png"), "same bytes");
  await writeFile(join(root, "out", A, "other.png"), "different!");
  const groups = await bank.duplicates();
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.items[0], `a.${asset.id}`);
  assert.equal(groups[0]!.bytes, 10);
  const [path] = await bank.copyTo([`a.${asset.id}`], A);
  assert.match(path!, /^shared\/.+\.png$/);
  assert.equal(await readFile(join(root, "out", A, path!), "utf8"), "same bytes");
  assert.equal(await bank.delete([groups[0]!.items[1]!, `a.${asset.id}`]), 2);
  assert.equal(existsSync(join(root, "out", A, "copy.png")), false);
  assert.equal(await store.recordOf(asset.id), undefined);
});
