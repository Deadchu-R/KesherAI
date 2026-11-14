import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as netServer, connect } from "node:net";
import { createServer as httpServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { sumFor, torPlatform } from "./tor.js";
import { fetchViaSocks, parseHttpResponse } from "./socks-fetch.js";

test("Tor's bundle name per computer, and its checksum line", () => {
  assert.equal(torPlatform("win32", "x64"), "windows-x86_64");
  assert.equal(torPlatform("linux", "x64"), "linux-x86_64");
  assert.equal(torPlatform("darwin", "arm64"), "macos-aarch64");
  assert.equal(torPlatform("linux", "arm64"), undefined);
  const list = `${"a".repeat(64)}  tor-expert-bundle-linux-x86_64-15.0.1.tar.gz\n${"b".repeat(64)}  other.tar.gz`;
  assert.equal(sumFor(list, "tor-expert-bundle-linux-x86_64-15.0.1.tar.gz"), "a".repeat(64));
  assert.equal(sumFor(list, "missing"), undefined);
});

test("parses chunked and gzip responses", () => {
  const body = gzipSync("שלום world");
  const raw = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`), body, Buffer.from("\r\n0\r\n\r\n")]);
  const r = parseHttpResponse(raw);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "שלום world");
});

test("reads a page through a SOCKS5 proxy by host name, following a redirect", async () => {
  const web = httpServer((req, res) => {
    if (req.url === "/old") return void res.writeHead(302, { location: "/new" }).end();
    res.writeHead(200, { "content-type": "text/html" }).end(`<p>host ${req.headers.host}</p>`);
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const webPort = (web.address() as AddressInfo).port;
  const asked: string[] = [];
  // A tiny SOCKS5 server: no auth, CONNECT by name; every name goes to the web server above.
  const socks = netServer((c) => {
    c.once("data", () => {
      c.write(Buffer.from([5, 0]));
      c.once("data", (req: Buffer) => {
        const len = req[4]!;
        asked.push(req.subarray(5, 5 + len).toString());
        const up = connect(webPort, "127.0.0.1", () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          c.pipe(up).pipe(c);
        });
      });
    });
  });
  await new Promise<void>((r) => socks.listen(0, "127.0.0.1", r));
  const page = await fetchViaSocks({ host: "127.0.0.1", port: (socks.address() as AddressInfo).port }, "http://blocked.example/old");
  assert.equal(page.status, 200);
  assert.equal(page.url, "http://blocked.example/new");
  assert.match(page.body, /host blocked\.example/);
  assert.deepEqual(asked, ["blocked.example", "blocked.example"], "the name goes to the proxy (looked up at the far end)");
  web.close();
  socks.close();
});
