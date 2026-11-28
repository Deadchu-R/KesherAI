import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "../server.js";
import { imageEdit } from "./image-edit.js";
import { imageSize, resizeImage, versionMeta, type SharpLike } from "../image-ops.js";

/** A 2x1 PNG header is enough for the size reader. */
const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

/** A fake `sharp` that records the resize it was asked for and returns its input marked. */
function fakeSharp(seen: unknown[]): SharpLike {
  return (input) => ({ resize: (o) => (seen.push(o), { toBuffer: async () => Buffer.concat([Buffer.from("R"), Buffer.from(input)]) }) });
}

test("resizeImage: uses sharp, keeps proportions with one side, and validates the sides", async () => {
  const seen: unknown[] = [];
  const r = await resizeImage(Buffer.from("x"), { width: 100 }, async () => fakeSharp(seen));
  assert.equal(r?.via, "sharp");
  assert.equal(Buffer.from(r!.data).toString(), "Rx");
  await resizeImage(Buffer.from("x"), { width: 100, height: 50 }, async () => fakeSharp(seen));
  await resizeImage(Buffer.from("x"), { width: 100, height: 50, keep: true }, async () => fakeSharp(seen));
  assert.deepEqual(seen, [{ width: 100, fit: "inside" }, { width: 100, height: 50, fit: "fill" }, { width: 100, height: 50, fit: "inside" }]);
  await assert.rejects(resizeImage(Buffer.from("x"), {}, async () => fakeSharp(seen)));
  await assert.rejects(resizeImage(Buffer.from("x"), { width: 99999 }, async () => fakeSharp(seen)));
  await assert.rejects(resizeImage(Buffer.from("x"), { height: 1.5 }, async () => fakeSharp(seen)));
});

test("resizeImage: without sharp it says so (the panel resizes on its own canvas)", async () => {
  assert.equal(await resizeImage(Buffer.from("x"), { width: 10 }, async () => undefined), undefined);
});

test("imageSize and versionMeta", () => {
  assert.deepEqual(imageSize(png(640, 480)), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from("nope")), undefined);
  assert.deepEqual(versionMeta({ id: "a", meta: { prompt: "fox", version: 2 } }, "crop"), { prompt: "fox", parent: "a", version: 3, op: "crop" });
  assert.deepEqual(versionMeta({ id: "b" }, "resize"), { parent: "b", version: 2, op: "resize" });
});

test("image routes: info, resize (sharp and fallback) and a saved version remember their parent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-img-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  const app = server.app;
  try {
    const first = await server.services.assets.save(png(640, 480), "image/png", { sourceModelId: "sd/x", meta: { prompt: "a fox" } });
    const info = (await app.inject({ url: `/api/images/${first.id}/info` })).json() as Record<string, unknown>;
    assert.deepEqual([info.width, info.height, info.version, info.prompt, info.model], [640, 480, 1, "a fox", "sd/x"]);
    assert.equal((await app.inject({ url: "/api/images/not-an-id/info" })).statusCode, 404);

    imageEdit.sharp = async () => undefined;
    const none = (await app.inject({ method: "POST", url: "/api/images/resize", payload: { id: first.id, width: 320 } })).json() as { via: string; asset?: unknown };
    assert.deepEqual(none, { via: "canvas" });
    imageEdit.sharp = async () => fakeSharp([]);
    const made = (await app.inject({ method: "POST", url: "/api/images/resize", payload: { id: first.id, width: 320 } })).json() as { via: string; asset: { id: string; meta: Record<string, unknown> } };
    assert.equal(made.via, "sharp");
    assert.deepEqual([made.asset.meta.parent, made.asset.meta.version, made.asset.meta.op, made.asset.meta.prompt], [first.id, 2, "resize", "a fox"]);
    assert.equal((await app.inject({ method: "POST", url: "/api/images/resize", payload: { id: first.id } })).statusCode, 400);

    const image = `data:image/png;base64,${png(10, 10).toString("base64")}`;
    const v = (await app.inject({ method: "POST", url: "/api/images/version", payload: { parent: made.asset.id, op: "crop", image } })).json() as { asset: { id: string; meta: Record<string, unknown> } };
    assert.deepEqual([v.asset.meta.parent, v.asset.meta.version, v.asset.meta.op], [made.asset.id, 3, "crop"]);
    assert.equal((await app.inject({ method: "POST", url: "/api/images/version", payload: { parent: first.id, image: "data:text/html;base64,AAAA" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/images/version", payload: { parent: "x", image } })).statusCode, 404);
    const root = (await app.inject({ method: "POST", url: "/api/images/version", payload: { op: "import", image } })).json() as { asset: { meta: Record<string, unknown> } };
    assert.deepEqual(root.asset.meta, { version: 1, op: "import" });
  } finally {
    delete imageEdit.sharp;
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
