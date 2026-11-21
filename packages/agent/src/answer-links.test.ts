import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralizeLinks } from "./answer-links.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("an invented player or file link keeps only its text", async () => {
  assert.equal(await neutralizeLinks("הנה השיר: [▶️ נגן שיר](download://music/hollow-knight.mp3) תהנה"), "הנה השיר: ▶️ נגן שיר תהנה");
  assert.equal(await neutralizeLinks("See [file](sandbox:/mnt/x.pdf) and [f](file:///C:/a.txt)."), "See file and f.");
});

test("a bare invented address and a placeholder document route are removed", async () => {
  assert.equal(await neutralizeLinks("Saved at download://music/a.mp3 now"), "Saved at now");
  assert.equal(await neutralizeLinks("המסמך ב־#/docs/… מוכן"), "המסמך ב־ מוכן");
});

test("real links stay: web, a real document route, and an asset that exists", async () => {
  const text = `[site](https://example.com) [mail](mailto:a@b.co) [doc](#/docs/chat-${ID}) [pdf](/api/assets/${ID})`;
  assert.equal(await neutralizeLinks(text, (id) => id === ID), text);
});

test("an asset id that does not exist is taken out; without a check a well-formed id stays", async () => {
  assert.equal(await neutralizeLinks(`[pdf](/api/assets/${ID})`, () => false), "pdf");
  assert.equal(await neutralizeLinks(`[a](attachment:${ID})`, () => false), "a");
  assert.equal(await neutralizeLinks(`[pdf](/api/assets/${ID})`), `[pdf](/api/assets/${ID})`);
});

test("a picture with an invented source keeps its alt text; code is not touched", async () => {
  assert.equal(await neutralizeLinks("![cover](download://c.png)"), "cover");
  assert.equal(await neutralizeLinks("run `curl download://x` or\n```\n[a](download://b)\n```"), "run `curl download://x` or\n```\n[a](download://b)\n```");
});
