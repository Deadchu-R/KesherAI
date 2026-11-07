#!/usr/bin/env node
// KesherAI MCP bridge: lets apps that only start MCP servers as programs
// (stdio, like Claude Desktop) talk to KesherAI's MCP server at /mcp.
// It reads one JSON-RPC message per line on stdin and writes the answers
// on stdout. KesherAI must be running.
//
// Usage: node mcp-bridge.cjs [http://127.0.0.1:7420/mcp]
// (The desktop app runs it as: KesherAI.exe with ELECTRON_RUN_AS_NODE=1.)
"use strict";
const url = process.argv[2] || process.env.KESHER_MCP_URL || "http://127.0.0.1:7420/mcp";
const token = process.env.KESHER_TOKEN;
let buffer = "";
let pending = 0;
let ended = false;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  pending++;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(msg),
    });
    if (res.status === 202 || msg.id === undefined) return;
    const text = await res.text();
    try {
      send(JSON.parse(text));
    } catch {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `KesherAI answered ${res.status}: ${text.slice(0, 200)}` } });
    }
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `KesherAI is not running (${url}). Open KesherAI and try again. ${e && e.message ? e.message : ""}` } });
  } finally {
    pending--;
    if (ended && !pending) process.exit(0);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) void handle(line);
  }
});
process.stdin.on("end", () => {
  ended = true;
  if (!pending) process.exit(0);
});
