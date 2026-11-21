import { test } from "node:test";
import assert from "node:assert/strict";
import { EDIT_ACTIONS, backHref, checkRequest, editInActions, isEditor, openHref, returnChipHref, runHandoff, ticketOf, type EditorId, type HandoffDeps, type OpenRequest } from "./editor-handoff";
import { pageInput } from "./page-input";

const req: OpenRequest = { from: "model-editor", to: "image-editor", chat: "abc", file: "shared/wood.png", ret: "shared/chair-working.glb", slot: "Seat:map", guide: "shared/uv.png" };

test("the open payload is the route the target's pageInput reads back as a return ticket", () => {
  const href = openHref(req);
  assert.match(href, /^#\/p\/image-editor\/editor\?/);
  const input = pageInput(href.split("?")[1]!, ["image"]);
  assert.deepEqual(input, { conversationId: "abc", path: "shared/wood.png", returnTo: { plugin: "model-editor", path: "shared/chair-working.glb", slot: "Seat:map" }, guide: "shared/uv.png" });
  assert.deepEqual(ticketOf(input), input!.returnTo);
});

test("the return payload reopens the first editor with the result in its slot; the video editor gets the sound as its own contract", () => {
  const back = backHref("abc", { plugin: "model-editor", path: "shared/chair-working.glb", slot: "Seat:map" }, "shared/wood-edited.png");
  const input = pageInput(back.split("?")[1]!, ["model"]);
  assert.deepEqual(input?.back, { path: "shared/wood-edited.png", slot: "Seat:map" });
  const toVideo = backHref("abc", { plugin: "video-editor", path: "shared/clip.mp4", slot: "audio" }, "shared/mix.wav");
  assert.deepEqual(pageInput(toVideo.split("?")[1]!, ["video"]), { conversationId: "abc", path: "shared/clip.mp4", sound: "shared/mix.wav" });
});

test("the Return chip reopens the editor with no result, for both kinds of ticket", () => {
  assert.equal(returnChipHref("a b", { plugin: "model-editor", path: "x/y.glb", slot: "s" }), "#/p/model-editor/editor?c=a%20b&f=x%2Fy.glb");
  // A sound editor opened from a video has only `ret` (no `retp`).
  const sound = pageInput("c=abc&f=s.wav&ret=clip.mp4", ["sound"]);
  assert.deepEqual(ticketOf(sound), { plugin: "video-editor", path: "clip.mp4", slot: "audio" });
  assert.equal(ticketOf(pageInput("c=abc&f=s.wav", ["sound"])), undefined, "a page opened from the chat has no chip");
  assert.equal(ticketOf(undefined), undefined);
});

test("a request is checked before anything is saved or opened", () => {
  assert.equal(checkRequest(req), undefined);
  assert.ok(checkRequest({ ...req, to: "model-editor" }), "not itself");
  assert.ok(checkRequest({ ...req, to: "evil" as EditorId }), "only editors");
  assert.ok(checkRequest({ ...req, file: "shared/x.glb" }), "only a file the target opens");
  assert.ok(checkRequest({ ...req, ret: "shared/x.png" }), "the way back is a file of the first editor");
  assert.ok(checkRequest({ ...req, slot: "<script>" }), "a safe slot");
  assert.ok(checkRequest({ ...req, chat: "../x" }), "a plain chat id");
  assert.ok(checkRequest({ ...req, guide: "shared/g.glb" }), "the guide is a picture");
  assert.equal(isEditor("toString"), false);
});

test("the Edit in… menus: the 3D entry is hidden when no picture-to-3D tool exists", () => {
  assert.deepEqual(editInActions("image-editor", { image3d: false }), []);
  assert.deepEqual(editInActions("image-editor", { image3d: true }).map((a) => a.id), ["make3d"]);
  assert.deepEqual(editInActions("video-editor", { image3d: false }).map((a) => a.to), ["sound-editor"]);
  assert.deepEqual(editInActions("model-editor", { image3d: false }).map((a) => a.to), ["image-editor"]);
  assert.equal(editInActions("sound-editor", { image3d: true }).length, 0);
  assert.ok(EDIT_ACTIONS.every((a) => a.he && a.en && a.he.length <= 160 && a.from !== a.to));
});

/** A fake app: which editors are installed, what the Install window answers, and where it went. */
function app(installed: EditorId[], accept: boolean) {
  const log: string[] = [];
  const have = new Set(installed);
  const deps: HandoffDeps = {
    installed: async (id) => have.has(id),
    offerInstall: async (id, why) => {
      log.push(`offer:${id}:${why}`);
      if (accept) have.add(id);
      return accept;
    },
    go: (href) => void log.push(`go:${href}`),
  };
  return { deps, log };
}

test("an installed editor opens at once, without the Install window", async () => {
  const a = app(["image-editor"], false);
  assert.equal(await runHandoff(a.deps, "image-editor", "#/x", "why"), "opened");
  assert.deepEqual(a.log, ["go:#/x"]);
});

test("a missing editor shows the Install window first, then the same action goes on", async () => {
  const a = app([], true);
  assert.equal(await runHandoff(a.deps, "sound-editor", "#/p/sound-editor/editor?c=1", "Changing the sound"), "opened");
  assert.deepEqual(a.log, ["offer:sound-editor:Changing the sound", "go:#/p/sound-editor/editor?c=1"]);
});

test("cancelling the Install window opens nothing; an install that does not come up fails without opening", async () => {
  const no = app([], false);
  assert.equal(await runHandoff(no.deps, "model-editor", "#/x", "w"), "declined");
  assert.ok(!no.log.some((l) => l.startsWith("go:")));
  const odd: HandoffDeps = { installed: async () => false, offerInstall: async () => true, go: () => assert.fail("must not open") };
  assert.equal(await runHandoff(odd, "model-editor", "#/x", "w"), "failed");
});
