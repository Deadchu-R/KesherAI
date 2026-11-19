import { test } from "node:test";
import assert from "node:assert/strict";
import { loadReasonText } from "./load-reason.js";

test("loadReasonText names why the model was loaded and how long ago", () => {
  const now = 1_000_000_000;
  assert.equal(loadReasonText(undefined, now), "");
  assert.match(loadReasonText({ kind: "chat", chats: ["Plans"], at: now - 5 * 60_000 }, now), /נטען כי: צ׳אט ביקש אותו: "Plans" · לפני 5 דק׳/);
  assert.match(loadReasonText({ kind: "request", at: now }, now), /ברקע.*עכשיו/);
  assert.match(loadReasonText({ kind: "startup", at: now - 3 * 3_600_000 }, now), /בהפעלה · לפני 3 שע׳/);
});
