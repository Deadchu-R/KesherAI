import assert from "node:assert/strict";
import { test } from "node:test";
import { rumbleFor } from "./pad-rumble.js";

test("the controller rumbles when an answer ends or something starts waiting", () => {
  assert.equal(rumbleFor({ a: "running" }, {}), "done");
  assert.equal(rumbleFor({ a: "running" }, { a: "waiting" }), "waiting");
  assert.equal(rumbleFor({}, { a: "running" }), undefined);
  assert.equal(rumbleFor({ a: "waiting" }, { a: "waiting" }), undefined);
  assert.equal(rumbleFor({ a: "waiting" }, {}), undefined);
});
