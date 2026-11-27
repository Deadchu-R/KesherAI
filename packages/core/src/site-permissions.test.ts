import { test } from "node:test";
import assert from "node:assert/strict";
import { addSite, listSites, removeSite, siteAllows, validateSiteHost, type SiteConfig } from "./site-permissions.js";

const cfg = (): SiteConfig => ({ browserSites: [], browserSiteInfo: {}, permissions: [] });

test("site host check: plain hosts and a leading star only", () => {
  assert.deepEqual(validateSiteHost(" WWW.Example.com "), { host: "example.com" });
  assert.deepEqual(validateSiteHost("*.example.com"), { host: "*.example.com" });
  for (const bad of ["https://example.com", "example.com/path", "example.com:8080", "ex*mple.com", "*example.com", "a.*.com", "a b.com", "localhost", "", "user@example.com", 5]) {
    assert.ok("error" in validateSiteHost(bad), `refused: ${String(bad)}`);
  }
});

test("site host check: sites that always ask or are blocked are refused", () => {
  assert.match((validateSiteHost("paypal.com") as { error: string }).error, /always asks/);
  assert.match((validateSiteHost("my.corp.example", [], ["corp.example"]) as { error: string }).error, /always asks/);
  assert.match((validateSiteHost("ads.example.com", ["example.com"]) as { error: string }).error, /blocked/);
});

test("sites: add keeps the date and level, list shows them newest first, remove takes it back", () => {
  const c = cfg();
  assert.equal(addSite(c, "a.example.com", Date.parse("2026-11-01T00:00:00Z")), true);
  assert.equal(addSite(c, "a.example.com", Date.now()), false, "no duplicate");
  addSite(c, "b.example.com", Date.parse("2026-11-02T00:00:00Z"), "open");
  const l = listSites(c);
  assert.deepEqual(l.map((x) => [x.site, x.level]), [["b.example.com", "open"], ["a.example.com", "act"]]);
  assert.equal(l[1]!.at, "2026-11-01T00:00:00.000Z");
  assert.equal(removeSite(c, "a.example.com"), true);
  assert.equal(removeSite(c, "a.example.com"), false);
  assert.deepEqual(listSites(c).map((x) => x.site), ["b.example.com"]);
  assert.equal(c.browserSiteInfo!["a.example.com"], undefined);
});

test("sites: an old list without dates still shows, and 'until I revoke' site rules are listed and removed too", () => {
  const c: SiteConfig = { browserSites: ["old.example.com"], permissions: [{ tool: "browser_*", scope: "everywhere", target: "site:g.example.com", createdAt: "2026-11-10T00:00:00Z" }, { tool: "browser_*", scope: "conversation", conversationId: "c1", target: "site:chat.example.com" }] };
  assert.deepEqual(listSites(c).map((x) => [x.site, x.source]), [["g.example.com", "grant"], ["old.example.com", "always"]]);
  assert.equal(removeSite(c, "g.example.com"), true);
  assert.equal(c.permissions.length, 1, "the chat's own rule stays");
});

test("sites: removing a site makes the next call there ask again", () => {
  const c = cfg();
  addSite(c, "shop.example.com", 1);
  assert.equal(siteAllows(c, "shop.example.com", "browser_click"), true);
  removeSite(c, "shop.example.com");
  assert.equal(siteAllows(c, "shop.example.com", "browser_click"), false);
});

test("sites: exact host unless starred, and 'open' does not cover clicking or typing", () => {
  const c = cfg();
  addSite(c, "example.com", 1);
  addSite(c, "*.docs.test", 1, "open");
  assert.equal(siteAllows(c, "example.com", "browser_type"), true);
  assert.equal(siteAllows(c, "www.example.com", "browser_click"), true);
  assert.equal(siteAllows(c, "sub.example.com", "browser_click"), false, "a plain entry is that host only");
  assert.equal(siteAllows(c, "a.docs.test", "browser_open", { url: "https://a.docs.test/" }), true);
  assert.equal(siteAllows(c, "a.docs.test", "browser_snapshot"), true);
  assert.equal(siteAllows(c, "a.docs.test", "browser_click"), false);
  assert.equal(siteAllows(c, "a.docs.test", "browser_type"), false);
});
