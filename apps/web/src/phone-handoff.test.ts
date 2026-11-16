import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneHandoffUrl } from "./phone-handoff";

test("continue on the phone: the chat's last messages ride in the phone page's address, Hebrew intact", () => {
  assert.equal(phoneHandoffUrl("http://localhost/", null), "http://localhost/local.html?new=1");
  const u = new URL(phoneHandoffUrl("http://localhost", { title: "סוכרת", messages: [{ role: "user", content: "מה זה A1C?" }, { role: "assistant", content: "ממוצע סוכר+/=" }] }));
  const b64 = u.searchParams.get("handoff")!;
  assert.match(b64, /^[\w-]+$/);
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const back = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  assert.deepEqual(back, { t: "סוכרת", m: [["u", "מה זה A1C?"], ["a", "ממוצע סוכר+/="]] });
});
