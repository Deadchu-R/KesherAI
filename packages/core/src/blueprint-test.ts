import { readFile } from "node:fs/promises";
import type { ProviderRegistry } from "@kesher/providers";
import { blueprintToCode, codeText, type CodeNode } from "@kesher/shared";
import { modelTurnFor } from "./model-turn.js";
import type { UnrealBridge } from "./unreal-bridge.js";

/** One line the game wrote while it ran. */
export interface TestLine {
  kind: "log" | "warning" | "error";
  category: string;
  text: string;
}

/** What a test run of a Blueprint saw. */
export interface TestRun {
  /** False when it did not run (compile errors). */
  played: boolean;
  /** Why it did not run. */
  reason?: string;
  compile: string[];
  log: TestLine[];
  /** The test actor placed in front of the player, when the Blueprint is an Actor. */
  placed?: string;
  /** The game view at the end, as PNG. */
  picture?: Buffer;
  seconds: number;
}

/** The plugin version that has the test commands. */
export const TEST_BRIDGE = "0.1.8";

const newer = (have: string, need: string) => {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Keeps a run's log short and readable: no engine noise, repeats folded. */
export function cleanLog(lines: TestLine[], max = 120): TestLine[] {
  const noise = /^(LogSlate|LogRenderer|LogD3D|LogRHI|LogShaderCompilers|LogDerivedDataCache|LogStreaming|LogTexture|LogAudio|LogEOS|LogOnline|LogNet|LogHttp|LogPlayLevel|LogUObjectHash|LogAssetRegistry|LogContentBrowser|LogEditorViewport|LogTemp)$/;
  const out: TestLine[] = [];
  let last = "";
  let repeat = 0;
  for (const l of lines) {
    // Engine housekeeping (LogHAL, LogWindows…) says nothing about the Blueprint, even as errors.
    if (/^(LogHAL|LogWindows|LogInit|LogPakFile|LogConfig|LogShaderLibrary|LogVirtualization)$/.test(l.category)) continue;
    if (l.kind !== "error" && noise.test(l.category)) continue;
    const key = `${l.kind}|${l.category}|${l.text}`;
    if (key === last) {
      repeat++;
      continue;
    }
    if (repeat) out.push({ kind: "log", category: "", text: `(the line above ${repeat} more times)` });
    repeat = 0;
    last = key;
    out.push({ ...l, text: l.text.replace(/\s+/g, " ").trim().slice(0, 400) });
    if (out.length >= max) break;
  }
  if (repeat) out.push({ kind: "log", category: "", text: `(the line above ${repeat} more times)` });
  return out;
}

/**
 * Runs the game in the open Unreal Editor (Play In Editor) for a few seconds:
 * the Blueprint is compiled, an Actor Blueprint is placed in front of the
 * player in the play world only, and the log and a picture of the game view
 * come back. Play stops by itself at the end (or on any error).
 *
 * @param b - The bridge (the editor must be connected).
 * @param path - The Blueprint's path (empty: just play the level).
 * @param opts.seconds - How long to play (1–60).
 * @param opts.signal - Stops early.
 */
export async function runBlueprintTest(b: UnrealBridge, path: string, opts: { seconds?: number; place?: boolean; signal?: AbortSignal } = {}): Promise<TestRun> {
  if (!b.connected) throw new Error("Open the project in Unreal first: a test runs the game in the editor.");
  const have = (await b.status()).editor?.bridge ?? "";
  if (have && !newer(have, TEST_BRIDGE)) throw new Error(`Testing needs the KesherAI Bridge plugin ${TEST_BRIDGE} (installed ${have}). Press "Update automatically" at the top of the Unreal page.`);
  const seconds = Math.min(60, Math.max(1, Math.round(opts.seconds ?? 6)));
  const start = await b.request<{ started: boolean; reason?: string; compile?: string[] }>("play", { path, place: opts.place !== false }, 120_000);
  if (!start.started) return { played: false, reason: start.reason ?? "It did not start.", compile: start.compile ?? [], log: [], seconds: 0 };
  // Play: Unreal starts the session on its next frame, then the game runs for the asked time (stopping early is fine).
  const until = Date.now() + seconds * 1000 + 1500;
  while (Date.now() < until && !opts.signal?.aborted) await new Promise((r) => setTimeout(r, 500));
  // Always stop playing: a picture of the game view, the log, then Play In Editor ends.
  const stop = await b.request<{ played: boolean; picture?: string; log: TestLine[]; placed?: string; seconds: number }>("play_stop", {}, 60_000);
  // Only the plugin's own picture file (Saved/KesherAI/test-run.png), never another path the socket names.
  const picture = stop.picture && /[\\/]Saved[\\/]KesherAI[\\/]test-run\.png$/i.test(stop.picture) ? await readFile(stop.picture).catch(() => undefined) : undefined;
  return {
    played: stop.played,
    ...(stop.played ? {} : { reason: "The game did not start in the editor (is a dialog open in Unreal?)." }),
    compile: start.compile ?? [],
    log: cleanLog(stop.log ?? []),
    ...(stop.placed ? { placed: stop.placed } : {}),
    ...(picture ? { picture } : {}),
    seconds: Math.round(stop.seconds ?? seconds),
  };
}

/** The run in words, for a model or a chat tool. */
export function describeRun(run: TestRun, path: string, engine: "unreal" | "unity" = "unreal"): string {
  const name = path.split(".").pop() || path || (engine === "unity" ? "the scene" : "the level");
  if (!run.played) return `${name} was not run: ${run.reason ?? ""}${run.compile.length ? `\nCompile messages:\n${run.compile.join("\n")}` : ""}`;
  const log = run.log.map((l) => `${l.kind === "log" ? "" : `[${l.kind}] `}${l.category ? `${l.category}: ` : ""}${l.text}`).join("\n");
  return [
    `Played the game in the ${engine === "unity" ? "Unity Editor (Play Mode)" : "Unreal Editor"} for ${run.seconds} s${run.placed ? `, with ${name} placed in front of the player (${run.placed})` : ""}.`,
    run.compile.length ? `Compile messages:\n${run.compile.join("\n")}` : "Compiled with no messages.",
    log ? `What the game wrote (${engine === "unity" ? "Debug.Log" : "Print String"}, warnings, errors):\n${log}` : `The game wrote nothing (no ${engine === "unity" ? "Debug.Log" : "Print String"}, no warnings or errors).`,
  ].join("\n");
}

/**
 * Has a model say whether the Blueprint did what it should: it gets the
 * Blueprint as code, what the run wrote and (when it can see) the picture.
 *
 * @param goal - What the user expects, if they said (else the model judges from the code).
 */
export async function judgeRun(registry: ProviderRegistry, modelId: string, graph: { name: string; graphs: Array<{ name: string; nodes: unknown[] }> }, path: string, run: TestRun, goal: string, signal: AbortSignal, lang = "en", engine: "unreal" | "unity" = "unreal"): Promise<string> {
  const code = graph.graphs.map((g) => `## ${g.name}\n${codeText(blueprintToCode(g.nodes as CodeNode[]))}`).join("\n").slice(0, 6000);
  const turn = modelTurnFor(registry, modelId);
  const prompt = [
    engine === "unity" ? `You test Unity games. The Visual Scripting graph ${graph.name} is below as code (one line per node, in the order the flow wires run).` : `You test Unreal Blueprints. The Blueprint ${graph.name} is below as code (one line per node, in the order the exec wires run).`,
    code,
    "",
    describeRun(run, path, engine),
    goal ? `\nWhat the user expects: ${goal}` : "",
    run.picture ? "\nThe picture is the game view at the end of the run." : "",
    "",
    `Answer in ${lang === "he" ? "Hebrew" : "English"}, short:`,
    "1. One line: works / does not work / cannot tell, and why.",
    "2. What happened, from the log (and picture).",
    "3. Problems found (Accessed None or NullReferenceException, errors, a Print that never came, an event that never ran) and the likely fix in the graph.",
    "Do not invent what is not in the log or the picture. BeginPlay (Unity: Start/On Start) runs at the start; Tick (Unity: Update) runs every frame; overlap and input events run only when something triggers them, so their silence is not a failure.",
  ].join("\n");
  const r = await turn({ messages: [{ role: "user", content: prompt, ...(run.picture ? { images: [{ mimeType: "image/png", data: run.picture.toString("base64") }] } : {}) }], tools: [] }, AbortSignal.any([signal, AbortSignal.timeout(180_000)]), () => undefined);
  return r.text.trim();
}
