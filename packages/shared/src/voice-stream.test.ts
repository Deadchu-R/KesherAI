import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTranscripts, nextSentences, SentenceQueue, splitSentences, SttStream, type SttAction } from "./voice-stream.js";

/** Blocks of 0.1 s; `pattern` is "x" for speech and "." for quiet. */
function feed(st: SttStream<number>, pattern: string, start = 0): Array<SttAction<number>> {
  const out: Array<SttAction<number>> = [];
  [...pattern].forEach((c, i) => out.push(...st.push(start + i, c === "x")));
  return out;
}

test("SttStream: partials while talking, one at a time, and only when there is new speech", () => {
  const st = new SttStream<number>(0.1);
  const a = feed(st, "xxxxxxxx");
  assert.deepEqual(a.map((x) => x.do), ["partial"]);
  assert.deepEqual(a[0]!.blocks, [0, 1, 2, 3, 4, 5, 6]);
  // Still on its way: no second partial yet.
  assert.deepEqual(feed(st, "xxxxxxxx", 8), []);
  st.done(a[0]!.id, "hello");
  assert.equal(st.text(), "hello");
  const b = feed(st, "x", 16);
  assert.equal(b[0]?.do, "partial");
  assert.equal(b[0]!.blocks.length, 17);
});

test("SttStream: a pause after enough words closes a segment; the final only transcribes the tail", () => {
  const st = new SttStream<number>(0.1);
  const first = feed(st, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx....");
  const seg = first.find((x) => x.do === "segment")!;
  assert.ok(seg, "a segment closed at the pause");
  // Cut after the speech plus 0.3 s of quiet.
  assert.equal(seg.blocks.length, 33);
  for (const p of first.filter((x) => x.do === "partial")) st.done(p.id, "partial words");
  st.done(seg.id, "the first part");
  feed(st, "xxxxx", 100);
  const fin = st.end();
  assert.equal(fin.length, 1);
  assert.deepEqual(fin[0]!.blocks, [100, 101, 102, 103, 104]);
  assert.equal(st.ready(), false);
  st.done(fin[0]!.id, "and the end");
  assert.ok(st.ready());
  assert.equal(st.text(), "the first part and the end");
});

test("SttStream: when the last partial heard all the speech, nothing is transcribed again", () => {
  const st = new SttStream<number>(0.1);
  const a = feed(st, "xxxxxx.");
  const p = a.find((x) => x.do === "partial")!;
  assert.ok(p);
  // The partial is still on its way when the user stops: it becomes the final text.
  assert.deepEqual(st.end(), []);
  assert.equal(st.ready(), false);
  st.done(p.id, "short question");
  assert.ok(st.ready());
  assert.equal(st.text(), "short question");
});

test("SttStream: a failed partial that became the last part is sent again; no partials once turned off", () => {
  const st = new SttStream<number>(0.1);
  const p = feed(st, "xxxxxx.").find((x) => x.do === "partial")!;
  assert.deepEqual(st.end(), []);
  const again = st.done(p.id, null);
  assert.equal(again.length, 1);
  assert.deepEqual(again[0]!.blocks, [0, 1, 2, 3, 4, 5, 6]);
  st.done(again[0]!.id, "again");
  assert.ok(st.ready());
  assert.equal(st.text(), "again");
  const off = new SttStream<number>(0.1);
  off.noPartials();
  assert.deepEqual(feed(off, "xxxxxxxxxxxx"), []);
  assert.equal(off.end().length, 1);
});

test("SttStream: speech after the last partial is transcribed at the end; quiet only gives nothing", () => {
  const st = new SttStream<number>(0.1);
  const p = feed(st, "xxxxxxx").find((x) => x.do === "partial")!;
  st.done(p.id, "half");
  feed(st, "xx", 7);
  const fin = st.end();
  assert.equal(fin.length, 1);
  assert.equal(st.text(), "half", "the partial is shown until the final comes");
  st.done(fin[0]!.id, "half and more");
  assert.equal(st.text(), "half and more");
  const quiet = new SttStream<number>(0.1);
  feed(quiet, "......");
  assert.deepEqual(quiet.end(), []);
  assert.ok(quiet.ready());
  assert.equal(quiet.text(), "");
});

test("mergeTranscripts: joins pieces, drops no-speech marks and boundary repeats (Hebrew and English)", () => {
  assert.equal(mergeTranscripts(["Open the", "the file please"]), "Open the file please");
  assert.equal(mergeTranscripts(["תפתח את הקובץ", "הקובץ החדש"]), "תפתח את הקובץ החדש");
  assert.equal(mergeTranscripts(["  hi ", "[BLANK_AUDIO]", "", "(music)", "there."]), "hi there.");
  assert.equal(mergeTranscripts(["New York,", "new york city"]), "New York, city");
  assert.equal(mergeTranscripts(["one two", "three"]), "one two three");
});

test("splitSentences: English, numbers, abbreviations, initials and list numbers", () => {
  assert.deepEqual(splitSentences("It costs 3.50 dollars. Dr. Smith agrees, e.g. on price. J. K. Rowling wrote it! Done?"), [
    "It costs 3.50 dollars.",
    "Dr. Smith agrees, e.g. on price.",
    "J. K. Rowling wrote it!",
    "Done?",
  ]);
  assert.deepEqual(splitSentences("Steps:\n1. Open it.\n2. Save it.\nIn 2019. Then more"), ["Steps:", "Open it.", "Save it.", "In 2019.", "Then more"]);
});

test("splitSentences: Hebrew, mixed text, markdown and code", () => {
  assert.deepEqual(splitSentences('המחיר הוא 3.5 ש"ח. זה כולל מע"מ, וכו\'. מה עוד?'), ['המחיר הוא 3.5 ש"ח.', 'זה כולל מע"מ, וכו\'.', "מה עוד?"]);
  assert.deepEqual(splitSentences("**Sure.** Run this:\n```js\nrun(1. 2)\n```\nThen [check](http://x) it."), ["Sure.", "Run this:", "(code on screen)", "Then check it."]);
  assert.deepEqual(splitSentences("```\nx\n```", true), ["(קוד על המסך)"]);
});

test("nextSentences: text that is still being written", () => {
  let text = "First one. Second";
  let r = nextSentences(text, 0, false);
  assert.deepEqual(r.sentences, ["First one."]);
  // "3." could still become "3.5": not said until something follows.
  text += " costs 3.";
  r = nextSentences(text, r.next, false);
  assert.deepEqual(r.sentences, []);
  text += "5 now. Code: ```py\nprint(1. 2)";
  r = nextSentences(text, r.next, false);
  assert.deepEqual(r.sentences, ["Second costs 3.5 now."]);
  text += "\n```\nEnd";
  const fin = nextSentences(text, r.next, true);
  assert.deepEqual(fin.sentences, ["Code:", "(code on screen)", "End"]);
  assert.equal(fin.next, text.length);
});

test("nextSentences: a long first sentence starts at a comma", () => {
  const text = `${"word ".repeat(20)}more words here, and it keeps going on without an end ${"yet ".repeat(10)}`;
  const r = nextSentences(text, 0, false);
  assert.equal(r.sentences.length, 1);
  assert.ok(r.sentences[0]!.endsWith("here,"));
});

/** A voice that records what it was asked to say and lets the test end each sentence. */
function fakeVoice() {
  const said: string[] = [];
  const ends: Array<() => void> = [];
  let stops = 0;
  const q = new SentenceQueue((text, done) => { said.push(text); ends.push(done); }, () => stops++);
  return { q, said, ends, stops: () => stops };
}

test("SentenceQueue: says sentences one after another, then calls onEnd once", () => {
  const v = fakeVoice();
  let ended = 0;
  v.q.play("One. Two. Three.", () => ended++);
  assert.deepEqual(v.said, ["One."]);
  v.ends[0]!();
  v.ends[1]!();
  assert.deepEqual(v.said, ["One.", "Two.", "Three."]);
  assert.equal(ended, 0);
  v.ends[2]!();
  assert.equal(ended, 1);
  assert.equal(v.q.speaking, false);
});

test("SentenceQueue: barge-in stops at once; a stopped sentence's late end starts nothing", () => {
  const v = fakeVoice();
  let ended = 0;
  v.q.play("One. Two. Three.", () => ended++);
  v.q.stop();
  assert.equal(v.stops(), 1);
  assert.equal(v.q.speaking, false);
  // The voice reports the stopped sentence's end afterwards.
  v.ends[0]!();
  assert.deepEqual(v.said, ["One."]);
  assert.equal(ended, 0);
  // A new line after the barge-in plays normally; stopping when idle does not call the voice.
  v.q.play("Next.", () => ended++);
  v.ends[1]!();
  assert.equal(ended, 1);
  v.q.stop();
  assert.equal(v.stops(), 1);
});
