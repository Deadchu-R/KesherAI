import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSegments, cutArgs, probeText, sceneArgs, sceneTimes, soundArgs, srtOf } from "./video-cut.js";

test("the stretches to keep are checked and rounded", () => {
  assert.deepEqual(checkSegments([{ from: 0, to: 2.00049 }, { from: 5, to: 9 }]), [{ from: 0, to: 2 }, { from: 5, to: 9 }]);
  assert.throws(() => checkSegments([]), /1 to/);
  assert.throws(() => checkSegments([{ from: 3, to: 3.05 }]), /0.1 s/);
  assert.throws(() => checkSegments([{ from: -1, to: 2 }]), /start and an end/);
  assert.throws(() => checkSegments([{ from: "0; rm", to: 2 }]), /start and an end/);
});

test("FFmpeg keeps the stretches in order and joins them, with or without sound", () => {
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 1, to: 2 }, { from: 4, to: 5.5 }], true);
  const g = a[a.indexOf("-filter_complex") + 1]!;
  assert.match(g, /\[0:v\]trim=start=1:end=2,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(g, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/);
  assert.equal(a.at(-1), "out.mp4");
  const b = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 1 }], false);
  assert.ok(!b.join(" ").includes("[0:a]"));
  assert.ok(!b.includes("aac"));
});

test("captions become an SRT file; bad lines are left out", () => {
  assert.equal(srtOf([{ start: 0.5, end: 2, text: "שלום" }, { start: 3, end: 2, text: "x" }, { start: 61.25, end: 3725.5, text: "a --> b" }]), "1\n00:00:00,500 --> 00:00:02,000\nשלום\n\n2\n00:01:01,250 --> 01:02:05,500\na → b\n");
  assert.equal(srtOf([]), undefined);
  assert.equal(srtOf("x"), undefined);
});

test("a new sound from the sound editor replaces the video's, cut at the same times", () => {
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 1, to: 2 }], false, "new.wav");
  assert.deepEqual(a.slice(4, 8), ["-i", "in.mp4", "-i", "new.wav"]);
  assert.match(a[a.indexOf("-filter_complex") + 1]!, /\[1:a\]atrim=start=1:end=2/);
  assert.ok(a.includes("aac"));
  assert.deepEqual(soundArgs("v.mp4", "s.wav").slice(-8), ["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "s.wav"]);
});

test("shot changes: FFmpeg's scene score, and the times read from showinfo (too close or at the start are skipped)", () => {
  assert.ok(sceneArgs("in.mp4", 0.3).includes("select='gt(scene,0.30)',showinfo"));
  const log = "[Parsed_showinfo_1] n:0 pts:12 pts_time:0.1 \n[Parsed_showinfo_1] n:1 pts:300 pts_time:4.5 \n n:2 pts_time:4.8 \n n:3 pts_time:12.25 ";
  assert.deepEqual(sceneTimes(log), [4.5, 12.25]);
});

test("burned captions: the subtitles filter on the joined picture, only from a plainly named .srt", () => {
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 1 }], true, undefined, ".kesher-burn-1.srt");
  assert.ok(a.join(" ").includes("[v]subtitles=filename=.kesher-burn-1.srt:"));
  assert.equal(a[a.indexOf("-map") + 1], "[vs]");
  assert.throws(() => cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 1 }], true, undefined, "C:\\x\\a b.srt"), /plain/);
});

test("a new shape: the middle of the picture at that ratio, before the captions; unknown shapes are refused", () => {
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 1 }], true, undefined, ".kesher-burn-1.srt", "9:16").join(" ");
  assert.ok(a.includes("[v]crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'"));
  assert.ok(a.includes("[vc]subtitles="));
  assert.throws(() => cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 1 }], true, undefined, undefined, "3:2;drawtext"), /Unknown shape/);
});

