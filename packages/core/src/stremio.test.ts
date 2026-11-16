import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
