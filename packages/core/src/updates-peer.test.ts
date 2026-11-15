import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, compareVersions } from "./updates.js";
import { feedName, keepForFeed, newestFeed, parseFeed, parseRange, safeFeedFile } from "./update-feed.js";

const HELLO_SHA512 = createHash("sha512").update("hello").digest("base64");
const NAMES = (v: string) => [`KesherAI-Setup-${v}.exe`, `KesherAI-${v}-arm64.dmg`, `KesherAI-${v}-x64.dmg`, `KesherAI-${v}.AppImage`, `KesherAI-${v}.deb`];
const yml = (v: string) => `version: ${v}\nfiles:\n${NAMES(v).map((n) => `  - url: ${n}\n    sha512: ${HELLO_SHA512}\n    size: 5\n`).join("")}path: ${NAMES(v)[0]}\n`;

test("feeds are read, and only plain listed names are served", async () => {
  const f = parseFeed(yml("1.2.3"));
  assert.equal(f?.version, "1.2.3");
  assert.equal(f?.files.length, 5);
  assert.equal(f?.files[0]?.sha512, HELLO_SHA512);
  assert.equal(f?.files[0]?.size, 5);
  assert.equal(parseFeed("nothing"), undefined);
  assert.equal(safeFeedFile("KesherAI-Setup-1.2.3.exe"), true);
  for (const bad of ["../x.exe", "a/b.exe", "..", ".hidden", "a\\b.exe"]) assert.equal(safeFeedFile(bad), false, bad);
  assert.deepEqual(parseRange("bytes=2-", 5), { start: 2, end: 4 });
  assert.deepEqual(parseRange("bytes=0-99", 5), { start: 0, end: 4 });
  assert.equal(parseRange("bytes=9-", 5), undefined);
  assert.equal(parseRange(undefined, 5), undefined);

  // The newest complete folder wins; one missing its installer is skipped.
  const a = await mkdtemp(join(tmpdir(), "kesher-feed-"));
  const b = await mkdtemp(join(tmpdir(), "kesher-feed-"));
  await writeFile(join(a, feedName()), yml("1.0.0"));
  for (const n of NAMES("1.0.0")) await writeFile(join(a, n), "hello");
  await writeFile(join(b, feedName()), yml("2.0.0"));
  assert.equal(newestFeed([a, b], compareVersions)?.feed.version, "1.0.0");
  for (const n of NAMES("2.0.0")) await writeFile(join(b, n), "hello");
  assert.equal(newestFeed([a, b], compareVersions)?.feed.version, "2.0.0");

  // A kept copy lists only the installer it has.
  const keep = await mkdtemp(join(tmpdir(), "kesher-feed-"));
  await keepForFeed(keep, join(b, NAMES("2.0.0")[0]!), yml("2.0.0"));
  assert.deepEqual(parseFeed(await readFile(join(keep, feedName()), "utf8"))?.files.map((x) => x.name), [NAMES("2.0.0")[0]]);
});

test("an installed copy takes a newer installer from another of my computers, with its token and sha512", async () => {
  let sawToken = true;
  const srv = createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    // GitHub has 0.4.2.
    if (req.url === "/repos/o/r/releases?per_page=10") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify([{ tag_name: "v0.4.2", body: "- Fixes", assets: [...NAMES("0.4.2"), "latest.yml", "latest-mac.yml", "latest-linux.yml"].map((name) => ({ name, size: 5, browser_download_url: `${base}/dl/${name}` })) }]));
    }
    if (req.url?.startsWith("/dl/latest")) return res.end(yml("0.4.2"));
    if (req.url?.startsWith("/dl/")) return res.end("hello");
    // The other computer built 0.4.5.
    if (req.url?.startsWith("/peer/api/updates/feed/")) {
      if (req.headers.authorization !== "Bearer t0k") {
        sawToken = false;
        return res.writeHead(401).end();
      }
      if (req.url.endsWith(".yml")) return res.end(yml("0.4.5"));
      return res.end("hello");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const feedDir = await mkdtemp(join(tmpdir(), "kesher-feed-"));
  let installed = "";
  const u = new Updater(await mkdtemp(join(tmpdir(), "kesher-upd-")), { version: "0.4.1", repo: "o/r", api, feedDir, install: async (f) => { installed = f; } });
  u.setPeers(() => [{ name: "Desk", url: `${api}/peer`, token: "t0k" }]);
  const c = await u.check();
  assert.equal(c.latestVersion, "0.4.5");
  assert.match(c.newCommits[0]!.subject, /from Desk/);
  await u.apply();
  for (let i = 0; i < 50 && u.status().running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(u.status().step, "Done", u.status().error);
  assert.match(u.status().log.join("\n"), /from Desk/);
  assert.equal(await readFile(installed, "utf8"), "hello");
  assert.ok(sawToken, "every request to the other computer carries its token");
  // It keeps a checked copy to pass on.
  assert.ok(existsSync(join(feedDir, feedName())));
  assert.equal(parseFeed(await readFile(join(feedDir, feedName()), "utf8"))?.version, "0.4.5");

  // Nothing newer on the other computer: GitHub's version stands.
  const v = new Updater(await mkdtemp(join(tmpdir(), "kesher-upd-")), { version: "0.4.1", repo: "o/r", api, install: async () => undefined });
  v.setPeers(() => [{ name: "Old", url: `${api}/nowhere`, token: "x" }]);
  assert.equal((await v.check()).latestVersion, "0.4.2");
  srv.closeAllConnections();
  srv.close();
});
