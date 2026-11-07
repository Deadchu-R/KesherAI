import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, installCommand, parseSearchResults, webFetchTool } from "./system-tools.js";

test("install commands per platform", () => {
  assert.match(installCommand("python", "win32") ?? "", /^winget install --id Python\.Python\.3\.12 -e/);
  assert.equal(installCommand("java", "darwin"), "brew install openjdk@21");
  assert.equal(installCommand("git", "linux"), "sudo apt-get install -y git");
  assert.equal(installCommand("nope", "win32"), undefined);
});

test("search results and page text", () => {
  const html = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&amp;rut=x">Python <b>docs</b></a><a class="result__snippet" href="x">The official <b>Python</b> documentation.</a>';
  assert.deepEqual(parseSearchResults(html), [{ title: "Python docs", url: "https://docs.python.org/3/", snippet: "The official Python documentation." }]);
  assert.equal(htmlToText("<html><script>x()</script><h1>Title</h1><p>Hello &amp; welcome</p></html>"), "Title\n Hello & welcome");
});

test("web_fetch refuses this computer and the home network", async () => {
  const ctx = { signal: new AbortController().signal, recordChange() {} };
  for (const url of ["http://localhost:7420/api/remote", "http://127.0.0.1:7420", "http://192.168.1.1", "file:///etc/passwd"]) {
    await assert.rejects(webFetchTool.run({ url }, ctx), /public web pages|http and https/, url);
  }
});
