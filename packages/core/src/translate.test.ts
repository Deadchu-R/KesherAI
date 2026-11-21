import { test } from "node:test";
import assert from "node:assert/strict";
import { Translator, autoTarget, cleanTranslation, notEnglish, pickFlash, pickTranslator, splitForTranslation, type TranslatorDeps } from "./translate.js";

test("notEnglish and autoTarget", () => {
  assert.equal(notEnglish("קוף על עץ"), true);
  assert.equal(notEnglish("a monkey on a tree, café style"), false);
  assert.equal(notEnglish("1024x1024"), false);
  assert.equal(autoTarget("שלום עולם"), "en");
  assert.equal(autoTarget("hello world"), "he");
});

test("pickTranslator: loaded chat model, then Gemini, then the local file", () => {
  assert.deepEqual(pickTranslator({ localChat: "llamacpp/a", gemini: "gemini/flash", translatorFile: "/m/t.gguf" }), { via: "chat", model: "llamacpp/a" });
  assert.deepEqual(pickTranslator({ gemini: "gemini/flash", translatorFile: "/m/t.gguf" }), { via: "gemini", model: "gemini/flash" });
  assert.deepEqual(pickTranslator({ translatorFile: "/m/t.gguf" }), { via: "local", model: "/m/t.gguf" });
  assert.equal(pickTranslator({}), undefined);
});

test("pickFlash skips lite, image and tts models", () => {
  const m = (providerModelId: string, category = "chat") => ({ id: `gemini/${providerModelId}`, providerModelId, category });
  assert.equal(pickFlash([m("gemini-2.5-pro"), m("gemini-2.5-flash-lite"), m("gemini-2.5-flash-image", "image"), m("gemini-2.5-flash")]), "gemini/gemini-2.5-flash");
  assert.equal(pickFlash([m("gemini-2.5-flash"), m("gemini-3.0-flash"), m("gemini-flash-latest")]), "gemini/gemini-flash-latest");
  assert.equal(pickFlash([m("gemini-2.5-flash"), m("gemini-3.0-flash"), m("gemini-3.1-flash-preview")]), "gemini/gemini-3.0-flash");
  assert.equal(pickFlash([m("gemini-2.5-pro")]), undefined);
});

test("cleanTranslation removes labels, quotes and thinking", () => {
  assert.equal(cleanTranslation("<think>hmm</think>\nTranslation: \"a monkey on a tree\""), "a monkey on a tree");
  assert.equal(cleanTranslation("He said \"hi\" twice"), "He said \"hi\" twice");
});

test("splitForTranslation keeps pieces short and loses nothing", () => {
  const text = Array.from({ length: 10 }, (_, i) => `paragraph ${i} `.repeat(30)).join("\n\n");
  const parts = splitForTranslation(text, 800);
  assert.ok(parts.every((p) => p.length <= 800));
  assert.equal(parts.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

/** A translator whose model answers with `answer`, recording what it was asked. */
function fake(over: Partial<TranslatorDeps>, answer = "a monkey on a tree") {
  const calls: Array<{ model: string; system: string; user: string }> = [];
  const loaded: string[] = [];
  const deps: TranslatorDeps = {
    localChat: () => undefined,
    gemini: async () => undefined,
    translatorFile: () => undefined,
    loadFile: async (p) => (loaded.push(p), "llamacpp-beside/translategemma"),
    turn: (model) => async (req) => {
      calls.push({ model, system: String(req.messages[0]!.content), user: String(req.messages[1]!.content) });
      return { text: answer, toolCalls: [] };
    },
    ...over,
  };
  return { t: new Translator(deps), calls, loaded };
}

test("englishPrompt leaves English alone and translates Hebrew", async () => {
  const { t, calls } = fake({ localChat: () => "llamacpp/qwen" });
  assert.deepEqual(await t.englishPrompt("a red fox"), { prompt: "a red fox", translated: false });
  assert.equal(calls.length, 0);
  const r = await t.englishPrompt("קוף על עץ");
  assert.deepEqual(r, { prompt: "a monkey on a tree", translated: true, via: "chat" });
  assert.equal(calls[0]!.model, "llamacpp/qwen");
  assert.match(calls[0]!.system, /generator/);
});

test("the local translation model is loaded only when nothing else can translate", async () => {
  const { t, loaded, calls } = fake({ translatorFile: () => "/models/translation/translategemma.gguf" });
  await t.translate("שלום", "en");
  assert.deepEqual(loaded, ["/models/translation/translategemma.gguf"]);
  assert.equal(calls[0]!.model, "llamacpp-beside/translategemma");
});

test("no translator: a clear error; an answer still not in English is refused", async () => {
  await assert.rejects(fake({}).t.translate("שלום", "en"), /No model can translate/);
  await assert.rejects(fake({ localChat: () => "llamacpp/x" }, "קוף").t.englishPrompt("קוף"), /did not come out in English/);
});
