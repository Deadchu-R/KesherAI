import { test } from "node:test";
import assert from "node:assert/strict";
import { backendOrder, checkBackends, looksBlocked, parseBing, parseBrave, parseDuckLite, parseEcosia, parseMojeek, parseStartpage, parseTavily, parseYahoo, relevantHits, resetSearchMemory, setSearchEngine, setSearchKeys } from "./web-search.js";
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
  const f = fake({ "html.duckduckgo.com": "<div class='anomaly-modal'></div>", "lite.duckduckgo.com": 429, "yahoo.com": 403, "startpage.com": 429, "mojeek.com": "<ul></ul>", "ecosia.org": "<html></html>", "bing.com": BING });
  try {
    const r = await searchWeb("q", { never: ["direct.example"], safeSearch: "strict" }, s);
    assert.deepEqual(r.map((x) => x.url), ["https://example.net/page"]);
    assert.equal(f.asked.length, 7);
    assert.match(f.asked[1]!, /^POST https:\/\/lite\.duckduckgo\.com/);
    assert.match(f.asked[6]!, /bing\.com\/search\?q=q&setlang=en&adlt=strict/);
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
  let f = fake({ "duckduckgo.com": "<html></html>", "yahoo.com": "<html></html>", "startpage.com": "<html></html>", "mojeek.com": "<html></html>", "ecosia.org": "<html></html>", "bing.com": "<html></html>" });
  try {
    assert.deepEqual(await searchWeb("q", undefined, s), []);
  } finally {
    f.restore();
  }
  resetSearchMemory();
  f = fake({ "duckduckgo.com": 503, "yahoo.com": 503, "startpage.com": 503, "mojeek.com": 403, "ecosia.org": 503, "bing.com": 500 });
  try {
    await assert.rejects(searchWeb("q", undefined, s), /every backend[\s\S]*mojeek: Search answered 403/);
  } finally {
    f.restore();
  }
});

test("checkBackends reports each backend and leaves the memory alone", async () => {
  resetSearchMemory();
  const f = fake({ "html.duckduckgo.com": DDG, "lite.duckduckgo.com": 429, "yahoo.com": 429, "startpage.com": 429, "mojeek.com": MOJEEK, "ecosia.org": 429, "bing.com": "<html></html>" });
  try {
    const r = await checkBackends("q", new AbortController().signal);
    assert.deepEqual(r.map((x) => [x.backend, x.ok, x.count, x.relevant]), [["duckduckgo", true, 1, 1], ["duckduckgo-lite", false, 0, 0], ["yahoo", false, 0, 0], ["startpage", false, 0, 0], ["mojeek", true, 1, 1], ["ecosia", false, 0, 0], ["bing", false, 0, 0]]);
    assert.match(r[1]!.error!, /429/);
    assert.equal(backendOrder()[0]!.name, "duckduckgo");
  } finally {
    f.restore();
  }
});

// Bing's answer to "Unreal Engine 5.8 MCP server plugin" on a PC it took for a bot (live check, 2026-11-21).
const JUNK: Array<{ title: string; url: string; snippet: string }> = [
  { title: "乔治·索罗斯 - 知乎", url: "https://www.zhihu.com/topic/19560388", snippet: "George Soros is a Hungarian-American investor and philanthropist." },
  { title: "注册维基百科 - 百度知道", url: "https://zhidao.baidu.com/question/123.html", snippet: "How do I register a Wikipedia account? Open the page and click Create account." },
  { title: "Soros Fund Management - Wikipedia", url: "https://en.wikipedia.org/wiki/Soros_Fund_Management", snippet: "An American hedge fund." },
];
const REAL = [
  { title: "Unreal Engine MCP server plugin", url: "https://github.com/example/unreal-mcp", snippet: "A plugin that runs an MCP server inside the editor." },
  { title: "Engine 5.8 release notes", url: "https://dev.epicgames.com/documentation/unreal-engine/5.8", snippet: "What is new in Unreal Engine 5.8." },
];
const Q = "Unreal Engine 5.8 MCP server plugin";

