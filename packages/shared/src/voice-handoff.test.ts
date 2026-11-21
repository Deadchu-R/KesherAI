import { test } from "node:test";
import assert from "node:assert/strict";
import { isApprovalWords, parseVoiceReply, shortSpoken, VOICE_LINES, VOICE_TARGETS, voiceStart, voiceStep, type VoiceEvent, type VoiceState } from "./voice-handoff.js";

/** Runs events in order, collecting every effect. */
function run(s: VoiceState, events: VoiceEvent[]) {
  const all = [];
  for (const e of events) {
    const r = voiceStep(s, e);
    s = r.state;
    all.push(...r.effects);
  }
  return { s, fx: all };
}

const en = () => voiceStart({ he: false, fallback: false, lastSeq: 10 });

test("a quick question is answered by the voice model, then it listens again", () => {
  const { s, fx } = run(en(), [{ type: "speechStart" }, { type: "speechEnd", seconds: 1.5 }, { type: "transcript", text: "hi there" }, { type: "reply", say: "Hi! How can I help?" }]);
  assert.deepEqual(fx, [{ do: "transcribe" }, { do: "ask", text: "hi there", working: false }, { do: "say", text: "Hi! How can I help?" }]);
  assert.equal(s.phase, "speaking");
  assert.equal(run(s, [{ type: "spoken" }]).s.phase, "ready");
});

test("real work is handed to the main model, and its result is said when done", () => {
  let { s, fx } = run(en(), [{ type: "speechStart" }, { type: "speechEnd", seconds: 2 }, { type: "transcript", text: "fix the build" }, { type: "reply", say: "", handoff: "Fix the build" }]);
  assert.deepEqual(fx.slice(-2), [{ do: "handoff", text: "Fix the build" }, { do: "say", text: VOICE_LINES.handoff.en }]);
  assert.equal(s.job, "running");
  // While it works the user can keep talking to the voice model, which knows a job runs.
  ({ s, fx } = run(s, [{ type: "spoken" }, { type: "speechStart" }, { type: "speechEnd", seconds: 1 }, { type: "transcript", text: "how long?" }]));
  assert.deepEqual(fx.at(-1), { do: "ask", text: "how long?", working: true });
  ({ s, fx } = run(s, [{ type: "reply", say: "Still working on it." }, { type: "spoken" }, { type: "mainAnswer", seq: 12, text: "Fixed two errors." }]));
  assert.deepEqual(fx.at(-1), { do: "summarize", text: "Fixed two errors.", direct: false });
  assert.equal(s.job, "none");
  ({ fx } = run(s, [{ type: "summary", text: "It's done. Two errors fixed." }]));
  assert.deepEqual(fx, [{ do: "say", text: "It's done. Two errors fixed." }]);
});

test("old answers and answers without a job are not read", () => {
  assert.deepEqual(run(en(), [{ type: "mainAnswer", seq: 9, text: "old" }, { type: "mainAnswer", seq: 11, text: "typed" }]).fx, []);
});

test("barge-in: speech over a spoken line stops it at once and listens", () => {
  const { s, fx } = run(en(), [{ type: "summary", text: "A long answer…" }, { type: "speechStart" }]);
  assert.deepEqual(fx, [{ do: "say", text: "A long answer…" }, { do: "stopSpeaking" }]);
  assert.equal(s.phase, "hearing");
});

test("barge-in by tap clears waiting lines; a cough does not transcribe", () => {
  let { s, fx } = run(en(), [{ type: "summary", text: "one" }, { type: "summary", text: "two" }, { type: "bargeIn" }]);
  assert.deepEqual(fx.at(-1), { do: "stopSpeaking" });
  assert.deepEqual(s.queue, []);
  ({ s, fx } = run(s, [{ type: "speechStart" }, { type: "speechEnd", seconds: 0.2 }]));
  assert.deepEqual(fx, []);
  assert.equal(s.phase, "ready");
});

test("a line that arrives while the user talks waits for its turn", () => {
  const { s, fx } = run(en(), [{ type: "speechStart" }, { type: "summary", text: "done" }]);
  assert.deepEqual(fx, []);
  assert.deepEqual(s.queue, ["done"]);
  assert.deepEqual(run(s, [{ type: "speechEnd", seconds: 0.1 }]).fx, [{ do: "say", text: "done" }]);
});

