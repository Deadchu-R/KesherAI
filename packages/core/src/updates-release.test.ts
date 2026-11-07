import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, compareVersions, installerFor } from "./updates.js";

test("versions and installers", () => {
  assert.ok(compareVersions("0.10.0", "0.4.1") > 0);
  assert.equal(compareVersions("v0.4.1", "0.4.1"), 0);
  const names = ["KesherAI-Setup-0.4.2.exe", "KesherAI-Setup-0.4.2.exe.blockmap", "KesherAI-0.4.2-arm64.dmg", "KesherAI-0.4.2.AppImage"];
  assert.equal(installerFor(names, "win32", "x64"), "KesherAI-Setup-0.4.2.exe");
  assert.equal(installerFor(names, "darwin", "arm64"), "KesherAI-0.4.2-arm64.dmg");
  assert.equal(installerFor(names, "linux", "x64"), "KesherAI-0.4.2.AppImage");
});

test("an installed copy finds a newer release, downloads the installer and runs it", async () => {
  const srv = createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    if (req.url === "/repos/o/r/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ tag_name: "v0.4.2", name: "KesherAI 0.4.2", body: "### New\n- **Google:** Drive files\n- Fixes", assets: ["KesherAI-Setup-0.4.2.exe", "KesherAI-0.4.2-arm64.dmg", "KesherAI-0.4.2-x64.dmg", "KesherAI-0.4.2.AppImage"].map((name) => ({ name, size: 5, browser_download_url: `${base}/dl/${name}` })) }));
    }
    if (req.url?.startsWith("/dl/")) return res.end("hello");
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  let installed = "";
  const u = new Updater(await mkdtemp(join(tmpdir(), "kesher-upd-")), { version: "0.4.1", repo: "o/r", api, install: async (f) => { installed = f; } });
  assert.equal((await u.version()).version, "0.4.1");
  const c = await u.check();
  assert.equal(c.latestVersion, "0.4.2");
  assert.deepEqual(c.newCommits.map((x) => x.subject), ["Google: Drive files", "Fixes"]);
  await u.apply();
  for (let i = 0; i < 50 && u.status().running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(u.status().step, "Done");
  assert.equal(await readFile(installed, "utf8"), "hello");
  // Up to date: nothing to install.
  const same = new Updater(await mkdtemp(join(tmpdir(), "kesher-upd-")), { version: "0.4.2", repo: "o/r", api, install: async () => undefined });
  assert.equal((await same.check()).newCommits.length, 0);
  srv.closeAllConnections();
  srv.close();
});