test("relevantHits drops unrelated hits and calls a mostly unrelated page irrelevant", () => {
  assert.deepEqual(relevantHits(Q, JUNK), { kept: [], irrelevant: true });
  const mixed = relevantHits(Q, [...REAL, JUNK[0]!]);
  assert.deepEqual(mixed.kept, REAL);
  assert.equal(mixed.irrelevant, false);
  assert.equal(relevantHits(Q, [REAL[0]!, ...JUNK]).irrelevant, true);
  // Case, a plural, the address and the search's own site: words do not count.
  assert.equal(relevantHits("Plugins SITE:github.com OR site:gitlab.com", [{ title: "x", url: "https://github.com/a/plugin-list", snippet: "" }]).irrelevant, false);
  // No meaningful words (or no hits) means nothing to compare.
  assert.deepEqual(relevantHits("q", JUNK), { kept: JUNK, irrelevant: false });
  assert.deepEqual(relevantHits("the of", JUNK), { kept: JUNK, irrelevant: false });
  assert.deepEqual(relevantHits(Q, []), { kept: [], irrelevant: false });
  // Hebrew.
  assert.equal(relevantHits("איך מתקינים אנריל", [{ title: "התקנת אנריל אנג'ין", url: "https://a.example/x", snippet: "מתקינים" }]).irrelevant, false);
});

test("searchWeb moves on from a backend whose results do not match the query (the Bing junk page)", async () => {
  resetSearchMemory();
  const page = (hits: typeof JUNK) => hits.map((h) => `<li class="b_algo"><h2><a href="${h.url}">${h.title}</a></h2><div class="b_caption"><p>${h.snippet}</p></div></li>`).join("");
  const f = fake({
    "html.duckduckgo.com": 202, "lite.duckduckgo.com": 202, "yahoo.com": 202, "startpage.com": 202, "ecosia.org": 202, "mojeek.com": "<ul></ul>",
    "bing.com": `<ol>${page(JUNK)}</ol>`,
  });
  try {
    // Every backend fails, one of them with junk: an empty list, not the junk.
    assert.deepEqual(await searchWeb(Q, undefined, new AbortController().signal), []);
    const r = await checkBackends(Q, new AbortController().signal);
    const bing = r.find((x) => x.backend === "bing")!;
    assert.deepEqual([bing.ok, bing.count, bing.relevant], [false, 3, 0]);
    assert.match(bing.error!, /Irrelevant/);
  } finally {
    f.restore();
  }
});

test("Yahoo, Startpage and Ecosia pages are read (Yahoo's redirect links unwrapped)", () => {
  const yahoo = `<div class="dd algo algo-sr"><div class="compTitle options-toggle"><a href="https://r.search.yahoo.com/_ylt=A0/RV=2/RE=1/RO=10/RU=https%3a%2f%2fdocs.example.org%2Fa%3Fb%3D1/RK=2/RS=zz-" class=" d-ib"><h3 class="title"><span>Docs <b>A</b></span></h3></a></div><div class="compText aAbs"><p class="fc-dustygray"><span>Yahoo snippet.</span></p></div></div>
<div class="dd algo"><div class="compTitle"><a href="https://direct.example/y"><h3>Direct</h3></a></div></div>`;
  assert.deepEqual(parseYahoo(yahoo), [
    { title: "Docs A", url: "https://docs.example.org/a?b=1", snippet: "Yahoo snippet." },
    { title: "Direct", url: "https://direct.example/y", snippet: "" },
  ]);
  const start = `<div class="result"><a class="result-title result-link css-1" href="https://start.example/a"><h2 class="wgl-title css-2">Start <b>A</b></h2></a><p class="description css-3">Start snippet.</p></div>
<div class="result"><a class="result-link" href="/internal"><h2>Skipped</h2></a></div>`;
  assert.deepEqual(parseStartpage(start), [{ title: "Start A", url: "https://start.example/a", snippet: "Start snippet." }]);
  const eco = `<div class="result__body"><a class="result__link" href="https://eco.example/a"><h2 class="result__title">Eco A</h2></a><p class="web-result__description">Eco snippet.</p></div>
<a data-test-id="result-link" href="https://eco.example/b">Eco B</a><div data-test-id="result-snippet">B snippet.</div>`;
  assert.deepEqual(parseEcosia(eco), [
    { title: "Eco A", url: "https://eco.example/a", snippet: "Eco snippet." },
    { title: "Eco B", url: "https://eco.example/b", snippet: "B snippet." },
  ]);
  assert.deepEqual([parseYahoo("x"), parseStartpage("x"), parseEcosia("x")], [[], [], []]);
});

