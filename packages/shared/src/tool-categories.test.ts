import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "./roles.js";
import { ROLE_CATEGORIES, TOOL_CATEGORIES, categoriesForRoles, categorizeTools, pinsForRoles } from "./tool-categories.js";

test("every role of the welcome brings real categories (or everything)", () => {
  const ids = new Set(TOOL_CATEGORIES.map((c) => c.id));
  for (const [role, cats] of Object.entries(ROLE_CATEGORIES)) for (const c of cats) assert.ok(ids.has(c), `${role}: ${c}`);
  for (const id of ["gamedev", "artist", "developer", "student", "writer", "researcher", "everyday"]) {
    assert.ok(ROLES.some((r) => r.id === id), `role ${id} is offered`);
    assert.ok(ROLE_CATEGORIES[id], `role ${id} has categories`);
  }
  const pages = TOOL_CATEGORIES.flatMap((c) => c.pages);
  assert.equal(new Set(pages).size, pages.length, "a page is in one category only");
});

test("roles map to tool categories in pick order, system last", () => {
  assert.deepEqual(categoriesForRoles("gamedev"), ["games", "art", "code", "system"]);
  assert.deepEqual(categoriesForRoles(["student", "writer"]), ["study", "research", "writing", "system"]);
  assert.deepEqual(categoriesForRoles("artist,gamedev"), ["art", "writing", "games", "code", "system"]);
  // No role, "other" or an unknown one: everything.
  for (const r of [undefined, "", "other", "gamedev,other", "nope"]) assert.equal(categoriesForRoles(r).length, TOOL_CATEGORIES.length);
});

test("the All tools page keeps every page: the roles' categories first, the rest after, unknown pages in More", () => {
  const hrefs = ["#/images", "#/unreal", "#/study", "#/settings", "#/p/plugin/x", "#/docs", "#/images"];
  const cats = categorizeTools(hrefs, "gamedev");
  assert.deepEqual(cats.map((c) => c.id), ["games", "art", "study", "writing", "more", "system"]);
  assert.deepEqual(cats.filter((c) => c.first).map((c) => c.id), ["games", "art", "system"]);
  const shown = cats.flatMap((c) => c.pages);
  assert.deepEqual([...shown].sort(), [...new Set(hrefs)].sort(), "each page exactly once");
  assert.ok(categorizeTools(hrefs, undefined).every((c) => c.first || c.id === "more"));
});

test("pins put the roles' pages first and keep the user's own", () => {
  const pins = pinsForRoles("gamedev", ["#/images", "#/models"]);
  assert.deepEqual(pins.slice(0, 2), ["#/unreal", "#/unity"]);
  assert.ok(pins.includes("#/models"));
  assert.equal(new Set(pins).size, pins.length);
  assert.ok(pinsForRoles("gamedev,artist,student,writer", []).length <= 8);
  assert.deepEqual(pinsForRoles("other", ["#/a"]), ["#/a"]);
  assert.deepEqual(pinsForRoles(undefined, ["#/a"]), ["#/a"]);
});
