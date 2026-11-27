import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@kesher/shared";
import { ChatChecks, type ChatCheckHost } from "./runner.js";

type NewEvent = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "seq" | "at"> : never) : never;

/** A fake KesherAI: each chat "answers" with scripted events, and every call to the host is recorded. */
function fakeHost(root: string) {
  const log: string[] = [];
  const listeners = new Map<string, (e: AgentEvent) => void>();
  const seqs = new Map<string, number>();
  let chats = 0;
  const emit = (id: string, e: NewEvent) => {
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    listeners.get(id)?.({ ...e, seq, at: new Date().toISOString() } as AgentEvent);
  };
  const end = (id: string) => emit(id, { type: "status", status: "idle" });
  const host: ChatCheckHost = {
    defaultModel: () => "local-qwen",
    async createChat(o) {
      const id = `chat${++chats}`;
      const folder = join(root, id);
      await mkdir(folder, { recursive: true });
      log.push(`create ${id} ${o.model} ${o.incognito ? "incognito" : "normal"}`);
      return { id, folder };
    },
    hasTool: async (_id, tool, option) => tool === "run_command" && option !== "background",
    async watch(id, on) {
      listeners.set(id, on);
      return () => listeners.delete(id);
    },
    async send(id, text) {
      emit(id, { type: "user", text });
      emit(id, { type: "status", status: "running" });
      if (text.startsWith("What's 17*23")) {
        emit(id, { type: "assistant", turn: 1, text: "391" });
        return end(id);
      }
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      if (url?.endsWith("/article")) {
        emit(id, { type: "approval_request", requestId: "r-real", callId: "c0", name: "browser_open", input: { url: "https://example.com/" }, preview: "", reason: "" });
        emit(id, { type: "approval_request", requestId: "r-fix", callId: "c1", name: "browser_open", input: { url }, preview: "", reason: "" });
        emit(id, { type: "tool_call", callId: "c1", name: "browser_open", input: { url } });
        emit(id, { type: "assistant", turn: 1, text: "The last keeper was Ada Marlow." });
        return end(id);
      }
      if (text === "Rewrite the whole project.") {
        emit(id, { type: "question", questionId: "q1", question: "Which parts?" });
        return; // the runner stops the turn
      }
      if (text.includes("lighthouse") || text.includes("never ends")) return; // hangs: the time limit ends it
      emit(id, { type: "assistant", turn: 1, text: "Hmm." });
      return end(id);
    },
    approve: (id, requestId, decision, feedback) => void log.push(`approve ${id} ${requestId} ${decision}${feedback ? " (why)" : ""}`),
    answer: (id, q, text) => void log.push(`answer ${id} ${q} ${text}`),
    stop(id) {
      log.push(`stop ${id}`);
      end(id);
    },
    async deleteChat(id) {
      log.push(`delete ${id}`);
    },
    async seedChat() {
      log.push("seed");
      return "seeded1";
    },
  };
  return { host, log };
}

/** Waits until the run is no longer going. */
async function finished(c: ChatChecks): Promise<void> {
  for (let i = 0; i < 200 && c.running(); i++) await new Promise((r) => setTimeout(r, 20));
}

test("a run judges each scenario, answers approvals only for fixtures, skips missing tools and cleans up", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-cc-run-"));
  try {
    const { host, log } = fakeHost(root);
    const file = join(root, "chat-checks.json");
    const checks = new ChatChecks(host, file);
    const job = await checks.start({ ids: ["plain-math", "browser-open", "ask-first", "background-build", "hebrew-reply"] });
    await assert.rejects(checks.start(), /already running/);
    await finished(checks);
    const run = (await checks.get(job))!;
    assert.equal(run.state, "done");
    assert.equal(run.model, "local-qwen");
    const by = Object.fromEntries(run.results.map((r) => [r.id, r]));
    assert.equal(by["plain-math"]!.state, "pass");
    assert.equal(by["browser-open"]!.state, "pass");
    assert.equal(by["ask-first"]!.state, "pass");
    assert.equal(by["background-build"]!.state, "skip");
    assert.match(by["background-build"]!.reason!, /no background option/);
    assert.equal(by["hebrew-reply"]!.state, "fail");
    assert.equal(by["hebrew-reply"]!.check, "reply-language");
    assert.ok(run.results.every((r) => typeof r.ms === "number"));
    // The real site was denied with a reason, the fixture page allowed; never "always".
    assert.ok(log.some((l) => /approve chat1 r-real deny \(why\)/.test(l)));
    assert.ok(log.some((l) => /approve chat1 r-fix allow$/.test(l)));
    assert.ok(!log.some((l) => / always/.test(l)));
    assert.ok(log.includes("stop chat2"));
    // Every chat is incognito and deleted.
    assert.equal(log.filter((l) => l.startsWith("create")).length, 5);
    assert.ok(log.filter((l) => l.startsWith("create")).every((l) => l.endsWith("incognito")));
    for (let i = 1; i <= 5; i++) assert.ok(log.includes(`delete chat${i}`), `chat${i} deleted`);
    // Saved, and read back by a new runner.
    const saved = JSON.parse(await readFile(file, "utf8")) as { runs: Array<{ id: string }> };
    assert.equal(saved.runs[0]!.id, job);
    assert.equal((await new ChatChecks(host, file).list())[0]!.id, job);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the past-chat scenario runs in a normal chat with a seeded chat, both deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-cc-run-"));
  try {
    const { host, log } = fakeHost(root);
    const checks = new ChatChecks(host);
    const job = await checks.start({ ids: ["past-chat"], model: "cloud-x" });
    await finished(checks);
    const run = (await checks.get(job))!;
    assert.equal(run.model, "cloud-x");
    assert.equal(run.results[0]!.state, "fail");
    assert.equal(run.results[0]!.check, "looks-before-answering");
    assert.ok(log.includes("create chat1 cloud-x normal"));
    assert.ok(log.includes("seed"));
    assert.ok(log.includes("delete seeded1") && log.includes("delete chat1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no model: the run is refused; unknown ids are refused; only 10 runs are kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-cc-run-"));
  try {
    const { host } = fakeHost(root);
    await assert.rejects(new ChatChecks({ ...host, defaultModel: () => undefined }).start({ ids: ["plain-math"] }), /chat model/);
    const checks = new ChatChecks(host);
    await assert.rejects(checks.start({ ids: ["nope"] }), /Unknown chat check/);
    for (let i = 0; i < 12; i++) {
      await checks.start({ ids: ["plain-math"] });
      await finished(checks);
    }
    assert.equal((await checks.list()).length, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
