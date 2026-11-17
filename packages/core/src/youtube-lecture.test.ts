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
