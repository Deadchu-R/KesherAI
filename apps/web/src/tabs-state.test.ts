import { test } from "node:test";
import assert from "node:assert/strict";
import { closeTab, openTab, pinTab, readTabs, stepTab } from "./tabs-state.js";

test("a page opens a preview tab, which the next page replaces until it is pinned; chats and editors are kept", () => {
  let tabs = openTab([], "#/", "#/settings");
  assert.deepEqual(tabs, [{ hash: "#/settings", preview: true }]);
  tabs = openTab(tabs, "#/settings", "#/models");
  assert.deepEqual(tabs, [{ hash: "#/models", preview: true }]);
  tabs = pinTab(tabs, "#/models");
  tabs = openTab(tabs, "#/models", "#/c/b");
  assert.deepEqual(tabs, [{ hash: "#/models" }, { hash: "#/c/b" }], "a chat is kept");
  tabs = openTab(tabs, "#/c/b", "#/p/video-editor/editor?c=b&f=x.mp4");
  assert.deepEqual(tabs.map((t) => !!t.preview), [false, false, false], "an editor is kept too");
  // A place already open switches to its tab (with its new query), and Home is never a tab.
  assert.deepEqual(openTab(tabs, "#/c/b", "#/models?x=1")[0], { hash: "#/models?x=1" });
  assert.deepEqual(openTab(tabs, "#/c/b", "#/"), tabs);
});

test("closing the tab showing goes to its neighbour, then Home; Ctrl+Tab goes round with Home first", () => {
  const tabs = [{ hash: "#/a" }, { hash: "#/b" }, { hash: "#/c" }];
  assert.deepEqual(closeTab(tabs, "#/b", "#/b"), { tabs: [{ hash: "#/a" }, { hash: "#/c" }], go: "#/c" });
  assert.deepEqual(closeTab(tabs, "#/c", "#/c").go, "#/b");
  assert.deepEqual(closeTab([{ hash: "#/a" }], "#/a", "#/a").go, "#/");
  assert.equal(closeTab(tabs, "#/a", "#/c").go, undefined);
  assert.equal(stepTab(tabs, "#/c", 1), "#/");
  assert.equal(stepTab(tabs, "#/", -1), "#/c");
});

test("stored tabs are read safely", () => {
  assert.deepEqual(readTabs('[{"hash":"#/a","preview":true},{"hash":"javascript:x"},{"hash":"#/"},5]'), [{ hash: "#/a", preview: true }]);
  assert.deepEqual(readTabs("not json"), []);
});
