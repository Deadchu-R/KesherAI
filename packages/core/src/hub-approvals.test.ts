import { test } from "node:test";
import assert from "node:assert/strict";
import { allowsForWhile, answerFromHub, isDangerousReason, withTimedRule, type WaitingRequest } from "./hub-approvals.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");

test("Allow for a while keeps one rule for the chat's tool, replacing the same rule and dropping ended ones", () => {
  const old = [
    { tool: "run_command", scope: "conversation" as const, conversationId: "c1" },
    { tool: "write_file", scope: "everywhere" as const, until: "2026-11-20T11:00:00Z" },
    { tool: "edit_file", scope: "everywhere" as const },
  ];
  const rules = withTimedRule(old, { tool: "run_command", conversationId: "c1", minutes: 60, now: NOW });
  assert.deepEqual(rules.map((r) => r.tool), ["edit_file", "run_command"]);
  assert.equal(rules.at(-1)!.until, "2026-11-20T13:00:00.000Z");
  assert.equal(rules.at(-1)!.conversationId, "c1");
});

test("no 'for a while' for a dangerous command or a site-scoped tool; a sub-agent's may", () => {
  assert.ok(isDangerousReason("This command deletes files, so it always needs your approval."));
  assert.equal(allowsForWhile({ name: "run_command", reason: "This command deletes files, so it always needs your approval." }), false);
  assert.equal(allowsForWhile({ name: "browser_click", reason: "Clicks", scope: "site:example.com" }), false);
  assert.equal(allowsForWhile({ name: "run_command", reason: "Runs a command", helper: { title: "Tests" } }), true);
});

/** A chat with one waiting request; records the answer and the saved rules. */
function rig(request: WaitingRequest) {
  const cfg = { permissions: [] as Array<{ tool: string; scope: "conversation" | "model" | "everywhere"; conversationId?: string; until?: string }> };
  const answers: string[] = [];
  let saved = 0;
  const deps = {
    find: async (c: string, r: string) => (c === "c1" && r === "r1" ? { request, approve: (d: "allow" | "always" | "deny") => (answers.push(d), true) } : undefined),
    config: () => cfg,
    saveConfig: async () => void saved++,
    now: () => NOW,
  };
  return { deps, cfg, answers, saved: () => saved };
}

test("answers from the hub: once, deny, for a while (a sub-agent's rule is helper:<tool>), never widened", async () => {
  const chat = rig({ name: "run_command", reason: "Runs a command" });
  assert.equal(await answerFromHub(chat.deps, "c1", "r1", "allow"), true);
  assert.equal(await answerFromHub(chat.deps, "c1", "r1", "deny"), true);
  assert.equal(await answerFromHub(chat.deps, "c1", "r1", "allow", 15), true);
  assert.deepEqual(chat.answers, ["allow", "deny", "allow"]);
  assert.equal(chat.cfg.permissions[0]!.tool, "run_command");
  assert.equal(chat.saved(), 1);
  // Deny with minutes is just a deny; an unknown request answers nothing.
  assert.equal(await answerFromHub(chat.deps, "c1", "r1", "deny", 60), true);
  assert.equal(chat.answers.at(-1), "deny");
  assert.equal(await answerFromHub(chat.deps, "c1", "gone", "allow"), false);

  const helper = rig({ name: "run_command", reason: "Runs a command", helper: { id: "h1", title: "Tests", kind: "build" } });
  await answerFromHub(helper.deps, "c1", "r1", "allow", 60);
  assert.equal(helper.cfg.permissions[0]!.tool, "helper:run_command");

  const danger = rig({ name: "run_command", reason: "This command deletes files, so it always needs your approval." });
  await answerFromHub(danger.deps, "c1", "r1", "allow", 60);
  assert.deepEqual(danger.answers, ["allow"], "answered once, no rule");
  assert.equal(danger.cfg.permissions.length, 0);
});
