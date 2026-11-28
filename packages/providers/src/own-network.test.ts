import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnNetworkUrl, OpenAICompatibleProvider } from "./openai-compatible.js";

test("isOwnNetworkUrl: the user's own machines vs the internet (a saved 'server' Gemini is relabeled cloud)", () => {
  for (const u of ["http://localhost:1234/v1", "http://127.0.0.1:8081/v1", "http://192.168.1.20:11434", "http://10.0.0.5:8000/v1", "http://172.20.1.1/v1", "http://100.101.102.103:7420", "http://my-pc.local:1234", "http://pc.tail1234.ts.net", "http://[::1]:5000", "http://desktop:5000"]) assert.equal(isOwnNetworkUrl(u), true, u);
  for (const u of ["https://generativelanguage.googleapis.com/v1beta/openai", "https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://8.8.8.8", "not a url"]) assert.equal(isOwnNetworkUrl(u), false, u);
});

test("an openai-compatible provider with no saved location is the cloud on the internet, a server on the user's network", () => {
  assert.equal(new OpenAICompatibleProvider({ id: "g", type: "openai-compatible", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }).location, "cloud");
  assert.equal(new OpenAICompatibleProvider({ id: "l", type: "openai-compatible", name: "L", baseUrl: "http://localhost:1234/v1" }).location, "server");
});

test("isOwnNetworkUrl: tricks that make a cloud address look local stay cloud", () => {
  for (const u of ["http://127.0.0.1.evil.com/v1", "http://localhost.evil.com", "http://127.0.0.1@evil.com/v1", "http://evil.com#@127.0.0.1", "http://[::ffff:8.8.8.8]/v1", "http://2.2.2.2", "http://100.128.0.1", "http://172.32.0.1", "http://192.169.1.1", "https://evil.com/.local", "http://localhost./v1"]) assert.equal(isOwnNetworkUrl(u), false, u);
  // The URL parser reads decimal, hex and short spellings as the real address; an IPv4-mapped IPv6 address is not matched (cloud: the safe side).
  for (const u of ["http://2130706433/v1", "http://0x7f000001/v1", "http://127.1/v1"]) assert.equal(isOwnNetworkUrl(u), true, u);
  assert.equal(isOwnNetworkUrl("http://[::ffff:127.0.0.1]/v1"), false);
});
