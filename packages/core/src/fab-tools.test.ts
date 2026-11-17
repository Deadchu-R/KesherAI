import { test } from "node:test";
import assert from "node:assert/strict";
import { fabListings, fabSearchPath } from "./fab-tools.js";

test("Fab's search path: only its keys, slugs checked", () => {
  assert.equal(fabSearchPath({ query: "rock cliff", free: true, engine: "unreal-engine", type: "3d-model", sort: "rating", count: 50 }), "/i/listings/search?q=rock+cliff&is_free=1&channels=unreal-engine&listing_types=3d-model&sort_by=-ratings.averageRating&count=24");
  assert.equal(fabSearchPath({ query: "x", engine: "bad&evil=1", type: "../a" }), "/i/listings/search?q=x&sort_by=-relevance&count=12");
});

test("Fab's answer read defensively", () => {
  const list = fabListings({ results: [
    { uid: "a1b2c3d4-0000", title: "Cliffs", user: { sellerName: "Quixel" }, startingPrice: { price: 0, currencyCode: "USD" }, ratings: { averageRating: 4.81, total: 120 }, listingType: "3d-model" },
    { uid: "b2", title: "too short uid" },
    { uid: "c3c3c3c3", title: "Sword pack", startingPrice: { price: 19.99, currencyCode: "USD" } },
    "junk",
  ] });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { uid: "a1b2c3d4-0000", title: "Cliffs", seller: "Quixel", free: true, rating: "4.8★ (120)", type: "3d-model", url: "https://www.fab.com/listings/a1b2c3d4-0000" });
  assert.equal(list[1]?.price, "19.99 USD");
  assert.deepEqual(fabListings({ nothing: 1 }), []);
});
