import test from "node:test";
import assert from "node:assert/strict";
import { searchQueryOf, searchQueryFor } from "./search-query.js";

test("English questions become key words", () => {
  assert.equal(searchQueryOf("What is the weather forecast for Haifa tomorrow?"), "weather forecast Haifa tomorrow");
  assert.equal(searchQueryOf("Can you tell me who won the Champions League final 2026?"), "won Champions League final 2026");
  assert.equal(searchQueryOf("how much is 3.5 BTC in USD at 18:30"), "much 3.5 BTC USD 18:30");
});

test("Hebrew questions become key words", () => {
  assert.equal(searchQueryOf("מה מזג האוויר בחיפה מחר"), "מזג אוויר חיפה מחר");
  assert.equal(searchQueryOf("תגיד לי מה השעה בלונדון עכשיו?"), "השעה לונדון עכשיו");
  assert.equal(searchQueryOf("מתי יש מטוס מתל אביב לאילת"), "מטוס תל אביב אילת");
});

test("never empty, urls dropped, at most 12 words", () => {
  assert.equal(searchQueryOf("what is?"), "what is");
  assert.equal(searchQueryOf("read https://example.com/a please news"), "read news");
  assert.equal(searchQueryOf(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")).split(" ").length, 12);
});

test("a small model's query is used inside its budget, else the rules'", async () => {
  const typed = "I would really like to know what the weather forecast for Haifa tomorrow will be like";
  assert.deepEqual(await searchQueryFor(typed, async () => '"Haifa weather tomorrow"'), { query: "Haifa weather tomorrow", by: "model" });
  assert.equal((await searchQueryFor(typed, async () => { throw new Error("slow"); })).by, "rules");
  assert.equal((await searchQueryFor(typed, async () => "a b c d e f g h i j k l")).by, "rules");
  assert.equal((await searchQueryFor(typed, undefined)).by, "rules");
  assert.equal((await searchQueryFor("weather Haifa", async () => "x")).by, "rules");
});

test("a model that never answers is cut off at the budget", async () => {
  const t = Date.now();
  const r = await searchQueryFor("I would really like to know what the weather forecast for Haifa tomorrow will be like", () => new Promise<string>(() => undefined), 100);
  assert.equal(r.by, "rules");
  assert.ok(Date.now() - t < 1000);
});
