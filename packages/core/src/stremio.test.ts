import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLetterboxd, StremioTaste, tasteSummary } from "./stremio.js";

test("Letterboxd ratings.csv is read, quotes and all", () => {
  const r = parseLetterboxd('Date,Name,Year,Letterboxd URI,Rating\n2024-01-02,"Crouching Tiger, Hidden Dragon",2000,https://boxd.it/x,4.5\n2024-02-03,Cats,2019,https://boxd.it/y,1\n');
  assert.deepEqual(r.map((x) => [x.title, x.year, x.rating]), [["Crouching Tiger, Hidden Dragon", 2000, 4.5], ["Cats", 2019, 1]]);
  assert.match(tasteSummary(r), /Loved:\nCrouching Tiger, Hidden Dragon \(2000\) 4\.5★[\s\S]*Disliked:\nCats \(2019\) 1★/);
  assert.deepEqual(parseLetterboxd("nothing,here\n1,2"), []);
});

test("recommendations: the model's titles are matched on Cinemeta (seen ones left out) and kept for the addon", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stremio-"));
  const fake = (async (url: string) => {
    const t = decodeURIComponent(String(url).split("search=")[1]!.replace(".json", ""));
    const metas = t === "Hero" ? [{ id: "tt0299977", name: "Hero", releaseInfo: "2002", poster: "https://images.metahub.space/x.jpg" }, { id: "tt9999999", name: "Hero", releaseInfo: "2019" }] : [];
    return new Response(JSON.stringify({ metas }));
  }) as typeof fetch;
  const st = new StremioTaste(dir, fake);
  await assert.rejects(st.refresh(async () => "{}"), /Letterboxd/);
  await st.importLetterboxd("Date,Name,Year,Letterboxd URI,Rating\n2024-01-02,Crouching Tiger Hidden Dragon,2000,u,5\n");
  assert.equal((await st.importLetterboxd("Date,Name,Year,Letterboxd URI,Rating\n2024-01-02,Crouching Tiger Hidden Dragon,2000,u,4\n")).added, 0);
  const picks = await st.refresh(async () => '{"movies":[{"title":"Hero","year":2002,"why":"wuxia"},{"title":"Crouching Tiger Hidden Dragon"},{"title":"Nowhere"}],"series":[]}');
  assert.deepEqual(picks.movie, [{ id: "tt0299977", type: "movie", name: "Hero", poster: "https://images.metahub.space/x.jpg", year: "2002", why: "wuxia" }]);
  assert.equal((await st.load()).rated[0]?.rating, 4);
});

test("MyAnimeList: the export (seen ones, score out of 10 as stars) and the API by user name", async () => {
  const { parseMalXml, malApiItems, StremioTaste } = await import("./stremio.js");
  const xml = `<myanimelist><anime><series_animedb_id>1</series_animedb_id><series_title><![CDATA[Fullmetal Alchemist: Brotherhood]]></series_title><series_type>TV</series_type><my_score>10</my_score><my_status>Completed</my_status></anime><anime><series_title><![CDATA[Your Name.]]></series_title><series_type>Movie</series_type><my_score>0</my_score><my_status>Completed</my_status></anime><anime><series_title>Later &amp; Later</series_title><series_type>TV</series_type><my_score>0</my_score><my_status>Plan to Watch</my_status></anime></myanimelist>`;
  assert.deepEqual(parseMalXml(xml), [
    { title: "Fullmetal Alchemist: Brotherhood", rating: 5, kind: "series", from: "mal", anime: true },
    { title: "Your Name.", kind: "movie", from: "mal", anime: true },
  ]);
  assert.deepEqual(malApiItems({ data: [{ node: { title: "Shingeki no Kyojin", alternative_titles: { en: "Attack on Titan" }, media_type: "tv", start_season: { year: 2013 } }, list_status: { status: "completed", score: 8 } }, { node: { title: "X" }, list_status: { status: "plan_to_watch" } }] }), [{ title: "Attack on Titan", year: 2013, rating: 4, kind: "series", from: "mal", anime: true }]);
  const dir = await mkdtemp(join(tmpdir(), "kesher-mal-"));
  try {
    const urls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      urls.push(`${url} ${(init?.headers as Record<string, string>)["X-MAL-CLIENT-ID"]}`);
      const page2 = url.includes("offset=1000");
      return new Response(JSON.stringify({ data: [{ node: { title: page2 ? "Mushishi" : "Monster", media_type: "tv" }, list_status: { status: "completed", score: 9 } }], paging: page2 ? {} : { next: "https://api.myanimelist.net/v2/users/roee/animelist?offset=1000" } }));
    }) as typeof fetch;
    const t = new StremioTaste(dir, fetcher);
    await assert.rejects(() => t.importMalUser("roee"), /client id/);
    assert.deepEqual(await t.importMalUser("roee", "0123456789abcdef0123456789abcdef"), { added: 2, total: 2 });
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /users\/roee\/animelist.* 0123456789abcdef0123456789abcdef$/);
    // The client id is kept: next time the name is enough.
    assert.deepEqual(await t.importMalUser("roee"), { added: 0, total: 2 });
    await assert.rejects(() => t.importMalUser("../x", "0123456789abcdef0123456789abcdef"), /user name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
