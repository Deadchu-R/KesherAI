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
  assert.deepEqual(pageInput("c=abc&f=talk.m4a", ["sound"]), { conversationId: "abc", path: "talk.m4a" });
  assert.equal(pageInput("c=abc&f=talk.m4a", ["video"]), undefined);
  assert.deepEqual(pageInput("c=abc&f=clip.mp4&a=shared%2Fs.wav", ["video"]), { conversationId: "abc", path: "clip.mp4", sound: "shared/s.wav" });
  assert.deepEqual(pageInput("c=abc&f=s.wav&ret=clip.mp4", ["sound"]), { conversationId: "abc", path: "s.wav", returnVideo: "clip.mp4" });
  assert.deepEqual(pageInput("c=abc&f=chair.glb", ["model"]), { conversationId: "abc", path: "chair.glb" });
  // The hand-off between editors: where to go back, the slot, the guide; and the way back.
  assert.deepEqual(pageInput("c=abc&f=shared%2Fwood.png&ret=shared%2Fchair-working.glb&retp=model-editor&slot=Seat%3Amap&g=shared%2Fuv.png", ["image"]), { conversationId: "abc", path: "shared/wood.png", returnTo: { plugin: "model-editor", path: "shared/chair-working.glb", slot: "Seat:map" }, guide: "shared/uv.png" });
  assert.equal(pageInput("c=abc&f=w.png&ret=x.glb&retp=evil&slot=s", ["image"])?.returnTo, undefined, "only an editor to go back to");
  assert.equal(pageInput("c=abc&f=w.png&ret=x.env&retp=model-editor&slot=s", ["image"])?.returnTo, undefined, "only a file of that editor");
  assert.deepEqual(pageInput("c=abc&f=chair.glb&back=shared%2Fwood-edited.png&slot=Seat%3Amap", ["model"])?.back, { path: "shared/wood-edited.png", slot: "Seat:map" });
  assert.equal(pageInput("c=abc&f=chair.glb&back=x.png&slot=%3Cscript%3E", ["model"])?.back, undefined);
  assert.equal(pageInput("c=abc&f=chair.glb", ["image"]), undefined);
  assert.deepEqual(pageInput("c=abc&f=s.wav&ret=.env", ["sound"]), { conversationId: "abc", path: "s.wav" }, "only a video to go back to");
});
