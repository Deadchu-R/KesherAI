import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, linkedSource, logQuery, sizeText, trendPath } from "./logs-view";

test("logQuery: only what is set; all four levels is no filter; the range becomes since", () => {
  assert.equal(logQuery("kesher-main", {}), "source=kesher-main");
  assert.equal(logQuery("s", { q: " a b ", regex: true, levels: ["error"], cat: "LogTemp", range: "1h" }, 10_000_000, { context: 2 }), "source=s&q=a+b&regex=1&levels=error&cats=LogTemp&since=6400000&context=2");
  assert.equal(logQuery("s", { levels: ["error", "warning", "info", "debug"], regex: true }), "source=s");
});

test("trendPath draws one bar per non-empty bucket, scaled to the largest", () => {
  assert.equal(trendPath([]), "");
  assert.equal(trendPath([0, 0]), "");
  const d = trendPath([1, 0, 2], 30, 10);
  assert.equal(d.match(/M/g)!.length, 2);
  assert.match(d, /^M0\.5 10v-5h9v5zM20\.5 10v-10h9v10z$/);
});

test("ago, sizeText and links to a source", () => {
  assert.equal(ago(undefined, false), "—");
  assert.equal(ago(0, false, 30_000), "just now");
  assert.equal(ago(0, true, 5 * 60_000), "לפני 5 דק'");
  assert.equal(ago(0, false, 3 * 3_600_000), "3 h ago");
  assert.equal(sizeText(2048), "2 KB");
  assert.equal(sizeText(5.5 * 1024 ** 2), "5.5 MB");
  const list = [{ id: "kesher-main", name: "KesherAI log", group: "kesher" }, { id: "unreal-ab", name: "Unreal · Shooter", group: "unreal" }];
  assert.equal(linkedSource("#/logs?source=kesher-main", list), "kesher-main");
  assert.equal(linkedSource("#/logs?unreal=Shooter", list), "unreal-ab");
  assert.equal(linkedSource("#/logs?source=gone", list), undefined);
  assert.equal(linkedSource("#/logs", list), undefined);
});
