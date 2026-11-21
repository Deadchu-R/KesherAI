import { test } from "node:test";
import assert from "node:assert/strict";
import { backendOrder, checkBackends, looksBlocked, parseBing, parseDuckLite, parseMojeek, resetSearchMemory } from "./web-search.js";
import { searchWeb } from "./system-tools.js";

const LITE = `<table><tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&amp;rut=x" class='result-link'>Python <b>docs</b></a></td></tr>
<tr><td class='result-snippet'>The official <b>Python</b> documentation.</td></tr>
<tr><td><a rel="nofollow" href="https://example.org/a" class='result-link'>Example</a></td></tr><tr><td class='result-snippet'>Second.</td></tr></table>`;
const MOJEEK = `<ul class="results-standard"><li><a class="ob" href="https://example.com/x">example.com</a><h2><a class="title" href="https://example.com/x">Example &amp; Co</a></h2><p class="s">A <b>small</b> snippet.</p></li>
<li><h2><a class="title" href="/relative">Skipped</a></h2></li></ul>`;
const b64 = Buffer.from("https://example.net/page", "utf8").toString("base64url");
const BING = `<ol id="b_results"><li class="b_algo" data-id><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1${b64}&amp;ntb=1">Net <strong>page</strong></a></h2><div class="b_caption"><p>Bing snippet.</p></div></li>
<li class="b_algo"><h2><a href="https://direct.example/y">Direct</a></h2><div class="b_caption"><p>Second.</p></div></li></ol>`;
const DDG = '<a class="result__a" href="https://ddg.example/a">DDG A</a><a class="result__snippet">snip</a>';

test("each backend's parser reads its page", () => {
  assert.deepEqual(parseDuckLite(LITE), [
    { title: "Python docs", url: "https://docs.python.org/3/", snippet: "The official Python documentation." },
    { title: "Example", url: "https://example.org/a", snippet: "Second." },
  ]);
  assert.deepEqual(parseMojeek(MOJEEK), [{ title: "Example & Co", url: "https://example.com/x", snippet: "A small snippet." }]);
  assert.deepEqual(parseBing(BING), [
    { title: "Net page", url: "https://example.net/page", snippet: "Bing snippet." },
    { title: "Direct", url: "https://direct.example/y", snippet: "Second." },
  ]);
  assert.deepEqual([parseDuckLite("x"), parseMojeek("x"), parseBing("x")], [[], [], []]);
  assert.ok(looksBlocked("<div class='anomaly-modal'>") && !looksBlocked(DDG));
});

/** Answers each backend's address with its own page (or a status), and records what was asked. */
function fake(pages: Record<string, string | number>) {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = Object.keys(pages).find((k) => String(url).includes(k))!;
    asked.push(`${init?.method ?? "GET"} ${String(url)}`);
    const v = pages[key]!;
    return typeof v === "number" ? new Response("", { status: v }) : new Response(v, { status: 200 });
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = real) };
}

test("searchWeb moves on from a bot check, an error and an empty page, remembers the backend, and keeps the filters", async () => {
  resetSearchMemory();
  const s = new AbortController().signal;
  const f = fake({ "html.duckduckgo.com": "<div class='anomaly-modal'></div>", "lite.duckduckgo.com": 429, "mojeek.com": "<ul></ul>", "bing.com": BING });
  try {
    const r = await searchWeb("q", { never: ["direct.example"], safeSearch: "strict" }, s);
    assert.deepEqual(r.map((x) => x.url), ["https://example.net/page"]);
    assert.equal(f.asked.length, 4);
    assert.match(f.asked[1]!, /^POST https:\/\/lite\.duckduckgo\.com/);
    assert.match(f.asked[3]!, /bing\.com\/search\?q=q&setlang=en&adlt=strict/);
    assert.equal(backendOrder()[0]!.name, "bing", "the one that worked is tried first");
    f.asked.length = 0;
    await searchWeb("q", undefined, s);
    assert.match(f.asked[0]!, /bing\.com/);
    assert.equal(backendOrder(Date.now() + 31 * 60_000)[0]!.name, "duckduckgo", "forgotten after 30 minutes");
  } finally {
    f.restore();
  }
});

test("searchWeb: empty everywhere is an empty list; errors everywhere throw with the reasons", async () => {
  const s = new AbortController().signal;
  resetSearchMemory();
  let f = fake({ "duckduckgo.com": "<html></html>", "mojeek.com": "<html></html>", "bing.com": "<html></html>" });
  try {
    assert.deepEqual(await searchWeb("q", undefined, s), []);
  } finally {
    f.restore();
  }
  resetSearchMemory();
  f = fake({ "duckduckgo.com": 503, "mojeek.com": 403, "bing.com": 500 });
  try {
    await assert.rejects(searchWeb("q", undefined, s), /every backend[\s\S]*mojeek: Search answered 403/);
  } finally {
    f.restore();
  }
});

test("checkBackends reports each backend and leaves the memory alone", async () => {
  resetSearchMemory();
  const f = fake({ "html.duckduckgo.com": DDG, "lite.duckduckgo.com": 429, "mojeek.com": MOJEEK, "bing.com": "<html></html>" });
  try {
    const r = await checkBackends("q", new AbortController().signal);
    assert.deepEqual(r.map((x) => [x.backend, x.ok, x.count]), [["duckduckgo", true, 1], ["duckduckgo-lite", false, 0], ["mojeek", true, 1], ["bing", false, 0]]);
    assert.match(r[1]!.error!, /429/);
    assert.equal(backendOrder()[0]!.name, "duckduckgo");
  } finally {
    f.restore();
  }
});
