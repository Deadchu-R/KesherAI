import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createKesherServer } from "./server.js";
import { cleanLog, describeRun } from "./blueprint-test.js";

test("the run's log keeps what the Blueprint did and folds repeats", () => {
  const log = cleanLog([
    { kind: "log", category: "LogRenderer", text: "noise" },
    { kind: "log", category: "LogBlueprintUserMessages", text: "[BP_Door_C_0] Hello" },
    { kind: "log", category: "LogBlueprintUserMessages", text: "[BP_Door_C_0] Hello" },
    { kind: "log", category: "LogBlueprintUserMessages", text: "[BP_Door_C_0] Hello" },
    { kind: "error", category: "LogScript", text: "Accessed None trying to read property Door" },
  ]);
  assert.deepEqual(log.map((l) => l.text), ["[BP_Door_C_0] Hello", "(the line above 2 more times)", "Accessed None trying to read property Door"]);
  const text = describeRun({ played: true, compile: [], log, seconds: 6, placed: "BP_Door_C_0" }, "/Game/BP_Door.BP_Door");
  assert.match(text, /6 s, with BP_Door placed/);
  assert.match(text, /\[error\] LogScript: Accessed None/);
  assert.match(describeRun({ played: false, reason: "compile errors", compile: ["Error: x"], log: [], seconds: 0 }, "/Game/A.A"), /not run: compile errors/);
});

test("Test plays the game in the editor, stops it, and returns the log and the picture", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-uet-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as { port: number }).port;
  const png = join(dataDir, "shot.png");
  await writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const calls: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/unreal/ws`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { id: string; cmd: string; place?: boolean };
    calls.push(m.cmd + (m.cmd === "play" ? `:${String(m.place)}` : ""));
    const result =
      m.cmd === "play" ? { started: true, compile: [] }
      : m.cmd === "play_stop" ? { played: true, picture: png, placed: "BP_Door_C_0", seconds: 1, log: [{ kind: "log", category: "LogBlueprintUserMessages", text: "Opened" }] }
      : { ok: true };
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  });
  try {
    ws.send(JSON.stringify({ event: "hello", project: "DoorGame", engine: "5.8.4", bridge: "0.1.7" }));
    await new Promise((r) => setTimeout(r, 200));
    const old = await server.app.inject({ method: "POST", url: "/api/unreal/test", payload: { path: "/Game/BP_Door.BP_Door", seconds: 1, judge: false } });
    assert.equal(old.statusCode, 502);
    assert.match(old.json().error as string, /plugin 0\.1\.8/);
    ws.send(JSON.stringify({ event: "hello", project: "DoorGame", engine: "5.8.4", bridge: "0.1.8" }));
    await new Promise((r) => setTimeout(r, 200));
    const r = await server.app.inject({ method: "POST", url: "/api/unreal/test", payload: { path: "/Game/BP_Door.BP_Door", seconds: 1, judge: false } });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json() as { played: boolean; pictureId?: string; log: Array<{ text: string }>; summary: string };
    assert.equal(body.played, true);
    assert.ok(body.pictureId);
    assert.equal(body.log[0]?.text, "Opened");
    assert.match(body.summary, /Opened/);
    assert.deepEqual(calls.filter((c) => c.startsWith("play")), ["play:true", "play_stop"]);
  } finally {
    ws.close();
    await server.close();
  }
});
