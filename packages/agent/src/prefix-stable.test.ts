import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ModelTurn } from "./session.js";
import { CODE_TOOLS, askUserSpec, requestAccessSpec } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { CHARS_PER_TOKEN } from "./context.js";

/** The tools every chat of these tests treats as its core (tool search), in no particular order. */
const CORE = ["read_file", "write_file", "edit_file", "list_files", "search", "run_command"];

/** What a chat's first request looked like: the system turn, the tools, and the first user message. */
async function firstRequest(opts: { text: string; persona: string; folder: string; notes: string[]; route?: string[]; stable?: boolean }) {
  const workspace = await mkdtemp(join(tmpdir(), "kesher-prefix-"));
  const seen: Array<Parameters<ModelTurn>[0]> = [];
  const model: ModelTurn = async (req, _signal, onText) => {
    seen.push(structuredClone(req));
    onText("ok");
    return { text: "ok", toolCalls: [] };
  };
  const systemPrompt = await buildSystemPrompt({ productName: "KesherAI", outputsFolder: opts.folder, toolNotes: opts.notes, persona: opts.persona });
  const session = new AgentSession({
    id: "p", modelId: "m", model, mode: "auto", workspace, tools: [...CODE_TOOLS], systemPrompt,
    toolSearch: () => CORE,
    ...(opts.stable === false ? {} : { stablePrefix: () => true }),
    ...(opts.route ? { route: async () => ({ tools: opts.route! }) } : {}),
  });
  session.send(opts.text);
  await new Promise<void>((resolve) => {
    const on = (e: { type: string }) => {
      if (e.type === "assistant") {
        session.off("event", on);
        resolve();
      }
    };
    session.on("event", on);
  });
  return seen[0]!;
}

/** The leading part of a request that must be the same in every chat: the system turn and the always-sent tools. */
function stablePart(req: Parameters<ModelTurn>[0]): string {
  const system = req.messages[0]!.content;
  const names = new Set(CORE);
  const stable = req.tools.filter((t) => t.name === askUserSpec.name || t.name === requestAccessSpec.name || names.has(t.name));
  return `${system}\n${JSON.stringify(stable)}`;
}

const a = { text: "What is the weather in Haifa tomorrow?", persona: "Be brief.", folder: "/data/chats/a/outputs", notes: ["memory: likes tea", "date: 2026-11-28"] };
const b = { text: "כתוב לי סיפור קצר", persona: "Answer like a pirate.", folder: "/data/chats/b/outputs", notes: ["web: only example.org"], route: ["web_search", "write_file"] };

test("two different chats send the same start of the request (system turn, then the always-sent tools)", async () => {
  const [ra, rb] = [await firstRequest(a), await firstRequest({ ...b, route: ["list_files"] })];
  assert.equal(ra.messages[0]!.role, "system");
  assert.equal(stablePart(ra), stablePart(rb));
  // The chat's own part did not vanish: it rides in front of its first user message.
  assert.match(ra.messages[1]!.content, /\/data\/chats\/a\/outputs[\s\S]*likes tea[\s\S]*Be brief\.[\s\S]*What is the weather/);
  assert.match(rb.messages[1]!.content, /\/data\/chats\/b\/outputs[\s\S]*pirate[\s\S]*כתוב לי סיפור קצר/);
  assert.ok(!ra.messages[0]!.content.includes("/data/chats/a"));
  assert.ok(!ra.messages[0]!.content.includes("likes tea"));
});

test("the always-sent tools come before what a message loads, so loading a tool only changes the end", async () => {
  const plain = await firstRequest(a);
  const loaded = await firstRequest({ ...b, route: ["read_document"] });
  const nameList = (r: typeof plain) => r.tools.map((t) => t.name);
  const lead = nameList(plain).filter((n) => n === "ask_user" || n === "request_access" || CORE.includes(n));
  assert.deepEqual(nameList(loaded).slice(0, lead.length), lead);
});

test("without stablePrefix the system turn keeps the chat's part (cloud models)", async () => {
  const r = await firstRequest({ ...a, stable: false });
  assert.match(r.messages[0]!.content, /likes tea/);
});

/**
 * Budget for the prefix every chat pays (system prompt plus the always-sent tool specs), in tokens at the app's own
 * estimate. If this fails, something grew the fixed prompt or a core tool's description: shorten it, or move it to a
 * tool loaded on demand. Raise the limit only on purpose (it is the first thing a new chat reads before its cache is warm).
 */
const PREFIX_BUDGET_TOKENS = 3_300;

test("the stable prefix (fixed system prompt plus the always-sent tools) stays under its token budget", async () => {
  const fixed = await buildSystemPrompt({ productName: "KesherAI" });
  const specs = [askUserSpec, requestAccessSpec, ...CODE_TOOLS.filter((t) => CORE.includes(t.spec.name)).map((t) => t.spec)];
  const tokens = Math.ceil((fixed.length + JSON.stringify(specs).length) / CHARS_PER_TOKEN);
  console.log(`stable prefix: ${tokens} tokens (fixed prompt ${Math.ceil(fixed.length / CHARS_PER_TOKEN)}, ${specs.length} tool specs ${Math.ceil(JSON.stringify(specs).length / CHARS_PER_TOKEN)})`);
  assert.ok(tokens <= PREFIX_BUDGET_TOKENS, `the stable prefix is ${tokens} tokens, over the budget of ${PREFIX_BUDGET_TOKENS}`);
});
