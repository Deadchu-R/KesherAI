import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnNetworkUrl } from "./config.js";

test("isOwnNetworkUrl: the user's own machines vs the internet (a saved 'server' Gemini is relabeled cloud)", () => {
  for (const u of ["http://localhost:1234/v1", "http://127.0.0.1:8081/v1", "http://192.168.1.20:11434", "http://10.0.0.5:8000/v1", "http://172.20.1.1/v1", "http://100.101.102.103:7420", "http://my-pc.local:1234", "http://pc.tail1234.ts.net", "http://[::1]:5000", "http://desktop:5000"]) assert.equal(isOwnNetworkUrl(u), true, u);
  for (const u of ["https://generativelanguage.googleapis.com/v1beta/openai", "https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://8.8.8.8", "not a url"]) assert.equal(isOwnNetworkUrl(u), false, u);
});
