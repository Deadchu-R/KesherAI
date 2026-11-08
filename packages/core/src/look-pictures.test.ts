import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downloadPicture, parseCommons, picturesForStyle, sniffPicture } from "./look-pictures.js";

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
    const got = parseCommons({ query: { pages: { a: page(2), b: page(1, { thumburl: "https://evil.example/x.png" }), c: page(3, { mime: "image/svg+xml" }) } } });
    assert.deepEqual(got.map((p) => p.url), ["https://upload.wikimedia.org/x/2.png"]);
    assert.equal(got[0]!.artist, "Someone");
  });

  it("refuses other hosts and non-pictures", async () => {
    const f = (async () => new Response(new TextEncoder().encode("<html>"), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(downloadPicture({ url: "https://evil.example/a.png", width: 1, height: 1, page: "", license: "", artist: "" }, { fetchImpl: f }), /Commons/);
    await assert.rejects(downloadPicture({ url: "https://upload.wikimedia.org/a.png", width: 1, height: 1, page: "", license: "", artist: "" }, { fetchImpl: f }), /not a picture/);
  });

  it("finds a background and icons", async () => {
    const f = (async (u: string | URL) => {
      if (String(u).startsWith("https://commons.wikimedia.org/")) return Response.json({ query: { pages: { a: page(1), b: page(2), c: page(3) } } });
      return new Response(PNG);
    }) as unknown as typeof fetch;
    const r = await picturesForStyle("One Piece", { background: true, icons: 2, fetchImpl: f });
    assert.equal(r.background?.mimeType, "image/png");
    assert.equal(r.icons.length, 2);
  });
});
