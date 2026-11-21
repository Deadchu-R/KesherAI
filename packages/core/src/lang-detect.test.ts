import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeGarbage, myLanguages, normalizeProbs, scriptMatches, shiftStamps, sliceWav, summarizeParts, transcribeDetected, transcribeInParts, voteLanguage, wavSeconds, windowStarts, type DetectEngine, type LangProbs } from "./lang-detect.js";
import { wavFrom } from "./whisper.js";

/** A WAV of silence, `s` seconds at 16 kHz. */
const silence = (s: number) => wavFrom(new Float32Array(16000 * s));

test("normalizeProbs reads names and codes; myLanguages defaults to the app's language plus English", () => {
  assert.deepEqual(normalizeProbs({ Hebrew: 0.9, en: 0.1, klingon: 1 }), { he: 0.9, en: 0.1 });
  assert.deepEqual(myLanguages([], "he"), ["he", "en"]);
  assert.deepEqual(myLanguages(undefined, "en"), ["en"]);
  assert.deepEqual(myLanguages(["ar", "ar", "x"], "he"), ["ar"]);
});

test("the vote is restricted to my languages: Hebrew is not Spanish", () => {
  // The bug: whisper put Spanish on top for Hebrew speech.
  const w: LangProbs[] = [{ es: 0.5, he: 0.35, en: 0.05 }, { es: 0.45, he: 0.4 }, { es: 0.4, he: 0.45 }];
  const v = voteLanguage(w, ["he", "en"])!;
  assert.equal(v.lang, "he");
  assert.equal(v.outside, false);
  assert.deepEqual(v.ranked, ["he", "en"]);
});

test("a language outside mine wins only with very high confidence", () => {
  const sure: LangProbs[] = [{ es: 0.97, he: 0.01 }, { es: 0.95, he: 0.02 }];
  assert.deepEqual([voteLanguage(sure, ["he", "en"])!.lang, voteLanguage(sure, ["he", "en"])!.outside], ["es", true]);
  const unsure: LangProbs[] = [{ es: 0.6, he: 0.2 }, { es: 0.7, he: 0.1 }];
  assert.equal(voteLanguage(unsure, ["he", "en"])!.lang, "he");
});

test("nothing likely: the first of mine; no windows: undefined", () => {
  assert.equal(voteLanguage([{ fr: 0.3, he: 0.05 }], ["he", "en"])!.lang, "he");
  assert.equal(voteLanguage([], ["he"]), undefined);
});

test("script check allows Hebrew with English words, rejects Latin text for Hebrew", () => {
  assert.equal(scriptMatches("אני עובד ב Unreal Engine עם Blueprint כל יום", "he"), true);
  assert.equal(scriptMatches("hola amigos como estan todos hoy", "he"), false);
  assert.equal(scriptMatches("שלום לכולם מה שלומכם היום", "en"), false);
  assert.equal(scriptMatches("ok", "he"), true);
});

test("garbage: a looping phrase or a character run", () => {
  assert.equal(looksLikeGarbage("thank you for watching ".repeat(8)), true);
  assert.equal(looksLikeGarbage("a".repeat(40)), true);
  assert.equal(looksLikeGarbage("this is an ordinary sentence about the meeting tomorrow morning"), false);
});

test("wav slicing and windows", () => {
  const w = silence(100);
  assert.equal(Math.round(wavSeconds(w)), 100);
  assert.equal(Math.round(wavSeconds(sliceWav(w, 10, 25)!)), 25);
  assert.deepEqual(windowStarts(30), [0]);
  assert.equal(windowStarts(200).length, 3);
  assert.equal(shiftStamps("[0:05] a\n[1:00] b", 300), "[5:05] a\n[6:00] b");
});

/** A fake whisper: language probabilities by a script, and a text per language. */
const fake = (probs: LangProbs, texts: Record<string, string>, log: string[] = []): DetectEngine => ({
  detect: async () => probs,
  transcribe: async (_w, l) => (log.push(l), texts[l] ?? ""),
});

test("a text in the wrong script is transcribed again with the next likely language", async () => {
  const log: string[] = [];
  const e = fake({ en: 0.5, he: 0.45 }, { en: "hola que tal como va todo hoy amigo", he: "שלום לכולם איך אתם היום" }, log);
  // Detection says English first; the text is Hebrew speech turned into Latin: no, here English text fits English.
  assert.equal((await transcribeDetected(e, silence(10), ["he", "en"]))!.part.lang, "en");
  const e2 = fake({ he: 0.5, en: 0.45 }, { he: "this came out in latin letters only", en: "this came out in latin letters only" }, log);
  const r = (await transcribeDetected(e2, silence(10), ["he", "en"]))!;
  assert.deepEqual([r.part.lang, r.part.retried], ["en", true]);
  assert.deepEqual(log.slice(-2), ["he", "en"]);
});

test("detection not available: undefined, so the caller falls back", async () => {
  const e: DetectEngine = { detect: async () => undefined, transcribe: async () => "x" };
  assert.equal(await transcribeDetected(e, silence(5), ["he", "en"]), undefined);
});

test("a long recording is detected per part and the times are shifted", async () => {
  let n = 0;
  const e: DetectEngine = {
    // Part 1 is Hebrew, part 2 English.
    detect: async () => (n < 3 ? { he: 0.95 } : { en: 0.95 }),
    transcribe: async (_w, l) => {
      n += 3;
      return l === "he" ? "[0:01] שלום לכולם ברוכים הבאים" : "[0:02] welcome everybody to the lecture";
    },
  };
  const r = (await transcribeInParts(e, silence(400), ["he", "en"], true))!;
  assert.deepEqual(r.parts.map((p) => p.lang), ["he", "en"]);
  assert.match(r.text, /\[0:01\] שלום[\s\S]*\[5:02\] welcome/);
  const s = summarizeParts(r.parts);
  assert.deepEqual(s.langs, ["he", "en"]);
});

test("looksLikeGarbage: real speech with repeated words is not garbage; a looping phrase is", async () => {
  const { looksLikeGarbage } = await import("./lang-detect.js");
  const speech = "אני לא רוצה שם לעצור כל הפעם ואז לכתוב להם היי שליח הזה הזה הזה הזה והזה, שאו ככה וככה וככה וככה אתם מיזה, אני לא אגידו לו נו נו נו והתקדמו הלאה הם לא הביאו לך פיצוי או משהו כסף לא פזרו שבאת זה אם הם מביאים לי כסף והיא מקשר אם הם מציעים וולד כאלית הזה אני מתקשר לכל אחד שאני רואה";
  assert.equal(looksLikeGarbage(speech), false);
  assert.equal(looksLikeGarbage(Array(40).fill("Gracias.").join(" ")), true);
});
