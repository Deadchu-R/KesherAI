import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ToolCall } from "@kesher/shared";
import { AgentSession, proposedCommand, type ModelTurn } from "./session.js";
import { CODE_TOOLS } from "./tools.js";
import { MIN_READ_LINES, ReadMemo, fileOutline } from "./read-memo.js";

/** A fake model that plays back scripted turns. */
function scripted(turns: Array<{ text?: string; calls?: Array<Omit<ToolCall, "id">> }>): ModelTurn {
  let i = 0;
  return async (_req, _signal, onText) => {
    const t = turns[i++] ?? { text: "done" };
    if (t.text) onText(t.text);
    return { text: t.text ?? "", toolCalls: (t.calls ?? []).map((c, n) => ({ ...c, id: `c${i}_${n}` })) };
  };
}

/** A big TypeScript file: 500 lines with a function every 50. */
const BIG = Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? `export function f${i}() {` : i % 50 === 49 ? "}" : `  const x${i} = ${i};`)).join("\n");

async function run(turns: Parameters<typeof scripted>[0], setup?: (s: AgentSession, ws: string) => Promise<void>): Promise<{ session: AgentSession; ws: string }> {
  const ws = await mkdtemp(join(tmpdir(), "kesher-memo-"));
  const session = new AgentSession({ id: "s", modelId: "m", model: scripted(turns), mode: "auto", workspace: ws, tools: [...CODE_TOOLS], systemPrompt: "sys", contextTokens: 100_000 });
  await setup?.(session, ws);
  await new Promise<void>((resolve) => {
    const on = (e: AgentEvent) => {
      if (e.type === "status" && e.status === "idle") {
        session.off("event", on);
        resolve();
      }
    };
    session.on("event", on);
    session.send("go");
  });
  return { session, ws };
}

const results = (s: AgentSession) => s.events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");

test("fileOutline lists a big file's symbols with their lines", () => {
  const o = fileOutline(BIG, "big.ts");
  assert.match(o, /Outline of big\.ts \(500 lines/);
  assert.match(o, /L1 f0\(\)/);
  assert.match(o, /L451 f450\(\)/);
  assert.equal(fileOutline("just text", "a.txt"), "");
});

test("ReadMemo: a repeat of the same range of an unchanged file gets a note; a changed file or a hidden result does not", async () => {
  const m = new ReadMemo();
  const k = ReadMemo.key("/w/a.ts", { offset: 30, limit: 50 });
  const file = { size: 10, mtimeMs: 1 };
  m.record(k, file, "c1", m.tick());
  const note = await m.repeat(k, file, () => true, "a.ts", async () => "");
  assert.match(note ?? "", /already read exactly this part of a\.ts at step 1/);
  assert.match(note ?? "", /tool_output with id "c1"/);
  assert.equal(await m.repeat(k, { size: 11, mtimeMs: 2 }, () => true, "a.ts", async () => ""), undefined);
  assert.equal(await m.repeat(k, file, () => false, "a.ts", async () => ""), undefined);
  assert.equal(await m.repeat(ReadMemo.key("/w/a.ts", { offset: 117 }), file, () => true, "a.ts", async () => ""), undefined);
});

test("read_file: the first read of a big file starts with its outline, and a tiny window grows to the minimum", async () => {
  const ws = await mkdtemp(join(tmpdir(), "kesher-memo-"));
  await writeFile(join(ws, "big.ts"), BIG);
  const tool = CODE_TOOLS.find((t) => t.spec.name === "read_file")!;
  const ctx = { workspace: ws, signal: new AbortController().signal, recordChange: () => undefined };
  const first = await tool.run({ path: "big.ts" }, ctx);
  assert.match(first.output, /^Outline of big\.ts/);
  assert.match(first.output, /\n {4}1 {2}export function f0/);
  const small = await tool.run({ path: "big.ts", offset: 30, limit: 10 }, ctx);
  assert.doesNotMatch(small.output, /Outline/);
  assert.equal(small.output.split("\n").filter((l) => /^\s*\d+ {2}/.test(l)).length, MIN_READ_LINES);
});

test("a session answers a repeated identical read with a note, and reads again after the file changed", async () => {
  const read = { name: "read_file", arguments: { path: "big.ts", offset: 1, limit: 100 } };
  const { session } = await run(
    [{ calls: [read] }, { calls: [read] }, { calls: [{ name: "edit_file", arguments: { path: "big.ts", old_text: "const x1 = 1;", new_text: "const x1 = 2;" } }] }, { calls: [read] }, { text: "done" }],
    async (_s, ws) => writeFile(join(ws, "big.ts"), BIG),
  );
  const r = results(session);
  assert.match(r[0]!.output, /^\s+1 {2}export function f0/m);
  assert.match(r[1]!.output, /^\[KesherAI\] Not read again/);
  assert.match(r[1]!.output, /Outline of big\.ts/);
  assert.match(r[3]!.output, /const x1 = 2;/, "a changed file is read again in full");
});

test("the write guard refuses a write outside the allowed paths at once, naming what may change", async () => {
  const { session } = await run([{ calls: [{ name: "write_file", arguments: { path: "integrations/x/A.cpp", content: "x\n" } }, { name: "write_file", arguments: { path: "docs/ok.md", content: "y\n" } }] }, { text: "done" }], async (s) =>
    s.setWriteGuard((p) => (p.startsWith("docs/") ? undefined : `Refused: only docs/**, not ${p || "outside"}`)),
  );
  const r = results(session);
  assert.equal(r[0]!.ok, false);
  assert.match(r[0]!.output, /Refused: only docs\/\*\*, not integrations\/x\/A\.cpp/);
  assert.equal(r[1]!.ok, true);
});

test("proposedCommand finds a check the model said it would run but did not", () => {
  assert.equal(proposedCommand("Now I'll run the checks:\n```\npnpm -s typecheck && pnpm -s lint\n```"), "pnpm -s typecheck && pnpm -s lint");
  assert.equal(proposedCommand("Let me verify with `pnpm -s test`."), "pnpm -s test");
  assert.equal(proposedCommand("Done. I ran `pnpm -s typecheck` and it passed."), undefined);
  assert.equal(proposedCommand("You can run `pnpm test` later."), undefined);
});

test("an unattended model that only wrote a command is told it did not run", async () => {
  const { session } = await run([{ text: "Next I will run `pnpm -s typecheck` to check." }, { text: "ok, finished" }]);
  assert.ok(session.events.some((e) => e.type === "note" && /only written, not run/.test(e.text)));
});
