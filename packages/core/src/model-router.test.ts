import { test } from "node:test";
import assert from "node:assert/strict";
import { decideModel, defaultStrengths, NeedClassifier, needByWords, nextSticky, parseNeed, STICKY_TURNS, type DecideInput, type RouteCandidate } from "./model-router.js";

const QWEN: RouteCandidate = { id: "llamacpp/Qwen3.6-27B-Q4_K_M", name: "Qwen3.6-27B", where: "local", strengths: ["tools", "code"], ready: true };
const DICTA: RouteCandidate = { id: "llamacpp/DictaLM-3.0-24B-Q4_K_M", name: "DictaLM-3.0-24B", where: "local", strengths: ["hebrew"], ready: false, loadSec: 16 };
const GEMINI: RouteCandidate = { id: "google/gemini-flash-latest", name: "gemini-flash-latest", where: "cloud", strengths: ["research", "vision", "fast"], ready: true };
const base = (over: Partial<DecideInput>): DecideInput => ({ strong: false, candidates: [QWEN, DICTA, GEMINI], current: QWEN.id, noCloud: false, cloudKinds: ["research"], ...over });

test("defaultStrengths: families", () => {
  assert.deepEqual(defaultStrengths("llamacpp/Qwen3.6-27B-Q4_K_M"), ["tools", "code"]);
  assert.deepEqual(defaultStrengths("llamacpp/DictaLM-3.0-24B-Q4_K_M"), ["hebrew"]);
  assert.deepEqual(defaultStrengths("google/gemini-flash-latest"), ["research", "vision", "fast"]);
  assert.ok(defaultStrengths("llamacpp/Qwen3-4B-Q4_K_M").includes("fast"));
  assert.ok(!defaultStrengths("llamacpp/Qwen3-30B-A3B-Q4_K_M").includes("fast"), "an MoE's active size is not its size");
  assert.deepEqual(defaultStrengths("other/mystery-model"), []);
});

test("needByWords: lyrics and long Hebrew text are a strong Hebrew need, even with a music tool", () => {
  assert.deepEqual(needByWords("תכתוב לי שיר על הים ותעשה ממנו שיר", { groups: ["audio"], music: true }), { need: "hebrew", strong: true });
  assert.deepEqual(needByWords("תכתוב מכתב תודה למורה של הבת שלי", { groups: [] }), { need: "hebrew", strong: true });
  assert.deepEqual(needByWords("תנסח לי משפט", { groups: [] }), { need: "hebrew", strong: false });
});

test("needByWords: tools, research, code, vision, fast", () => {
  assert.deepEqual(needByWords("open the site and email me the table", { groups: ["browser", "google"] }), { need: "tools", strong: true });
  assert.deepEqual(needByWords("תצייר לי חתול", { groups: ["images"] }), { need: "tools", strong: false });
  assert.deepEqual(needByWords("תעשה מחקר על מחירי כרטיסי מסך", { groups: ["web"] }), { need: "research", strong: true });
  assert.equal(needByWords("fix this:\n```ts\nconst a = 1\n```", { groups: ["files"] }).need, "code");
  assert.deepEqual(needByWords("מה זה?", { groups: [], image: true }), { need: "vision", strong: true });
  assert.deepEqual(needByWords("תודה!", { groups: [], simple: true }), { need: "fast", strong: false });
  assert.deepEqual(needByWords("what do you think about cats", { groups: [] }), { strong: false });
});

test("parseNeed reads the tiny call's JSON", () => {
  assert.deepEqual(parseNeed('{"need":"hebrew","long":true}'), { need: "hebrew", strong: true });
  assert.deepEqual(parseNeed('{"need":"tools","long":true}'), { need: "tools", strong: false });
  assert.deepEqual(parseNeed('{"need":"general","long":false}'), { strong: false });
  assert.equal(parseNeed("nope"), undefined);
  assert.equal(parseNeed('{"need":"vision"}'), undefined, "vision comes from attachments only");
});

test("NeedClassifier asks the model only when the words are not clear, and caches", async () => {
  let calls = 0;
  const ask = async () => { calls++; return '{"need":"code","long":false}'; };
  const c = new NeedClassifier();
  assert.deepEqual(await c.classify("תכתוב מכתב ארוך לחבר", { groups: [] }, ask), { need: "hebrew", strong: true });
  assert.equal(calls, 0, "a strong need by words needs no call");
  assert.equal((await c.classify("how should I structure this", { groups: [] }, ask)).need, "code");
  await c.classify("how should I structure this", { groups: [] }, ask);
  assert.equal(calls, 1);
  const failing = async () => { throw new Error("down"); };
  assert.deepEqual(await new NeedClassifier().classify("hello there friend", { groups: [] }, failing), { strong: false });
});

