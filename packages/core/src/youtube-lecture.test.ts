import { test } from "node:test";
import assert from "node:assert/strict";
import { vttText, youtubeId } from "./youtube-lecture.js";

test("a YouTube video's id from its links", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://evil.example/watch?v=dQw4w9WgXcQ"), undefined);
});

test("captions become text with a minute mark about every 30 seconds, scrolling repeats dropped", () => {
  const vtt = `WEBVTT\nKind: captions\nLanguage: he\n\n00:00:01.000 --> 00:00:03.000\nהלב הוא משאבה\n\n00:00:03.000 --> 00:00:05.000\nהלב הוא משאבה עם ארבעה חללים\n\n00:00:40.000 --> 00:00:42.000\nעלייה ימנית`;
  assert.equal(vttText(vtt), "[0:01] הלב הוא משאבה עם ארבעה חללים\n[0:40] עלייה ימנית");
});

test("videos found by a search: ids checked, shorts and live streams left out", async () => {
  const { parseVideoSearch } = await import("./youtube-lecture.js");
  const out = [
    JSON.stringify({ id: "dQw4w9WgXcQ", title: "  חוסמי   בטא – הרצאה ", channel: "Dr. Levi", duration: 1820.4 }),
    JSON.stringify({ id: "short123456", title: "short", duration: 40 }),
    JSON.stringify({ id: "live1234567", title: "live", live_status: "is_live" }),
    JSON.stringify({ id: "bad", title: "bad id" }),
    "not json",
    JSON.stringify({ id: "dQw4w9WgXcQ", title: "again" }),
    JSON.stringify({ id: "abcdefghijk", title: "No duration", uploader: "U" }),
  ].join("\n");
  assert.deepEqual(parseVideoSearch(out), [
    { id: "dQw4w9WgXcQ", title: "חוסמי בטא – הרצאה", channel: "Dr. Levi", duration: 1820 },
    { id: "abcdefghijk", title: "No duration", channel: "U" },
  ]);
});
