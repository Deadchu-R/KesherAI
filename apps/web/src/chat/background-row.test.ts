import assert from "node:assert/strict";
import { test } from "node:test";
import { clockText } from "./clock-text";

test("clockText: minutes and seconds, hours past an hour", () => {
  assert.equal(clockText(72_000), "1:12");
  assert.equal(clockText(5_000), "0:05");
  assert.equal(clockText(3_725_000), "1:02:05");
  assert.equal(clockText(-5), "0:00");
});
