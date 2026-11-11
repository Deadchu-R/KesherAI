import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanShortcut } from "./routes/shortcuts.js";
import { createKesherServer } from "./server.js";

test("a shortcut opens a page of the app or a web address, never a script", () => {
  assert.ok(!("error" in cleanShortcut({ label: "Self-work", href: "#/self-work", icon: "🤖" })));
  assert.ok(!("error" in cleanShortcut({ label: "Docs", href: "https://example.com/a?b=1" })));
  assert.ok("error" in cleanShortcut({ label: "x", href: "javascript:alert(1)" }));
  assert.ok("error" in cleanShortcut({ label: "x", href: "file:///C:/Windows" }));
  assert.ok("error" in cleanShortcut({ label: "x", href: "#/a\"><script>" }));
  assert.ok("error" in cleanShortcut({ label: "  ", href: "#/models" }), "a name is needed");
});

test("shortcuts are kept in the config: the whole list at once, up to 25", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-sc-")), autodetect: false, pluginRoots: [] });
  try {
    const put = (shortcuts: unknown) => server.app.inject({ method: "PUT", url: "/api/shortcuts", payload: { shortcuts } });
    const ok = await put([{ label: "Self-work", href: "#/self-work", icon: "🤖" }]);
    assert.equal(ok.statusCode, 200);
    const got = (await server.app.inject({ method: "GET", url: "/api/shortcuts" })).json() as { shortcuts: Array<{ id: string; label: string }> };
    assert.equal(got.shortcuts[0]!.label, "Self-work");
    assert.ok(got.shortcuts[0]!.id);
    assert.equal((await put([{ label: "bad", href: "javascript:x" }])).statusCode, 400);
    assert.equal((await put(Array.from({ length: 26 }, (_, i) => ({ label: `s${i}`, href: "#/models" })))).statusCode, 400);
  } finally {
    await server.close();
  }
});
