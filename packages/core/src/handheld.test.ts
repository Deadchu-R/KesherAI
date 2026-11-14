import { test } from "node:test";
import assert from "node:assert/strict";
import { handheldOf } from "./handheld.js";

test("handheld gaming PCs are known by their firmware's product name", () => {
  assert.equal(handheldOf("ROG Xbox Ally X RC73XA_RC73XA"), "ROG Xbox Ally X");
  assert.equal(handheldOf("ROG Xbox Ally RC73YA_RC73YA"), "ROG Xbox Ally");
  assert.equal(handheldOf("ROG Ally X RC72LA_RC72LA"), "ROG Ally X");
  assert.equal(handheldOf("ROG Ally RC71L_RC71L"), "ROG Ally");
  assert.equal(handheldOf("Jupiter"), "Steam Deck");
  assert.equal(handheldOf("83E1"), "Legion Go");
  assert.equal(handheldOf("System Product Name"), undefined);
  assert.equal(handheldOf("ROG STRIX Z790-E GAMING WIFI"), undefined);
});
