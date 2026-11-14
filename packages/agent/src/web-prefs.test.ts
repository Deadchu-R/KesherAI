import { test } from "node:test";
import assert from "node:assert/strict";
import { onSite, searchWeb, siteName, webFetchTool, webSearchTool } from "./system-tools.js";

const page = (n: number, host: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => `<a class="result__a" href="https://${host(i)}/p${i}">T${i}</a><a class="result__snippet">S${i}</a>`).join("\n");

test("site names and 'on a site'", () => {
  assert.equal(siteName("https://www.Docs.Unity3d.com/Manual/x"), "docs.unity3d.com");
  assert.ok(onSite("https://docs.unity3d.com/a", "unity3d.com"));
  assert.ok(!onSite("https://notunity3d.com/a", "unity3d.com"));
});

test("a chat's web settings: only / never these sites, and how many results by depth", async () => {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response(page(10, (i) => (i % 2 ? "pinterest.com" : `site${i}.dev`)), { status: 200 });
  }) as typeof fetch;
  try {
    const s = new AbortController().signal;
    assert.equal((await searchWeb("q", { depth: "quick" }, s)).length, 5);
    const never = await searchWeb("q", { never: ["pinterest.com"] }, s);
    assert.ok(never.every((r) => !r.url.includes("pinterest")));
    const only = await searchWeb("q", { only: ["site2.dev"] }, s);
    assert.deepEqual(only.map((r) => r.url), ["https://site2.dev/p2"]);
    assert.match(decodeURIComponent(asked.at(-1)!), /q site:site2\.dev/);
    await searchWeb("q", { depth: "deep" }, s);
    assert.ok(asked.some((u) => u.includes("&s=30")), "deep reads the next page of results too");
    const out = (await webSearchTool.run({ query: "q" }, { signal: s, recordChange: () => undefined, web: { depth: "deep" } } as never)).output;
    assert.match(out, /open at least 5 different pages/);
    await assert.rejects(webFetchTool.run({ url: "https://other.com/x" }, { signal: s, recordChange: () => undefined, web: { only: ["site2.dev"] } } as never), /only from: site2\.dev/);
    await assert.rejects(webFetchTool.run({ url: "https://www.pinterest.com/x" }, { signal: s, recordChange: () => undefined, web: { never: ["pinterest.com"] } } as never), /never reads from that site/);
  } finally {
    globalThis.fetch = real;
  }
});
