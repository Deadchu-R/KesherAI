import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downloadPicture, findPictures, parseCommons, picturesForStyle, sniffPicture } from "./look-pictures.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const page = (i: number, over: Record<string, unknown> = {}) => ({
  index: i,
  imageinfo: [{ thumburl: `https://upload.wikimedia.org/x/${i}.png`, mime: "image/png", thumbwidth: 1920, thumbheight: 1080, descriptionurl: `https://commons.wikimedia.org/wiki/File:${i}`, extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a href='x'>Someone</a>" } }, ...over }],
});

describe("look pictures", () => {
  it("knows picture bytes", () => {
    assert.equal(sniffPicture(PNG), "image/png");
    assert.equal(sniffPicture(new Uint8Array([0xff, 0xd8, 0xff, 0])), "image/jpeg");
    assert.equal(sniffPicture(new TextEncoder().encode("<svg onload=alert(1)>")), undefined);
  });

  it("keeps only bitmaps from the picture host", () => {
    const got = parseCommons({ query: { pages: { a: page(2), b: page(1, { thumburl: "https://evil.example/x.png" }), c: page(3, { mime: "image/gif" }) } } });
    assert.deepEqual(got.map((p) => p.url), ["https://upload.wikimedia.org/x/2.png"]);
    assert.equal(got[0]!.artist, "Someone");
  });

  it("refuses other hosts and non-pictures", async () => {
    const f = (async () => new Response(new TextEncoder().encode("<html>"), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(downloadPicture({ url: "https://evil.example/a.png", width: 1, height: 1, page: "", license: "", artist: "" }, { fetchImpl: f }), /Commons/);
    await assert.rejects(downloadPicture({ url: "https://upload.wikimedia.org/a.png", width: 1, height: 1, page: "", license: "", artist: "" }, { fetchImpl: f }), /not a picture/);
  });

  it("finds a background and icons on the web, through the proxy only", async () => {
    const asked: string[] = [];
    const f = (async (u: string | URL) => {
      const url = String(u);
      asked.push(url);
      if (url.startsWith("https://duckduckgo.com/?")) return new Response('<script>vqd="4-123456"</script>');
      if (url.startsWith("https://duckduckgo.com/i.js")) {
        const icon = new URL(url).searchParams.get("q")!.includes("icon");
        return Response.json({ results: [1, 2, 3].map((i) => ({ image: `http://192.168.1.1/${i}.png`, url: `https://fans.example/${i}`, width: icon ? 256 : 1920, height: icon ? 256 : 1080 })) });
      }
      return new Response(PNG);
    }) as unknown as typeof fetch;
    const r = await picturesForStyle("One Piece", { background: true, icons: 2, fetchImpl: f });
    assert.equal(r.background?.mimeType, "image/png");
    assert.equal(r.icons.length, 2);
    // The home-network address in a result is never fetched directly.
    assert.ok(asked.every((u) => !u.startsWith("http://192.168.")));
    assert.ok(asked.some((u) => u.startsWith("https://external-content.duckduckgo.com/iu/?u=http%3A%2F%2F192.168.1.1")));
  });
});

it("takes drawings only as their PNG copy", () => {
  const got = parseCommons({ query: { pages: { a: page(1, { mime: "image/svg+xml", thumburl: "https://upload.wikimedia.org/x/1.svg" }), b: page(2, { mime: "image/svg+xml", thumburl: "https://upload.wikimedia.org/x/2.svg.png" }) } } });
  assert.deepEqual(got.map((p) => p.url), ["https://upload.wikimedia.org/x/2.svg.png"]);
});

it("searches the words as a phrase, without unsuitable pictures", async () => {
  let asked = "";
  const f = (async (u: string | URL) => {
    asked = new URL(String(u)).searchParams.get("gsrsearch") ?? "";
    return Response.json({});
  }) as unknown as typeof fetch;
  await findPictures('One "Piece', { width: 256, fetchImpl: f });
  assert.match(asked, /^filetype:bitmap "One Piece" /);
  assert.match(asked, /-swimsuit/);
});
