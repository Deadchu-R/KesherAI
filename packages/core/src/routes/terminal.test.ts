import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CLIS, agentEnv } from "./terminal.js";

test("the terminal starts only commands it knows by name; Claude Code points at KesherAI itself", () => {
  assert.equal(AGENT_CLIS["gemini"], "gemini");
  assert.equal(AGENT_CLIS["rm -rf /"], undefined);
  const env = agentEnv("claude-local", 7420);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7420");
  assert.equal(env.ANTHROPIC_API_KEY, "", "the user's own Anthropic key is not used");
  assert.deepEqual(agentEnv("gemini", 7420), {}, "Gemini CLI keeps its own sign-in");
});