test("a music track: from where it starts, faded, ducked under the voice (side-chain), or alone on a silent video", async () => {
  const { cutArgs, musicGraph } = await import("./video-cut.js");
  const m = { file: "song.mp3", start: 2, volume: 0.6, fadeIn: 1, fadeOut: 2, duck: true };
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 10 }], true, undefined, undefined, undefined, m);
  const g = a[a.indexOf("-filter_complex") + 1]!;
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "-i"), ["in.mp4", "song.mp3"]);
  assert.match(g, /\[1:a\]atrim=0:8\.000,asetpts=PTS-STARTPTS,volume=0\.600,afade=t=in:d=1\.000,afade=t=out:st=6\.000:d=2\.000,adelay=2000\|2000/);
  assert.match(g, /sidechaincompress/);
  assert.equal(a[a.lastIndexOf("-map") + 1], "[am]");
  assert.doesNotMatch(musicGraph({ ...m, duck: false }, 1, 10, "[a]").graph, /sidechain/);
  assert.equal(musicGraph(m, 1, 10).out, "[mu]");
  // Odd numbers are kept in range (the page sends them).
  assert.match(musicGraph({ ...m, volume: 99, start: -5, fadeIn: 1e9 }, 1, 10).graph, /volume=1\.500,afade=t=in:d=5\.000/);
});

test("added clips: other videos and pictures are fitted into the opened video's frame, with silence where needed", () => {
  const args = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 2 }, { from: 1, to: 3, src: 1 }, { from: 0, to: 4, src: 2 }], true, undefined, undefined, undefined, undefined, {
    clips: [{ file: "b.mp4", kind: "video", audio: false }, { file: "p.png", kind: "image", audio: false }],
    frame: { w: 1280, h: 720, fps: 30 },
  });
  const g = args[args.indexOf("-filter_complex") + 1]!;
  assert.ok(args.join(" ").includes("-i b.mp4 -loop 1 -framerate 30 -t 4.000 -i p.png"));
  assert.match(g, /\[1:v\]trim=start=1:end=3,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720/);
  assert.match(g, /\[2:v\]trim=start=0:end=4/);
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=duration=2\.000\[a1\]/);
  assert.match(g, /\[0:a\]atrim=start=0:end=2,asetpts=PTS-STARTPTS,aformat=sample_rates=48000/);
  assert.match(g, /concat=n=3:v=1:a=1/);
});

test("segments may name an added clip only when it was sent", () => {
  assert.deepEqual(checkSegments([{ from: 0, to: 1, src: 1 }], 1), [{ from: 0, to: 1, src: 1 }]);
  assert.throws(() => checkSegments([{ from: 0, to: 1, src: 2 }], 1));
  assert.throws(() => checkSegments([{ from: 0, to: 1, src: 1 }]));
});

test("probeText reads FFmpeg's report", () => {
  const t = "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1919x1080 [SAR 1:1 DAR 16:9], 4000 kb/s, 29.97 fps, 30 tbr\n  Stream #0:1: Audio: aac, 48000 Hz, stereo";
  assert.deepEqual(probeText(t), { w: 1920, h: 1080, fps: 30, audio: true });
  assert.equal(probeText("Stream #0:0: Video: png, rgba, 640x480").audio, false);
});

test("a dip to black between clips: fades in after the first and out before the last, never longer than a third", () => {
  const g = (a: string[]) => a[a.indexOf("-filter_complex") + 1]!;
  const x = g(cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 3 }, { from: 5, to: 5.6 }], true, undefined, undefined, undefined, undefined, undefined, 0.5));
  assert.match(x, /\[v0\]/);
  assert.match(x, /setpts=PTS-STARTPTS,fade=t=out:st=2\.500:d=0\.500\[v0\]/);
  assert.match(x, /fade=t=in:st=0:d=0\.200\[v1\]/);
  assert.match(x, /afade=t=out:st=2\.500:d=0\.500\[a0\]/);
  assert.doesNotMatch(g(cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 3 }], true, undefined, undefined, undefined, undefined, undefined, 0.5)), /fade=/);
});

test("text over the picture: each PNG is a still input laid over the frame while it shows, before the new shape", () => {
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 4 }], true, undefined, undefined, "9:16", undefined, undefined, 0, [{ file: "t1.png", start: 0.5, end: 2 }, { file: "t2.png", start: 2, end: 4 }]);
  const g = a[a.indexOf("-filter_complex") + 1]!;
  assert.ok(a.join(" ").includes("-loop 1 -t 4.000 -i t1.png -loop 1 -t 4.000 -i t2.png"));
  assert.match(g, /concat=n=1:v=1:a=1\[vj\]\[a\];\[vj\]\[1:v\]overlay=0:0:enable='between\(t,0\.500,2\.000\)'\[t0\];\[t0\]\[2:v\]overlay=0:0:enable='between\(t,2\.000,4\.000\)'\[v\];\[v\]crop=/);
});
