import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stremioWatched, traktEntries, traktApp } from "./stremio-history.js";
import { StremioTaste } from "./stremio.js";

test("Stremio library: watched films and series only", () => {
  assert.deepEqual(
    stremioWatched([
      { name: "Arrival", type: "movie", state: { flaggedWatched: 1 } },
      { name: "Heat", type: "movie", state: { overallTimeWatched: 8_000_000, duration: 10_000_000 } },
      { name: "Half seen", type: "movie", state: { overallTimeWatched: 1_000_000, duration: 10_000_000 } },
      { name: "Dark", type: "series", state: { overallTimeWatched: 3_600_000 } },
      { name: "Gone", type: "movie", removed: true, state: { flaggedWatched: 1 } },
      { name: "A channel", type: "tv", state: { timesWatched: 3 } },
      "junk",
    ]),
    [
      { title: "Arrival", kind: "movie", from: "stremio" },
      { title: "Heat", kind: "movie", from: "stremio" },
      { title: "Dark", kind: "series", from: "stremio" },
    ],
  );
});

test("Trakt: watched and rated, ratings out of 10 become stars", () => {
  assert.deepEqual(
    traktEntries([{ movie: { title: "Arrival", year: 2016 } }, { show: { title: "Dark", year: 2017 } }], [{ type: "movie", rating: 9, movie: { title: "Arrival", year: 2016 } }, { type: "episode", rating: 3 }]),
    [
      { title: "Arrival", kind: "movie", from: "trakt", year: 2016, rating: 4.5 },
      { title: "Dark", kind: "series", from: "trakt", year: 2017 },
    ],
  );
  assert.throws(() => traktApp({ clientId: "x", clientSecret: "y" }), /Client ID/);
});

test("Stremio sign-in keeps the session key, never the password; sign-out ends it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-stremio-"));
  try {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/login")) return new Response(JSON.stringify(body.password === "right" ? { result: { authKey: "sessionkey123" } } : { error: { message: "Wrong password" } }));
      if (url.endsWith("/datastoreGet")) return new Response(JSON.stringify({ result: [{ name: "Arrival", type: "movie", state: { flaggedWatched: 1 } }] }));
      return new Response(JSON.stringify({ result: { success: true } }));
    }) as typeof fetch;
    const t = new StremioTaste(dir, fetcher);
    await t.rate("Arrival", 5, "movie", 2016);
    await assert.rejects(() => t.stremioConnect("me@example.com", "wrong"), /Wrong password/);
    // Arrival from Stremio (no year) is the film already rated: not added twice.
    assert.deepEqual(await t.stremioConnect("me@example.com", "right"), { added: 0, total: 1 });
    assert.ok(calls.every((c) => c.url.startsWith("https://api.strem.io/api/")));
    assert.deepEqual(calls.find((c) => c.url.endsWith("/datastoreGet"))?.body, { type: "DatastoreGet", authKey: "sessionkey123", collection: "libraryItem", ids: [], all: true });
    const saved = await readFile(join(dir, "stremio.json"), "utf8");
    assert.ok(!saved.includes("right"));
    assert.ok(saved.includes("sessionkey123"));
    await t.stremioDisconnect();
    assert.equal(calls.at(-1)?.body.type, "Logout");
    assert.ok(!(await readFile(join(dir, "stremio.json"), "utf8")).includes("sessionkey123"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Trakt sign-in: the device code, waiting, then her history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-trakt-"));
  const id = "a".repeat(64);
  const secret = "b".repeat(64);
  try {
    let approved = false;
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/device/code")) return new Response(JSON.stringify({ device_code: "dev", user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", interval: 5, expires_in: 600 }));
      if (url.endsWith("/oauth/device/token")) return approved ? new Response(JSON.stringify({ access_token: "tokentoken1" })) : new Response("", { status: 400 });
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer tokentoken1");
      if (url.includes("/sync/watched/movies")) return new Response(JSON.stringify([{ movie: { title: "Heat", year: 1995 } }]));
      if (url.includes("/sync/watched/shows")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([{ type: "movie", rating: 10, movie: { title: "Heat", year: 1995 } }]));
    }) as typeof fetch;
    const t = new StremioTaste(dir, fetcher);
    assert.deepEqual(await t.traktBegin({ clientId: id, clientSecret: secret }), { userCode: "ABCD1234", url: "https://trakt.tv/activate", expiresIn: 600 });
    assert.deepEqual(await t.traktCheck(), { state: "wait" });
    approved = true;
    assert.deepEqual(await t.traktCheck(), { state: "connected", added: 1, total: 1 });
    assert.equal((await t.load()).rated[0]?.rating, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session key from Stremio's own page: its email is shown and the library is read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-stremio-page-"));
  try {
    const fetcher = (async (url: string) => {
      if (url.endsWith("/getUser")) return new Response(JSON.stringify({ result: { email: "me@example.com" } }));
      return new Response(JSON.stringify({ result: [{ name: "Heat", type: "movie", state: { timesWatched: 1 } }] }));
    }) as typeof fetch;
    const t = new StremioTaste(dir, fetcher);
    await assert.rejects(() => t.stremioConnectKey("bad key!"), /no session/);
    assert.deepEqual(await t.stremioConnectKey("pagesessionkey1"), { added: 1, total: 1 });
    const s = await t.load();
    assert.equal(s.stremio?.email, "me@example.com");
    assert.equal(s.stremio?.authKey, "pagesessionkey1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stremio's link sign-in: a code and Stremio's own address, waiting, then connected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-stremio-link-"));
  try {
    let confirmed = false;
    const fetcher = (async (url: string) => {
      if (url.includes("/create?type=Create")) return new Response(JSON.stringify({ result: { success: true, code: "5OQJ", link: "https://link.stremio.com/5OQJ", qrcode: "x" } }));
      if (url.includes("/read?type=Read&code=5OQJ")) return new Response(JSON.stringify(confirmed ? { result: { authKey: "linksessionkey1" } } : { error: { message: "not yet" } }));
      if (url.endsWith("/getUser")) return new Response(JSON.stringify({ result: { email: "me@example.com" } }));
      return new Response(JSON.stringify({ result: [{ name: "Dark", type: "series", state: { timesWatched: 1 } }] }));
    }) as typeof fetch;
    const t = new StremioTaste(dir, fetcher);
    assert.deepEqual(await t.stremioLinkBegin(), { code: "5OQJ", link: "https://link.stremio.com/5OQJ" });
    assert.deepEqual(await t.stremioLinkCheck("5OQJ"), { waiting: true });
    confirmed = true;
    assert.deepEqual(await t.stremioLinkCheck("5OQJ"), { waiting: false, added: 1, total: 1 });
    assert.equal((await t.load()).stremio?.authKey, "linksessionkey1");
    await assert.rejects(() => t.stremioLinkCheck("../x"), /No sign-in code/);
    // An address that is not Stremio's own is never shown.
    const evil = new StremioTaste(dir, (async () => new Response(JSON.stringify({ result: { code: "AB12", link: "https://evil.example/AB12" } }))) as typeof fetch);
    await assert.rejects(() => evil.stremioLinkBegin(), /no sign-in code/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
