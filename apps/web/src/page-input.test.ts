import { test } from "node:test";
import assert from "node:assert/strict";
import { pageInput } from "./page-input.js";

test("a page gets a chat's file only when it is a picture and the page declared the picture models", () => {
  assert.deepEqual(pageInput("c=abc-1&f=shared%2Fcat.png", ["image"]), { conversationId: "abc-1", path: "shared/cat.png" });
  assert.equal(pageInput("c=abc&f=.env", ["image"]), undefined, "not a picture");
  assert.equal(pageInput("c=abc&f=cat.png", ["speech"]), undefined, "the page did not declare pictures");
  assert.equal(pageInput("c=abc&f=cat.png", undefined), undefined);
  assert.equal(pageInput("c=..%2Fx&f=cat.png", ["image"]), undefined, "a strange chat id");
  assert.equal(pageInput("", ["image"]), undefined);
  assert.deepEqual(pageInput("c=abc&f=clip.mp4", ["video"]), { conversationId: "abc", path: "clip.mp4" });
  assert.equal(pageInput("c=abc&f=clip.mp4", ["image"]), undefined, "a picture page gets no video");
});
