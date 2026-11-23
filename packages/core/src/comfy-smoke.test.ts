import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inflateSync } from "node:zlib";
import { readyFlows } from "./comfy-flows.js";
import { needsFreeCard, runSmoke, smallestSettings, smokeKind, testPicture } from "./comfy-smoke.js";

/** A fake ComfyUI: `/prompt` answers with `prompt`, `/history/<id>` with `history` (undefined = still running). */
async function fake(prompt: { status: number; body: unknown }, history: () => unknown) {
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/prompt") return void req.resume().on("end", () => send(prompt.status, prompt.body));
    if (req.url?.startsWith("/history/")) return send(200, history());
    if (req.url === "/interrupt") return send(200, {});
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

const flow = { "1": { class_type: "SaveAudioMP3", inputs: {} } };

test("smallestSettings: music 5 s, video 5 frames at 256, 3D coarse, 2 steps; the original stays", () => {
  const flows = readyFlows();
  const music = flows.find((f) => f.id === "music-ace-step-15")!;
  const small = smallestSettings(music.flow);
  assert.equal(small["4"]!.inputs.seconds, 5);
  assert.equal(small["2"]!.inputs.duration, 5);
  assert.equal(small["8"]!.inputs.steps, 2);
  assert.equal(music.flow["4"]!.inputs.seconds, 60, "the original is not changed");
  const video = smallestSettings(flows.find((f) => f.id === "video-wan22-ti2v")!.flow)["7"]!.inputs;
  assert.deepEqual([video.length, video.width, video.height], [5, 256, 256]);
  const d3 = smallestSettings(flows.find((f) => f.id === "3d-hunyuan3d")!.flow);
  assert.equal(d3["5"]!.inputs.resolution, 1024);
  assert.equal(d3["8"]!.inputs.octree_resolution, 64);
});

test("smokeKind and needsFreeCard: only video and 3D free the card", () => {
  assert.deepEqual(["music-ace-step-15", "sfx-stable-audio-3-small", "video-wan22-ti2v", "3d-trellis2", "styled-frame"].map(smokeKind), ["music", "music", "video", "3d", "image"]);
  assert.deepEqual(["music", "video", "3d", "image"].map((k) => needsFreeCard(k as "music")), [false, true, true, false]);
});

test("testPicture is a valid grey PNG of the asked size with a plain white corner", () => {
  const png = testPicture(64);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 64);
  const idat = png.indexOf("IDAT");
  const raw = inflateSync(png.subarray(idat + 4, png.indexOf("IEND") - 8));
  assert.equal(raw.length, 65 * 64);
  assert.equal(raw[1], 255, "corner is white");
  assert.ok(raw[65 * 32 + 1 + 32]! < 255, "the ball is grey");
});

test("runSmoke returns the saved files and the seconds when ComfyUI finishes", async () => {
  let polls = 0;
  const srv = await fake({ status: 200, body: { prompt_id: "p1" } }, () => (++polls < 3 ? {} : { p1: { status: { status_str: "success", completed: true }, outputs: { "10": { audio: [{ filename: "a.mp3", subfolder: "audio" }] }, "11": { images: [{ filename: "v.webp" }], animated: [true] } } } }));
  const seen: number[] = [];
  const r = await runSmoke({ url: srv.url, flow, pollMs: 5, onPoll: () => seen.push(1) });
  srv.close();
  assert.equal(r.ok, true);
  assert.deepEqual(r.outputs, [{ kind: "audio", file: "audio/a.mp3" }, { kind: "video", file: "v.webp" }]);
  assert.ok(r.seconds >= 0 && seen.length === 3);
});

test("runSmoke: a node error from /prompt and an execution error from /history come back as the error", async () => {
  const a = await fake({ status: 400, body: { error: { message: "Prompt outputs failed validation" }, node_errors: { "4": { class_type: "KSampler", errors: [{ message: "Value not in list", details: "ckpt_name: 'x'" }] } } } }, () => ({}));
  const r1 = await runSmoke({ url: a.url, flow, pollMs: 5 });
  a.close();
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /KSampler: Value not in list \(ckpt_name/);
  const b = await fake({ status: 200, body: { prompt_id: "p2" } }, () => ({ p2: { status: { status_str: "error", messages: [["execution_error", { node_type: "VAEDecodeAudio", exception_message: "out of memory" }]] } } }));
  const r2 = await runSmoke({ url: b.url, flow, pollMs: 5 });
  b.close();
  assert.deepEqual([r2.ok, r2.error], [false, "VAEDecodeAudio: out of memory"]);
});

test("runSmoke times out, interrupts ComfyUI, and reports a flow that saved nothing", async () => {
  const slow = await fake({ status: 200, body: { prompt_id: "p3" } }, () => ({}));
  const r = await runSmoke({ url: slow.url, flow, pollMs: 5, timeoutMs: 60 });
  slow.close();
  assert.equal(r.ok, false);
  assert.match(r.error!, /Timed out/);
  assert.ok(slow.calls.includes("POST /interrupt"));
  const empty = await fake({ status: 200, body: { prompt_id: "p4" } }, () => ({ p4: { status: { completed: true, status_str: "success" }, outputs: {} } }));
  const r2 = await runSmoke({ url: empty.url, flow, pollMs: 5 });
  empty.close();
  assert.match(r2.error!, /saved nothing/);
  const down = await runSmoke({ url: "http://127.0.0.1:1", flow, pollMs: 5 });
  assert.match(down.error!, /did not answer/);
});
