import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutUserNote } from "./user-profile.js";

test("the note the models get about the user", () => {
  assert.equal(aboutUserNote({ name: " נועה ", address: "f" }), "The user's name is נועה. Address the user in the feminine (in Hebrew and other gendered languages).");
  assert.equal(aboutUserNote({ address: "p" }), "Address the user in the plural or gender-neutral forms (in Hebrew and other gendered languages).");
  assert.equal(aboutUserNote({}), "");
  assert.equal(aboutUserNote(undefined), "");
});
