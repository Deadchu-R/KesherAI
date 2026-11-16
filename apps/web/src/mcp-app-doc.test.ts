import assert from "node:assert/strict";
import { test } from "node:test";
import { appDocument } from "./mcp-app-doc.js";

test("a tool's view gets a strict policy first in its head, with only the domains its server named", () => {
  const out = appDocument("<html><head><title>x</title></head><body>hi</body></html>", { connect: ["https://api.example.com"], resource: ["https://cdn.example.com"] });
  assert.match(out, /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' https:\/\/cdn\.example\.com;/);
  assert.match(out, /connect-src 'self' https:\/\/api\.example\.com/);
  assert.match(out, /form-action 'none'; base-uri 'none'/);
  // A fragment without a head is wrapped.
  assert.match(appDocument("<div>x</div>", { connect: [], resource: [] }), /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
});