test("decideModel: stays on the loaded model for a weak need (no swap for small gains)", () => {
  assert.deepEqual(decideModel(base({ need: "hebrew", strong: false })), { modelId: QWEN.id, why: "general", swap: false });
  assert.deepEqual(decideModel(base({})), { modelId: QWEN.id, why: "general", swap: false });
  assert.equal(decideModel(base({ need: "tools", strong: true })).why, "tools");
});

test("decideModel: swaps for a strong need, with the load time", () => {
  assert.deepEqual(decideModel(base({ need: "hebrew", strong: true })), { modelId: DICTA.id, why: "hebrew", swap: true, loadSec: 16 });
  // On DictaLM (loaded now), a multi-tool task goes back to Qwen.
  const onDicta = base({ need: "tools", strong: true, current: DICTA.id, candidates: [{ ...QWEN, ready: false, loadSec: 16 }, { ...DICTA, ready: true }, GEMINI] });
  assert.deepEqual(decideModel(onDicta), { modelId: QWEN.id, why: "tools", swap: true, loadSec: 16 });
});

test("decideModel: research goes to the cloud only when allowed, never in privacy", () => {
  assert.equal(decideModel(base({ need: "research", strong: false })).modelId, GEMINI.id, "no load: a free move");
  assert.equal(decideModel(base({ need: "research", strong: true, noCloud: true })).modelId, QWEN.id);
  assert.equal(decideModel(base({ need: "research", strong: true, cloudKinds: [] })).modelId, QWEN.id);
  // A cloud model never answers a kind the user did not allow, even as the chat's current model.
  assert.equal(decideModel(base({ need: "hebrew", strong: false, current: GEMINI.id })).modelId, QWEN.id);
  assert.equal(decideModel(base({ current: GEMINI.id, noCloud: true })).modelId, QWEN.id);
});

test("decideModel: with cloud-in-Auto off (the default), web research stays on a local model", () => {
  for (const strong of [false, true]) assert.equal(decideModel(base({ need: "research", strong, cloudKinds: [] })).modelId, QWEN.id);
  assert.equal(decideModel(base({ need: "research", strong: true, cloudKinds: [], current: GEMINI.id })).modelId, QWEN.id, "even from a cloud chat model");
});

test("decideModel: a cloud-only user keeps the cloud for everything (not in privacy)", () => {
  const cloud = { candidates: [GEMINI], current: GEMINI.id };
  assert.equal(decideModel(base({ ...cloud, need: "code" })).modelId, GEMINI.id);
  assert.equal(decideModel(base({ ...cloud, noCloud: true })).modelId, GEMINI.id, "nothing else to pick: stays");
});

test("decideModel: a picture goes to a model that sees", () => {
  assert.deepEqual(decideModel(base({ need: "vision", strong: true, cloudKinds: ["vision"] })), { modelId: GEMINI.id, why: "vision", swap: false });
  assert.equal(decideModel(base({ need: "vision", strong: true })).modelId, QWEN.id, "pictures not allowed to the cloud: stays");
  assert.equal(decideModel(base({ need: "vision", strong: true, cloudKinds: ["vision"], noCloud: true })).modelId, QWEN.id, "privacy: stays");
  const seer: RouteCandidate = { id: "llamacpp/Qwen2.5-VL-7B-Q4_K_M", name: "Qwen2.5-VL-7B", where: "local", strengths: ["vision"], ready: false, loadSec: 8 };
  assert.deepEqual(decideModel(base({ need: "vision", strong: true, candidates: [QWEN, seer] })), { modelId: seer.id, why: "vision", swap: true, loadSec: 8 });
});

test("stickiness: the choice holds for the next turns of the task, then ends", () => {
  const first = decideModel(base({ need: "hebrew", strong: true }));
  let sticky = nextSticky(undefined, first, true);
  assert.deepEqual(sticky, { modelId: DICTA.id, need: "hebrew", left: STICKY_TURNS });
  const onDicta = [{ ...QWEN, ready: false, loadSec: 16 }, { ...DICTA, ready: true }, GEMINI];
  // "make it shorter" (a general follow-up) stays on DictaLM, and so does a weak tool need.
  for (const need of [{}, { need: "tools" as const, strong: false }]) {
    const p = decideModel(base({ ...need, candidates: onDicta, current: DICTA.id, ...(sticky ? { sticky } : {}) }));
    assert.equal(p.modelId, DICTA.id);
    assert.equal(p.why, "hebrew");
    sticky = nextSticky(sticky, p, false);
  }
  assert.equal(sticky?.left, 1);
  // A strong need for another model ends it.
  const p = decideModel(base({ need: "tools", strong: true, candidates: onDicta, current: DICTA.id, ...(sticky ? { sticky } : {}) }));
  assert.equal(p.modelId, QWEN.id);
  assert.equal(nextSticky(sticky, p, true)?.modelId, QWEN.id);
  assert.equal(nextSticky({ modelId: DICTA.id, left: 1 }, { modelId: DICTA.id, why: "general", swap: false }, false), undefined);
});
