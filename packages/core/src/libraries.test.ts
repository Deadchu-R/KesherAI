import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { Knowledge } from "./knowledge.js";
import { Libraries, githubZipUrl, pickFiles } from "./libraries.js";

test("pickFiles keeps documentation under the wanted folders and nothing that escapes", () => {
  const files = {
    "repo-main/docs/a.md": strToU8("# A"),
    "repo-main/docs/sub/b.rst": strToU8("B"),
    "repo-main/docs/tool.exe": strToU8("MZ"),
    "repo-main/src/c.md": strToU8("C"),
    "repo-main/docs/../../evil.md": strToU8("x"),
  };
  const out = pickFiles(files, ["docs"], true);
  assert.deepEqual([...out.keys()].map((k) => k.replace(/\\/g, "/")).sort(), ["docs/a.md", "docs/sub/b.rst"]);
});

test("githubZipUrl accepts only owner/name and refs/heads|tags", () => {
  assert.equal(githubZipUrl("godotengine/godot-docs", "refs/heads/stable"), "https://codeload.github.com/godotengine/godot-docs/zip/refs/heads/stable");
  assert.throws(() => githubZipUrl("a/b/c", "refs/heads/main"));
  assert.throws(() => githubZipUrl("a/b", "main"));
  assert.throws(() => githubZipUrl("a/b", "refs/heads/../x"));
});

test("installing a library unpacks its docs and makes a searchable knowledge base", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-lib-"));
  const knowledge = new Knowledge(join(root, "knowledge"));
  const zip = zipSync({ "react.dev-main/src/content/learn/state.md": strToU8("useState lets a component remember information between renders."), "react.dev-main/README.md": strToU8("not kept") });
  const fakeFetch = (async () => new Response(zip, { status: 200 })) as unknown as typeof fetch;
  const libs = new Libraries(join(root, "libraries"), knowledge, async () => undefined, fakeFetch);
  const lib = await libs.install("react-docs");
  assert.equal(lib.files, 1);
  assert.match(await readFile(join(lib.folders[0]!, "src", "content", "learn", "state.md"), "utf8"), /useState/);
  const list = await libs.list();
  assert.ok(list.catalog.find((c) => c.id === "react-docs")?.installed);
  // Searchable offline (the index is built in the background).
  let hits = await knowledge.search("useState remember");
  for (let i = 0; i < 20 && !hits.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    hits = await knowledge.search("useState remember");
  }
  assert.ok(hits.length > 0);
  await libs.remove("react-docs");
  assert.equal((await libs.list()).catalog.find((c) => c.id === "react-docs")?.installed, null);
  knowledge.close();
});
