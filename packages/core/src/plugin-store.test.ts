import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { InstallRequests, acceptedAll, parseStoreIndex, permissionsOfManifest, releaseUrl, safeEntryName, unpackVerified, type StoreEntry } from "./plugin-store.js";
import { createKesherServer } from "./server.js";

const manifest = (over: Record<string, unknown> = {}) => JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0", kesher: { apiVersion: 1 }, permissions: [], ...over });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const entryFor = (zip: Uint8Array, over: Partial<StoreEntry> = {}): StoreEntry => ({
  id: "demo", name: { he: "דמו", en: "Demo" }, description: { he: "תיאור", en: "Description" }, version: "1.0.0", author: "someone",
  repo: "someone/kesherai-demo", permissions: [], size: zip.length, sha256: sha(zip), ...over,
});

test("the index is validated: fields, repo format, hash format and duplicate ids", () => {
  const e = entryFor(zipSync({ "kesher-plugin.json": strToU8(manifest()) }));
  assert.equal(parseStoreIndex({ schema: 1, plugins: [e] }).plugins.length, 1);
  assert.throws(() => parseStoreIndex({ schema: 1, plugins: [e, e] }), /twice/);
  assert.throws(() => parseStoreIndex({ schema: 1, plugins: [{ ...e, sha256: "ABC" }] }));
  assert.throws(() => parseStoreIndex({ schema: 1, plugins: [{ ...e, repo: "https://evil.example/x" }] }));
  assert.throws(() => parseStoreIndex({ schema: 1, plugins: [{ ...e, permissions: ["root"] }] }));
  assert.throws(() => parseStoreIndex({ schema: 1, plugins: [{ ...e, name: { en: "only English" } }] }));
  assert.equal(releaseUrl(e), "https://github.com/someone/kesherai-demo/releases/download/v1.0.0/demo.zip");
});

test("the shipped plugins/index.json is valid", async () => {
  parseStoreIndex(JSON.parse(await readFile(join(import.meta.dirname, "../../../plugins/index.json"), "utf8")));
});

test("a checksum that does not match refuses the install and unpacks nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-store-"));
  const zip = zipSync({ "kesher-plugin.json": strToU8(manifest()) });
  await assert.rejects(unpackVerified(entryFor(zip, { sha256: "0".repeat(64) }), zip, dir), /checksum/);
  assert.deepEqual(await readdir(dir), []);
});

test("a good zip unpacks (also inside one wrapping folder)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-store-"));
  const zip = zipSync({ "demo/kesher-plugin.json": strToU8(manifest()), "demo/ui/page.html": strToU8("<p>hi</p>") });
  const { dir: out, manifest: m } = await unpackVerified(entryFor(zip), zip, dir);
  assert.equal(m.id, "demo");
  assert.equal(await readFile(join(out, "ui", "page.html"), "utf8"), "<p>hi</p>");
});

test("paths that leave the plugin folder are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-store-"));
  for (const evil of ["../evil.txt", "a/../../evil.txt", "/etc/evil", "C:/evil.txt", "a\\..\\evil.txt"]) {
    const zip = zipSync({ "kesher-plugin.json": strToU8(manifest()), [evil]: strToU8("x") });
    await assert.rejects(unpackVerified(entryFor(zip), zip, dir), /unsafe path/, evil);
  }
  assert.equal(existsSync(join(dir, "..", "evil.txt")), false);
  assert.equal(safeEntryName("ui/page.html"), "ui/page.html");
  assert.equal(safeEntryName("../x"), undefined);
});

test("the manifest must agree with the index, and may not ask for more than the index shows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-store-"));
  const wrongVersion = zipSync({ "kesher-plugin.json": strToU8(manifest({ version: "2.0.0" })) });
  await assert.rejects(unpackVerified(entryFor(wrongVersion), wrongVersion, dir), /does not match/);
  const sneaky = zipSync({ "kesher-plugin.json": strToU8(manifest({ permissions: ["network"] })) });
  await assert.rejects(unpackVerified(entryFor(sneaky), sneaky, dir), /more than the store lists \(network\)/);
  const honest = zipSync({ "kesher-plugin.json": strToU8(manifest({ permissions: ["network"] })) });
  await unpackVerified(entryFor(honest, { permissions: ["network"] }), honest, dir);
  assert.deepEqual(permissionsOfManifest({ permissions: ["filesystem", "shell"], uses: ["chat", "image"], programs: [] }), ["engines", "files", "models"]);
});

test("the user must accept exactly the permissions listed", () => {
  const e = { permissions: ["network", "files"] as StoreEntry["permissions"] };
  assert.equal(acceptedAll(e, undefined), false);
  assert.equal(acceptedAll(e, ["network"]), false);
  assert.equal(acceptedAll(e, ["network", "files", "engines"]), false);
  assert.equal(acceptedAll(e, ["files", "network"]), true);
  assert.equal(acceptedAll({ permissions: [] }, []), true);
});

test("install requests: one per plugin, expire after an hour", () => {
  let now = 1000;
  const r = new InstallRequests(() => now);
  const a = r.create("demo");
  assert.equal(r.create("demo").id, a.id);
  assert.equal(r.list().length, 1);
  now += 3_600_001;
  assert.equal(r.list().length, 0);
});

test("a phone cannot install: it can only request, and only the computer approves", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-store-srv-"));
  const root = join(dataDir, "roots");
  await mkdir(root, { recursive: true });
  const zip = zipSync({ "kesher-plugin.json": strToU8(manifest({ permissions: ["network"] })) });
  await writeFile(join(root, "index.json"), JSON.stringify({ schema: 1, plugins: [entryFor(zip, { permissions: ["network"] })] }));
  process.env.KESHER_STORE_INDEX_URL = "off";
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [root] });
  try {
    // A paired phone: another address and the remote token (see server.test.ts).
    const phone = { authorization: `Bearer ${server.services.config.remote.token!}` };
    const away = { remoteAddress: "192.168.1.20" };
    const direct = await server.app.inject({ method: "POST", url: "/api/plugins/store/install", payload: { id: "demo", accept: ["network"] }, headers: phone, ...away });
    assert.equal(direct.statusCode, 403);
    const asked = await server.app.inject({ method: "POST", url: "/api/plugins/store/requests", payload: { id: "demo" }, headers: phone, ...away });
    assert.equal(asked.statusCode, 200);
    const rid = (asked.json() as { request: { id: string } }).request.id;
    const fromPhone = await server.app.inject({ method: "POST", url: `/api/plugins/store/requests/${rid}/approve`, payload: { accept: ["network"] }, headers: phone, ...away });
    assert.equal(fromPhone.statusCode, 403);
    const store = (await server.app.inject({ method: "GET", url: "/api/plugins/store" })).json() as { plugins: Array<{ id: string }>; requests: unknown[] };
    assert.equal(store.plugins[0]?.id, "demo");
    assert.equal(store.requests.length, 1, "the request waits for the computer");
    // At the computer, without accepting the permissions: refused too.
    const noAccept = await server.app.inject({ method: "POST", url: `/api/plugins/store/requests/${rid}/approve`, payload: {} });
    assert.equal(noAccept.statusCode, 400);
    const unknown = await server.app.inject({ method: "POST", url: "/api/plugins/store/requests", payload: { id: "not-listed" }, headers: phone, ...away });
    assert.equal(unknown.statusCode, 404, "only listed plugins");
  } finally {
    await server.close();
  }
});