test("approval routing: announced once, on screen; a spoken yes never approves", () => {
  let { s, fx } = run(en(), [{ type: "speechStart" }, { type: "speechEnd", seconds: 1 }, { type: "transcript", text: "delete the temp files" }, { type: "reply", say: "On it.", handoff: "Delete the temp files" }, { type: "spoken" }, { type: "approvals", ids: ["r1"] }]);
  assert.deepEqual(fx.at(-1), { do: "say", text: VOICE_LINES.approval.en });
  assert.equal(s.job, "approval");
  // The same request again: not said twice.
  ({ s, fx } = run(s, [{ type: "spoken" }, { type: "approvals", ids: ["r1"] }]));
  assert.deepEqual(fx, []);
  ({ s, fx } = run(s, [{ type: "speechStart" }, { type: "speechEnd", seconds: 1 }, { type: "transcript", text: "Yes, approve it" }]));
  assert.ok(!fx.some((f) => f.do === "handoff" || f.do === "ask"), "nothing is sent for a spoken yes");
  assert.deepEqual(fx.at(-1), { do: "say", text: VOICE_LINES.approvalByVoice.en });
  // Approved on screen: the job runs again.
  ({ s } = run(s, [{ type: "spoken" }, { type: "approvals", ids: [] }]));
  assert.equal(s.job, "running");
});

test("fallback: without a voice model the main model answers, read shortened, without 'It's done'", () => {
  let { s, fx } = run(voiceStart({ he: true, fallback: true, lastSeq: 0 }), [{ type: "speechStart" }, { type: "speechEnd", seconds: 1 }, { type: "transcript", text: "מה השעה בטוקיו?" }]);
  assert.deepEqual(fx.at(-1), { do: "handoff", text: "מה השעה בטוקיו?" });
  assert.equal(s.phase, "replying");
  ({ s, fx } = run(s, [{ type: "mainAnswer", seq: 3, text: "עכשיו 22:00 בטוקיו." }]));
  assert.deepEqual(fx, [{ do: "summarize", text: "עכשיו 22:00 בטוקיו.", direct: true }]);
  assert.equal(s.phase, "ready");
});

test("a failing voice model switches to the fallback and sends what was heard", () => {
  const { s, fx } = run(en(), [{ type: "speechStart" }, { type: "speechEnd", seconds: 1 }, { type: "transcript", text: "plan my week" }, { type: "noVoiceModel" }]);
  assert.deepEqual(fx.at(-1), { do: "handoff", text: "plan my week" });
  assert.ok(s.fallback && s.direct);
});

test("isApprovalWords: short yeses in Hebrew and English only", () => {
  for (const t of ["yes", "OK, go ahead", "כן", "כן, תאשר", "ובסדר", "approve it"]) assert.ok(isApprovalWords(t), t);
  for (const t of ["what does it want to run?", "no", "לא", "tell me about the weather in Paris tomorrow please"]) assert.ok(!isApprovalWords(t), t);
});

test("parseVoiceReply reads SAY / HANDOFF, ignores thinking, and is lenient", () => {
  assert.deepEqual(parseVoiceReply("<think>hmm</think>SAY: Sure.\nHANDOFF: Build the level", false), { say: "Sure.", handoff: "Build the level" });
  assert.deepEqual(parseVoiceReply("SAY: היי!\nHANDOFF: NONE", true), { say: "היי!" });
  assert.deepEqual(parseVoiceReply("Hello there.", false), { say: "Hello there." });
});

test("shortSpoken drops code and markdown and cuts at a sentence", () => {
  assert.equal(shortSpoken("**Done.** See ```js\nx()\n``` and [docs](http://x).", false), "Done. See (code on screen) and docs.");
  const long = "First sentence here. ".repeat(30);
  const out = shortSpoken(long, false, 100);
  assert.ok(out.length <= 100 && out.endsWith("."));
});

test("the latency budget adds up", () => {
  assert.ok(VOICE_TARGETS.endOfSpeech + VOICE_TARGETS.transcribe + VOICE_TARGETS.reply + VOICE_TARGETS.firstAudio <= VOICE_TARGETS.total);
});
