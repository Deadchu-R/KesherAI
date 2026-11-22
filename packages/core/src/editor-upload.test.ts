import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEditorUpload, cleanUploadName, EDITOR_UPLOAD_MAX, saveUploadPiece } from "./editor-upload.js";
import { createKesherServer } from "./server.js";

test("type allowlist: models, pictures, sounds, videos and a model's own parts only; scripts never", () => {
  for (const n of ["a.glb", "a.GLTF", "a.fbx", "a.obj", "a.stl", "a.ply", "a.bin", "a.mtl", "a.png", "a.jpeg", "a.webp", "a.bmp", "a.wav", "a.m4a", "a.flac", "a.mp4", "a.mov", "a.webm"]) {
    assert.equal(checkEditorUpload(n, 10).ok, true, n);
  }
  for (const n of ["a.exe", "a.js", "a.html", "a.svg", "a.sh", "a.usdz", "a.psd", "noext", "a.glb.exe", ".glb"]) {
    assert.equal(checkEditorUpload(n, 10).ok, false, n);
  }
});

test("size limits: not empty, not over 1 GB", () => {
  assert.equal(checkEditorUpload("a.glb", 0).ok, false);
  assert.equal(checkEditorUpload("a.glb", -5).ok, false);
  assert.equal(checkEditorUpload("a.glb", Number.NaN).ok, false);
  assert.equal(checkEditorUpload("a.glb", EDITOR_UPLOAD_MAX).ok, true);
  assert.equal(checkEditorUpload("a.glb", EDITOR_UPLOAD_MAX + 1).ok, false);
});

test("names lose their folders and odd characters", () => {
  assert.equal(cleanUploadName("..\\..\\evil/../my model<1>.glb"), "my model_1_.glb");
  assert.equal(cleanUploadName("..."), "file");
  assert.equal(cleanUploadName("דגם.glb"), "דגם.glb");
});

test("pieces join in order into shared/, a second file with the same name is numbered, a wrong size is refused", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kesher-piece-"));
  const base = { folder, id: "abcdefgh-1", total: 3, name: "clip.mp4", size: 9 };
  assert.deepEqual(await saveUploadPiece({ ...base, index: 2, bytes: Buffer.from("ghi") }), { done: false, received: 1 });
  await saveUploadPiece({ ...base, index: 0, bytes: Buffer.from("abc") });
  const done = await saveUploadPiece({ ...base, index: 1, bytes: Buffer.from("def") });
  assert.ok(done.done);
  assert.equal(await readFile(join(folder, "shared", "clip.mp4"), "utf8"), "abcdefghi");
  assert.deepEqual(await readdir(join(folder, ".upload-tmp")), []);
  const again = await saveUploadPiece({ ...base, id: "abcdefgh-2", total: 1, index: 0, size: 3, bytes: Buffer.from("xyz") });
  assert.ok(again.done && again.name === "clip (2).mp4");
  await assert.rejects(saveUploadPiece({ ...base, id: "abcdefgh-3", total: 1, index: 0, size: 99, bytes: Buffer.from("xyz") }), /add up/);
  await assert.rejects(saveUploadPiece({ ...base, id: "../escape1", index: 0, bytes: Buffer.from("x") }), /id/);
  await assert.rejects(saveUploadPiece({ ...base, name: "run.exe", index: 0, bytes: Buffer.from("x") }), /cannot be opened/);
  await assert.rejects(saveUploadPiece({ ...base, index: 3, bytes: Buffer.from("x") }), /place/);
});

test("the upload route: pieces in, the file in the chat's shared/ folder; a bad type, a bad id and an unknown chat are refused", async () => {
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-upload-")), autodetect: false, pluginRoots: [] });
  try {
    const c = (await s.app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat", modelId: "x/y" } })).json() as { id: string };
    await s.services.conversations.open(c.id);
    const send = (_unused: string, q: string, body: string, chat = c.id) => s.app.inject({ method: "POST", url: `/api/conversations/${chat}/files/piece?${q}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from(body) });
    const q = (i: number, extra = "") => `name=${encodeURIComponent("a model.glb")}&upload=route-test-1&index=${i}&total=2&size=6${extra}`;
    assert.deepEqual((await send("", q(0), "abc")).json(), { done: false });
    const last = (await send("", q(1), "def")).json() as { done: boolean; name: string };
    assert.deepEqual(last, { done: true, name: "a model.glb" });
    assert.equal((await send("", "name=x.exe&upload=route-test-2&index=0&total=1&size=3", "abc")).statusCode, 415);
    assert.equal((await send("", "name=x.glb&upload=a&index=0&total=1&size=3", "abc")).statusCode, 400);
    assert.equal((await send("", "name=x.glb&upload=route-test-3&index=0&total=1&size=3", "abc", "nope")).statusCode, 404);
  } finally {
    await s.close();
  }
});