test("keyed backends: parsers, and they are used first only when a key is set", async () => {
  assert.deepEqual(parseTavily(JSON.stringify({ results: [{ title: "T", url: "https://t.example/a", content: "c" }, { title: "No url" }] })), [{ title: "T", url: "https://t.example/a", snippet: "c" }]);
  assert.deepEqual(parseBrave(JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example/a", description: "a <strong>b</strong>" }] } })), [{ title: "B", url: "https://b.example/a", snippet: "a b" }]);
  assert.deepEqual([parseTavily("<html>"), parseBrave("{}")], [[], []]);

  resetSearchMemory();
  assert.ok(!backendOrder().some((b) => b.enabled), "no key, no keyed backend");
  setSearchKeys(() => ({ tavily: "tvly-secret", brave: " brave-secret " }));
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ results: [{ title: "Unreal Engine MCP", url: "https://t.example/a", content: "unreal engine mcp" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(backendOrder().slice(0, 2).map((b) => b.name), ["tavily", "brave"]);
    const r = await searchWeb("unreal engine mcp", undefined, new AbortController().signal);
    assert.equal(r[0]!.url, "https://t.example/a");
    assert.equal(seen.length, 1, "the first keyed backend answered, no page was fetched");
    assert.equal(seen[0]!.url, "https://api.tavily.com/search");
    assert.equal(seen[0]!.init!.method, "POST");
    assert.equal((seen[0]!.init!.headers as Record<string, string>).authorization, "Bearer tvly-secret");
    assert.equal(JSON.parse(String(seen[0]!.init!.body)).query, "unreal engine mcp");
  } finally {
    globalThis.fetch = real;
    setSearchKeys(() => undefined);
  }
});

test("the chosen engine is tried first, the others follow; an unusable choice is ignored; the answering engine is reported", async () => {
  resetSearchMemory();
  const names = () => backendOrder().map((b) => b.name);
  try {
    assert.equal(names()[0], "duckduckgo", "automatic");
    setSearchEngine(() => "yahoo");
    assert.deepEqual(names(), ["yahoo", "duckduckgo", "duckduckgo-lite", "startpage", "mojeek", "ecosia", "bing"]);
    setSearchEngine(() => "brave");
    assert.equal(names()[0], "duckduckgo", "brave without a key is not used");
    setSearchKeys(() => ({ brave: "b" }));
    assert.deepEqual(names().slice(0, 2), ["brave", "duckduckgo"]);
    setSearchKeys(() => ({ tavily: "t", brave: "b" }));
    setSearchEngine(() => "brave");
    assert.deepEqual(names().slice(0, 3), ["brave", "tavily", "duckduckgo"]);

    // The choice errors: the next answers, and is named.
    setSearchKeys(() => undefined);
    setSearchEngine(() => "mojeek");
    const f = fake({ "mojeek.com": 403, "html.duckduckgo.com": DDG.replace("DDG A", "q DDG A") });
    try {
      let engine = "";
      const r = await searchWeb("q", undefined, new AbortController().signal, (n) => void (engine = n));
      assert.equal(r.length, 1);
      assert.equal(engine, "duckduckgo");
      assert.match(f.asked[0]!, /mojeek\.com/);
    } finally {
      f.restore();
    }
  } finally {
    setSearchEngine(() => "auto");
    setSearchKeys(() => undefined);
    resetSearchMemory();
  }
});
