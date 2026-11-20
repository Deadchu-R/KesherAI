import { test } from "node:test";
import assert from "node:assert/strict";
import { assetIdOf, findFact, formatDuration, mediaKindOf } from "./chat-inline.js";

test("a file's kind comes from its MIME type, then its extension", () => {
  assert.equal(mediaKindOf("video/webm"), "video");
  assert.equal(mediaKindOf("audio/mpeg; charset=binary"), "audio");
  assert.equal(mediaKindOf("image/png"), "image");
  assert.equal(mediaKindOf("image/svg+xml"), null, "an SVG can carry script: not shown as a picture");
  assert.equal(mediaKindOf("model/gltf-binary"), "model");
  assert.equal(mediaKindOf("application/octet-stream", "out/song.MP3"), "audio");
  assert.equal(mediaKindOf("", "shared/clip.mp4?x=1"), "video");
  assert.equal(mediaKindOf(undefined, "dist/game.exe"), null);
  assert.equal(mediaKindOf(null, null), null);
});

test("asset links are recognised, other links are not", () => {
  const id = "0f8e2a4c-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.equal(assetIdOf(`/api/assets/${id}`), id);
  assert.equal(assetIdOf(`/api/assets/${id.toUpperCase()}?token=abc`), id);
  assert.equal(assetIdOf(`http://192.168.1.5:5173/api/assets/${id}`), id);
  assert.equal(assetIdOf(`/api/assets/${id}/../../etc`), null);
  assert.equal(assetIdOf("/api/assets/not-an-id"), null);
  assert.equal(assetIdOf("https://example.com/a.png"), null);
});

test("a player's length reads as m:ss or h:mm:ss", () => {
  assert.equal(formatDuration(7.4), "0:07");
  assert.equal(formatDuration(205), "3:25");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(Number.NaN), "");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "");
});

test("Undo finds the fact a remember call kept (spaces folded, its topic first, the last match)", () => {
  const topics = [
    { id: "t1", title: "About you", facts: [{ text: "Likes tea" }] },
    { id: "t2", title: "Preferences", facts: [{ text: "Answers in Hebrew" }, { text: "Likes tea" }] },
  ];
  assert.deepEqual(findFact(topics, "  likes   tea ", "Preferences"), { topicId: "t2", index: 1 });
  assert.deepEqual(findFact(topics, "Likes tea"), { topicId: "t1", index: 0 });
  assert.deepEqual(findFact(topics, "Answers in Hebrew", "Nope"), { topicId: "t2", index: 0 });
  assert.equal(findFact(topics, "Gone"), null);
  assert.equal(findFact(topics, "   "), null);
});
