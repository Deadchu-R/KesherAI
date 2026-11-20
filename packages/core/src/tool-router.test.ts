import { test } from "node:test";
import assert from "node:assert/strict";
import { engineAsk, isSimpleTurn, missingNote, parseGroups, ToolRouter, type AskJson } from "./tool-router.js";

const available = ["browser_open", "document", "generate_image", "read_file", "unity_scene", "web_search"];

test("without the engine, the words route the message (Hebrew and English)", async () => {
  const r = new ToolRouter();
  assert.deepEqual((await r.route("תצייר לי חתול", available, [], true)).tools, ["generate_image"]);
  assert.deepEqual((await r.route("תפתח את האתר", available, [], true)).tools, ["browser_open"]);
  assert.deepEqual((await r.route("תכתוב מסמך", available, [], true)).tools, ["document"]);
  assert.deepEqual((await r.route("שנה את הסצנה ביוניטי", available, [], true)).tools, ["unity_scene"]);
});

test("the engine's pick adds to the words, is cached per message, and is skipped when tool search is off", async () => {
  let calls = 0;
  const ask: AskJson = async () => {
    calls++;
    return '{"groups": ["web", "nonsense"]}';
  };
  const r = new ToolRouter({ ask: () => ask });
  assert.deepEqual((await r.route("מה קרה היום בעולם? תצייר משהו", available, [], true)).tools, ["generate_image", "web_search"]);
  await r.route("מה קרה היום בעולם? תצייר משהו", available, [], true);
  assert.equal(calls, 1);
  await r.route("something else", available, [], false);
  assert.equal(calls, 1);
});

test("a slow or failing engine falls back to the words", async () => {
  const slow: AskJson = (_s, _u, _schema, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const r = new ToolRouter({ ask: () => slow, timeoutMs: 20 });
  assert.deepEqual((await r.route("draw a cat", available, [], true)).groups, ["images"]);
  const broken = new ToolRouter({ ask: () => async () => { throw new Error("down"); } });
  assert.deepEqual((await broken.route("draw a cat", available, [], true)).groups, ["images"]);
});

test("groups turned off are never routed to; a needed group without tools is reported missing", async () => {
  const r = new ToolRouter();
  assert.deepEqual((await r.route("draw a cat", available, ["images"], false)).tools, []);
  const missing = (await r.route("תצייר לי חתול", ["read_file"], [], false)).missing;
  assert.deepEqual(missing, [{ group: "images", needs: "image-model" }]);
  assert.match(missingNote(missing)!, /offer_install.*image-model|image-model.*offer_install/s);
  assert.equal(missingNote([]), undefined);
});

test("the model's answer is read strictly", () => {
  assert.deepEqual(parseGroups('{"groups":["images","video","web","docs"]}'), ["images", "video", "web"]);
  assert.deepEqual(parseGroups("not json"), []);
  assert.deepEqual(parseGroups('Sure: {"groups":["unity","unity"]}'), ["unity"]);
});

test("simple turns: short, no tool group, no code, files, links or careful work", () => {
  for (const t of ["hi", "תודה רבה!", "what's the capital of France?", "מה השעה בטוקיו?"]) assert.equal(isSimpleTurn(t, []), true, t);
  assert.equal(isSimpleTurn("hi", ["image"]), false, "a tool group means tools");
  for (const t of ["fix the bug in app.ts", "explain closures", "תכתוב לי שיר", "read https://x.com", "`ls`", "x".repeat(200), "a\nb", ""]) assert.equal(isSimpleTurn(t, []), false, t);
});

test("the router's engine call is pinned to the other slot when the engine has one per kind", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const ask = (slots: number) => engineAsk({ baseUrl: () => "http://127.0.0.1:1/v1", apiKey: "k", ready: () => true, slots: () => slots })!;
    await ask(3)("s", "u", {}, new AbortController().signal);
    await ask(1)("s", "u", {}, new AbortController().signal);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(bodies[0]!.id_slot, 2);
  assert.equal(bodies[1]!.id_slot, undefined, "one slot: llama.cpp picks");
  assert.equal(bodies[1]!.cache_prompt, true);
});
