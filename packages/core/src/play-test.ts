import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { cleanLog, type TestLine } from "./blueprint-test.js";
import { realInside } from "./game-checkpoints.js";

/**
 * Gameplay tests for Unreal ("Test" with input): a short plan of steps (spawn or possess a pawn, press Enhanced Input
 * actions or keys for some frames, wait for a condition, check an actor's property, take a picture) runs in Play In
 * Editor through the KesherAI Bridge plugin, or in a headless editor (Unreal's automation runner) when the editor is
 * closed. Each step's result streams back as it happens. A plan is kept as a re-runnable file in the project
 * (Content/KesherTests/<name>.json), which the plugin also offers to Unreal's Session Frontend as the automation test
 * "KesherAI.PlayTest.<name>".
 *
 * Safety: the run happens only in the play world (PIE, or the test map the plan names, loaded for play only); nothing
 * in the project changes except the test file when it is saved (the chat tool keeps a checkpoint of it first).
 */

/** A value for an input action: a button (true), an axis (0.5), or a 2D/3D axis ([x, y] / [x, y, z]). */
export type PlayValue = boolean | number | number[];

/** How a condition compares an actor's value. */
export type PlayOp = "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "exists" | "near";

/**
 * Something about an actor in the play world.
 *
 * - `actor`: `player` (the possessed pawn), `controller`, an actor's name or label, or `class:BP_Door` (the first of it).
 * - `property`: `location`, `location.z`, `rotation`, `velocity`, `speed`, `hidden`, or any property by name (a dot
 *   path into structs, e.g. `Stats.Health`).
 */
export interface PlayCondition {
  actor: string;
  property: string;
  op: PlayOp;
  value?: string | number | boolean | number[];
  /** For `near` (and number `==`): how close counts, in Unreal units (default 1, `near` 50). */
  tolerance?: number;
}

/** One step of a gameplay test. */
export type PlayStep =
  | { do: "spawn"; class: string; offset?: number[]; possess?: boolean }
  | { do: "possess"; actor: string }
  | { do: "input"; action: string; value?: PlayValue; frames?: number }
  | { do: "key"; key: string; frames?: number }
  | { do: "axis"; key: string; value: number; frames?: number }
  | { do: "wait"; seconds?: number; until?: PlayCondition; timeout?: number }
  | ({ do: "assert"; message?: string } & PlayCondition)
  | { do: "screenshot"; name?: string };

/** A gameplay test: what the plugin runs and what the project keeps. */
export interface PlayTestPlan {
  /** The file name too (letters, digits, - and _). */
  name: string;
  description?: string;
  /** A test map (e.g. /Game/Tests/TestMap); empty: the level open in the editor. Loaded for play only. */
  map?: string;
  steps: PlayStep[];
  /** The whole run's limit in seconds (default 60, at most 300). */
  timeout?: number;
}

/** What one step did. */
export interface PlayStepResult {
  index: number;
  do: PlayStep["do"];
  ok: boolean;
  /** What happened, in words (the value seen for an assert). */
  text: string;
  ms?: number;
  /** A picture the step took (screenshot steps): its file, read only from the plugin's own folder. */
  picture?: string;
}

/** What a gameplay test run saw. */
export interface PlayTestRun {
  /** pie: in the open editor; headless: Unreal closed, its automation runner (no pictures there). */
  mode: "pie" | "headless";
  /** Every step ran and passed. */
  passed: boolean;
  /** Why it stopped early (no start, time out, Stop). */
  reason?: string;
  steps: PlayStepResult[];
  log: TestLine[];
  /** The pictures, in step order (PNG). */
  pictures: Array<{ index: number; name: string; data: Buffer }>;
  seconds: number;
}

/** What the plugin answers while a test runs and at its end. */
interface PluginState {
  running?: boolean;
  done?: boolean;
  passed?: boolean;
  reason?: string;
  steps?: PlayStepResult[];
  log?: TestLine[];
  seconds?: number;
}

/** The plugin version with gameplay tests (play_test, play_test_status, play_test_stop and the automation test). */
export const PLAY_TEST_BRIDGE = "0.1.25";

/** The most steps a plan may have. */
export const MAX_STEPS = 40;

/** What the runner needs of the bridge (the real UnrealBridge, or a fake in tests). */
export interface PlayTestBridge {
  readonly connected: boolean;
  status(): Promise<{ editor?: { bridge?: string } }>;
  request<T = unknown>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Unreal closed: runs the plan in a headless editor (automation runner) and returns its end state. */
  playHeadless?(plan: PlayTestPlan): Promise<unknown>;
  /** Whether a headless run can start (the project and its engine are known). */
  readonly canPlayHeadless?: boolean;
}

const ASSET = /^\/(Game|Script|Engine)\/[\w./-]{1,200}$/;
const KEY = /^[A-Za-z][\w]{0,40}$/;
const OPS: PlayOp[] = ["==", "!=", ">", "<", ">=", "<=", "contains", "exists", "near"];
const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const short = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const vec = (v: unknown, n: number[]) => (Array.isArray(v) && v.length >= 2 && v.length <= 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : n);

const newer = (have: string, need: string) => {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/**
 * A test's name as a file name: letters, digits, - and _, at most 64.
 *
 * @param name - Any name ("Jump over the wall").
 */
export function testSlug(name: string): string {
  return name.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "PlayTest";
}

function condition(raw: Record<string, unknown>, where: string): PlayCondition {
  const actor = short(raw.actor, 120);
  const property = short(raw.property, 120);
  const op = (OPS.includes(raw.op as PlayOp) ? raw.op : "==") as PlayOp;
  if (!actor) throw new Error(`${where}: say which actor (player, an actor's name, or class:BP_Name).`);
  if (!/^[\w.]+$/.test(property)) throw new Error(`${where}: the property must be a name such as location.z, speed or Health.`);
  const v = raw.value;
  const value = typeof v === "string" ? v.slice(0, 200) : typeof v === "number" || typeof v === "boolean" ? v : Array.isArray(v) ? vec(v, []) : undefined;
  if (op !== "exists" && value === undefined) throw new Error(`${where}: "${op}" needs a value.`);
  return { actor, property, op, ...(value !== undefined ? { value } : {}), ...(typeof raw.tolerance === "number" ? { tolerance: num(raw.tolerance, 0, 100_000, 1) } : {}) };
}

/**
 * Checks a plan written by a model or read from a file, and keeps it within safe limits (step count, frames,
 * seconds, asset paths under /Game, /Script or /Engine, plain key names).
 *
 * @param raw - The plan (an object or its JSON).
 * @returns The plan, cleaned.
 * @throws Error naming the first step that is wrong.
 */
export function parsePlan(raw: unknown): PlayTestPlan {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("The test plan must be an object with a name and steps.");
  const list = Array.isArray(o.steps) ? (o.steps as Array<Record<string, unknown>>) : [];
  if (!list.length) throw new Error("The test plan has no steps.");
  if (list.length > MAX_STEPS) throw new Error(`A test has at most ${MAX_STEPS} steps (this one has ${list.length}); split it in two.`);
  const map = short(o.map);
  if (map && !ASSET.test(map)) throw new Error("The test map must be a path such as /Game/Tests/TestMap.");
  const steps = list.map((s, i): PlayStep => {
    const where = `Step ${i + 1}`;
    const frames = num(s?.frames, 1, 600, 10);
    switch (s?.do) {
      case "spawn": {
        const cls = short(s.class);
        if (!ASSET.test(cls)) throw new Error(`${where}: spawn needs a class path such as /Game/BP_Enemy.BP_Enemy_C.`);
        return { do: "spawn", class: cls, offset: vec(s.offset, [400, 0, 0]), possess: s.possess === true };
      }
      case "possess":
        if (!short(s.actor)) throw new Error(`${where}: possess needs an actor.`);
        return { do: "possess", actor: short(s.actor, 120) };
      case "input": {
        const action = short(s.action);
        if (!ASSET.test(action)) throw new Error(`${where}: input needs an Enhanced Input action path such as /Game/Input/IA_Jump.`);
        const v = s.value;
        const value: PlayValue = typeof v === "boolean" ? v : typeof v === "number" ? num(v, -1000, 1000, 1) : Array.isArray(v) ? vec(v, [1, 0]) : true;
        return { do: "input", action, value, frames };
      }
      case "key":
        if (!KEY.test(short(s.key))) throw new Error(`${where}: key needs an Unreal key name such as SpaceBar, W or Gamepad_FaceButton_Bottom.`);
        return { do: "key", key: short(s.key), frames };
      case "axis":
        if (!KEY.test(short(s.key))) throw new Error(`${where}: axis needs an Unreal key name such as Gamepad_LeftX or MouseX.`);
        return { do: "axis", key: short(s.key), value: num(s.value, -1000, 1000, 1), frames };
      case "wait": {
        const until = s.until && typeof s.until === "object" ? condition(s.until as Record<string, unknown>, where) : undefined;
        if (!until && typeof s.seconds !== "number") throw new Error(`${where}: wait needs seconds or an until condition.`);
        return { do: "wait", ...(until ? { until, timeout: num(s.timeout, 0.1, 60, 5) } : { seconds: num(s.seconds, 0, 60, 1) }) };
      }
      case "assert":
        return { do: "assert", ...condition(s, where), ...(s.message ? { message: short(s.message) } : {}) };
      case "screenshot":
        return { do: "screenshot", ...(s.name ? { name: testSlug(String(s.name)) } : {}) };
      default:
        throw new Error(`${where}: unknown "do" (${short(s?.do, 30)}); use spawn, possess, input, key, axis, wait, assert or screenshot.`);
    }
  });
  return { name: testSlug(short(o.name, 80) || "PlayTest"), ...(o.description ? { description: short(o.description, 400) } : {}), ...(map ? { map } : {}), steps, timeout: num(o.timeout, 5, 300, 60) };
}

/**
 * The file a test is kept in: Content/KesherTests/<name>.json in the project.
 *
 * @param projectDir - The project folder (the one with the .uproject).
 * @param name - The test's name.
 */
export function planFile(projectDir: string, name: string): string {
  return join(projectDir, "Content", "KesherTests", `${testSlug(name)}.json`);
}

/**
 * Keeps a test in the project, to run again (from KesherAI, or Unreal's Session Frontend: KesherAI.PlayTest.<name>).
 * The only file a gameplay test ever writes.
 *
 * @param projectDir - The project folder.
 * @param plan - The test (checked again here).
 * @param before - Called with the file before it is written (a checkpoint of the old copy).
 * @returns The file.
 */
export async function savePlan(projectDir: string, plan: PlayTestPlan, before?: (file: string) => Promise<unknown>): Promise<string> {
  const clean = parsePlan(plan);
  const file = planFile(projectDir, clean.name);
  await mkdir(join(projectDir, "Content", "KesherTests"), { recursive: true });
  // The folder must really be inside the project (not a link out of it).
  await realInside(projectDir, join(projectDir, "Content", "KesherTests"));
  await before?.(file).catch(() => undefined);
  await writeFile(file, `${JSON.stringify(clean, null, 2)}\n`);
  return file;
}

/**
 * The tests kept in the project.
 *
 * @param projectDir - The project folder.
 * @returns Name, description and step count of each readable test, by name.
 */
export async function listPlans(projectDir: string): Promise<Array<{ name: string; description?: string; steps: number; map?: string }>> {
  const dir = join(projectDir, "Content", "KesherTests");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  const out: Array<{ name: string; description?: string; steps: number; map?: string }> = [];
  for (const f of names.slice(0, 200)) {
    const plan = await loadPlan(projectDir, f.slice(0, -5)).catch(() => undefined);
    if (plan) out.push({ name: plan.name, ...(plan.description ? { description: plan.description } : {}), steps: plan.steps.length, ...(plan.map ? { map: plan.map } : {}) });
  }
  return out;
}

/**
 * Reads one kept test.
 *
 * @param projectDir - The project folder.
 * @param name - Its name.
 * @throws Error when it is missing or not a valid plan.
 */
export async function loadPlan(projectDir: string, name: string): Promise<PlayTestPlan> {
  const text = await readFile(planFile(projectDir, name), "utf8").catch(() => {
    throw new Error(`No test named ${testSlug(name)} in Content/KesherTests.`);
  });
  return parsePlan(text);
}

/** One step in a few words ("press IA_Jump 10 frames"). */
export function stepLabel(s: PlayStep): string {
  const leaf = (p: string) => p.split(/[/.]/).filter(Boolean).pop() ?? p;
  const cond = (c: PlayCondition) => `${c.actor}.${c.property} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`;
  switch (s.do) {
    case "spawn": return `spawn ${leaf(s.class)}${s.possess ? " and possess it" : ""}`;
    case "possess": return `possess ${s.actor}`;
    case "input": return `press ${leaf(s.action)} (${JSON.stringify(s.value ?? true)}) for ${s.frames ?? 10} frames`;
    case "key": return `hold ${s.key} for ${s.frames ?? 10} frames`;
    case "axis": return `axis ${s.key} = ${s.value} for ${s.frames ?? 10} frames`;
    case "wait": return s.until ? `wait until ${cond(s.until)} (≤ ${s.timeout ?? 5} s)` : `wait ${s.seconds ?? 1} s`;
    case "assert": return `check ${cond(s)}`;
    case "screenshot": return `picture${s.name ? ` ${s.name}` : ""}`;
  }
}

/** Only the plugin's own pictures (Saved/KesherAI/play-test/*.png), never another path the socket names. */
const ownPicture = (p?: string) => !!p && /[\\/]Saved[\\/]KesherAI[\\/]play-test[\\/][\w-]+\.png$/i.test(p);

/**
 * Runs a gameplay test: in Play In Editor when Unreal is open (step results stream while it runs), else in a
 * headless editor (Unreal's automation runner; no pictures there). Play always stops at the end, also on an error
 * or Stop.
 *
 * @param b - The bridge.
 * @param plan - The test (checked here).
 * @param opts.onStep - Called once per finished step, in order, as it happens.
 * @param opts.signal - Stops the run (play ends, the steps so far come back).
 * @param opts.pollMs - How often to ask the plugin (default 400 ms).
 */
export async function runPlayTest(b: PlayTestBridge, plan: PlayTestPlan, opts: { onStep?: (r: PlayStepResult, plan: PlayTestPlan) => void; signal?: AbortSignal; pollMs?: number } = {}): Promise<PlayTestRun> {
  const clean = parsePlan(plan);
  const started = Date.now();
  const seen = new Set<number>();
  const emit = (steps: PlayStepResult[] = []) => {
    for (const s of steps) {
      if (seen.has(s.index)) continue;
      seen.add(s.index);
      opts.onStep?.(s, clean);
    }
  };
  if (!b.connected) {
    if (!b.canPlayHeadless || !b.playHeadless) throw new Error("Open the project in Unreal (or open it once with the KesherAI Bridge plugin so KesherAI can test it with Unreal closed).");
    const end = (await b.playHeadless(clean)) as PluginState;
    emit(end.steps);
    return finish("headless", clean, end, [], started);
  }
  const have = (await b.status()).editor?.bridge ?? "";
  if (have && !newer(have, PLAY_TEST_BRIDGE)) throw new Error(`Gameplay tests need the KesherAI Bridge plugin ${PLAY_TEST_BRIDGE} (installed ${have}). Press "Update automatically" at the top of the Unreal page.`);
  const start = await b.request<{ started: boolean; reason?: string }>("play_test", { plan: clean }, 120_000);
  if (!start.started) return { mode: "pie", passed: false, reason: start.reason ?? "It did not start.", steps: [], log: [], pictures: [], seconds: 0 };
  const limit = started + ((clean.timeout ?? 60) + 30) * 1000;
  let reason: string | undefined;
  let end: PluginState;
  try {
    for (;;) {
      if (opts.signal?.aborted) {
        reason = "Stopped.";
        break;
      }
      if (Date.now() > limit) {
        reason = `The test did not finish in ${clean.timeout ?? 60} s.`;
        break;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
      const st = await b.request<PluginState>("play_test_status", {}, 15_000);
      emit(st.steps);
      if (st.done || st.running === false) break;
    }
  } finally {
    // Always: the plugin ends play and gives the last steps, the log and the pictures' files.
    end = await b.request<PluginState>("play_test_stop", {}, 60_000).catch((e: Error) => ({ done: true, passed: false, reason: e.message }) as PluginState);
  }
  emit(end.steps);
  const pictures: PlayTestRun["pictures"] = [];
  for (const s of end.steps ?? []) {
    if (!ownPicture(s.picture)) continue;
    const data = await readFile(s.picture!).catch(() => undefined);
    if (data) pictures.push({ index: s.index, name: s.picture!.split(/[\\/]/).pop()!.replace(/\.png$/i, ""), data });
  }
  return finish("pie", clean, { ...end, ...(reason ? { reason, passed: false } : {}) }, pictures, started);
}

function finish(mode: PlayTestRun["mode"], plan: PlayTestPlan, end: PluginState, pictures: PlayTestRun["pictures"], started: number): PlayTestRun {
  const steps = (end.steps ?? []).map((s) => ({ ...s, text: short(s.text, 400) })).sort((a, b) => a.index - b.index);
  const all = steps.length === plan.steps.length && steps.every((s) => s.ok);
  const passed = end.passed !== false && all && !end.reason;
  return {
    mode,
    passed,
    ...(end.reason ? { reason: short(end.reason, 400) } : !passed && steps.length < plan.steps.length && steps.every((s) => s.ok) ? { reason: "Not every step ran." } : {}),
    steps,
    log: cleanLog(end.log ?? [], 80),
    pictures,
    seconds: Math.round(end.seconds ?? (Date.now() - started) / 1000),
  };
}

/** A finished step as one line ("✓ 2. press IA_Jump … — jumped"). */
export function stepLine(r: PlayStepResult, plan: PlayTestPlan): string {
  const step = plan.steps[r.index];
  return `${r.ok ? "✓" : "✗"} ${r.index + 1}. ${step ? stepLabel(step) : r.do}${r.text ? ` — ${r.text}` : ""}`;
}

/**
 * The run in words, for the model and the chat card.
 *
 * @param run - The run.
 * @param plan - Its plan.
 */
export function describePlayTest(run: PlayTestRun, plan: PlayTestPlan): string {
  const head = `Gameplay test ${plan.name} ${run.passed ? "PASSED" : "FAILED"} (${run.mode === "pie" ? "Play In Editor" : "headless editor, no pictures"}, ${run.seconds} s, ${run.steps.filter((s) => s.ok).length}/${plan.steps.length} steps).`;
  const log = run.log.filter((l) => l.kind !== "log" || /BlueprintUserMessages|LogScript/.test(l.category)).slice(0, 30).map((l) => `${l.kind === "log" ? "" : `[${l.kind}] `}${l.category ? `${l.category}: ` : ""}${l.text}`);
  return [head, run.reason ? `Stopped: ${run.reason}` : "", ...run.steps.map((s) => stepLine(s, plan)), log.length ? `What the game wrote:\n${log.join("\n")}` : ""].filter(Boolean).join("\n");
}

/**
 * A Functional Test stub from a plan, for a project that wants the test in Unreal's own format (a test map with the
 * actor, run by Session Frontend or CI). The text is returned, not written: the user puts it where they want.
 *
 * @param plan - The test.
 * @param kind - cpp: an AFunctionalTest subclass; blueprint: the nodes to place in a Functional Test Blueprint.
 * @param apiMacro - The module's API macro for C++ (e.g. MYGAME_API).
 */
export function functionalTestStub(plan: PlayTestPlan, kind: "cpp" | "blueprint", apiMacro = "YOURGAME_API"): string {
  const cls = `AKesher${testSlug(plan.name).replace(/[^A-Za-z0-9]/g, "")}Test`;
  const lines = plan.steps.map((s, i) => `${i + 1}. ${stepLabel(s)}`);
  if (kind === "blueprint") {
    return [
      `Functional Test Blueprint for "${plan.name}" (Content Browser → Blueprint Class → FunctionalTest; place it in ${plan.map ?? "a test map"}):`,
      "Event Start Test →",
      ...plan.steps.map((s, i) => {
        switch (s.do) {
          case "spawn": return `  ${i + 1}. Spawn Actor from Class (${s.class}) at the player + (${(s.offset ?? [400, 0, 0]).join(", ")})${s.possess ? " → Get Player Controller → Possess" : ""}`;
          case "possess": return `  ${i + 1}. Get Player Controller → Possess (${s.actor})`;
          case "input": return `  ${i + 1}. Get Enhanced Input Local Player Subsystem → Inject Input for Action (${s.action}, ${JSON.stringify(s.value ?? true)}) on Tick for ${s.frames ?? 10} frames`;
          case "key": case "axis": return `  ${i + 1}. Get Player Controller → Input Key (${s.key}${s.do === "axis" ? `, axis ${s.value}` : ""}) for ${s.frames ?? 10} frames`;
          case "wait": return s.until ? `  ${i + 1}. Loop with Delay 0.1 until ${stepLabel(s).replace(/^wait until /, "")}, else Finish Test (Failed)` : `  ${i + 1}. Delay ${s.seconds ?? 1}`;
          case "assert": return `  ${i + 1}. Assert ${s.op === "==" ? "Equal" : s.op === "!=" ? "Not Equal" : s.op === "near" ? "Equal (Vector, tolerance)" : `True (${s.op})`}: ${s.actor} ${s.property} vs ${JSON.stringify(s.value ?? "")}`;
          case "screenshot": return `  ${i + 1}. Take Automation Screenshot (${s.name ?? `step${i + 1}`})`;
        }
      }),
      "→ Finish Test (Succeeded)",
    ].join("\n");
  }
  return [
    `// ${cls}: Functional Test made by KesherAI from the gameplay test "${plan.name}".`,
    "// Put it in your game module (Build.cs: \"FunctionalTesting\", \"EnhancedInput\"), place the actor in",
    `// ${plan.map ?? "a test map"}, and run it from Session Frontend → Automation (Project.Functional Tests).`,
    "#pragma once",
    "",
    "#include \"CoreMinimal.h\"",
    "#include \"FunctionalTest.h\"",
    `#include "${cls.slice(1)}.generated.h"`,
    "",
    "UCLASS()",
    `class ${apiMacro} ${cls} : public AFunctionalTest`,
    "{",
    "\tGENERATED_BODY()",
    "",
    "public:",
    `\t${cls}() { PrimaryActorTick.bCanEverTick = true; TimeLimit = ${plan.timeout ?? 60}.f; }`,
    "",
    "protected:",
    "\tvirtual void StartTest() override",
    "\t{",
    "\t\tSuper::StartTest();",
    "\t\tStep = 0;",
    "\t\tFrames = 0;",
    "\t}",
    "",
    "\tvirtual void Tick(float DeltaSeconds) override",
    "\t{",
    "\t\tSuper::Tick(DeltaSeconds);",
    "\t\tif (!IsRunning()) return;",
    "\t\t// One case per step of the plan; move to the next with ++Step, Frames = 0.",
    "\t\tswitch (Step)",
    "\t\t{",
    ...plan.steps.map((s, i) => `\t\tcase ${i}: // ${lines[i]}\n\t\t\t${i === plan.steps.length - 1 ? "FinishTest(EFunctionalTestResult::Succeeded, TEXT(\"All steps passed\"));" : "++Step; Frames = 0;"} break;`),
    "\t\tdefault: break;",
    "\t\t}",
    "\t}",
    "",
    "private:",
    "\tint32 Step = 0;",
    "\tint32 Frames = 0;",
    "};",
    "",
    "// The plan:",
    ...lines.map((l) => `//   ${l}`),
  ].join("\n");
}

/** How a model writes a plan: the tool's description and schema share it. */
const PLAN_HELP =
  'plan = { name, description?, map? (a test map like /Game/Tests/TestMap; default the open level), timeout? (s), steps: [...] }. Steps: {do:"spawn", class:"/Game/BP_Enemy.BP_Enemy_C", offset?:[x,y,z] (from the player, default [400,0,0]), possess?:true} · {do:"possess", actor} · {do:"input", action:"/Game/Input/IA_Jump", value?: true | 0.5 | [x,y], frames?:10} (Enhanced Input) · {do:"key", key:"SpaceBar", frames?} · {do:"axis", key:"Gamepad_LeftY", value:1, frames?} · {do:"wait", seconds} or {do:"wait", until:{actor, property, op, value}, timeout?} · {do:"assert", actor, property, op, value, tolerance?, message?} · {do:"screenshot", name?}. actor: player | controller | an actor name or label | class:BP_Door. property: location, location.z, rotation, velocity, speed, hidden, or a variable name (Health, Stats.Ammo). op: == != > < >= <= contains exists near. At most 40 steps; 60 frames ≈ 1 s.';

/**
 * The chat tool `unreal_play_test`: runs a gameplay test (streams each step as it finishes), keeps it in the project,
 * lists the kept tests, or writes a Functional Test stub.
 *
 * @param o.bridge - The Unreal bridge.
 * @param o.projectDir - The Unreal project folder in use (where Content/KesherTests is).
 * @param o.saveImage - Keeps a picture as an asset (for the chat card); returns its id.
 */
export function playTestTool(o: { bridge: PlayTestBridge; projectDir: () => string | undefined; saveImage?: (png: Buffer) => Promise<string> }): AgentTool {
  const needDir = () => {
    const d = o.projectDir();
    if (!d) throw new Error("No Unreal project is in use: open it in Unreal with the KesherAI Bridge plugin first.");
    return d;
  };
  const planOf = async (input: Record<string, unknown>) => (input.plan ? parsePlan(input.plan) : input.name ? loadPlan(needDir(), String(input.name)) : Promise.reject(new Error("Give a plan, or the name of a kept test.")));
  return {
    risk: "write",
    spec: {
      name: "unreal_play_test",
      description: `Gameplay test in Unreal: plays the game (Play In Editor, or a headless editor when Unreal is closed) and runs steps: spawn/possess a pawn, press Enhanced Input actions or keys for some frames, wait for conditions, check actors' values, take pictures. Each step's result streams to the user. The level and assets are never changed; save:true keeps the test as Content/KesherTests/<name>.json to run again (also from Unreal's Session Frontend as KesherAI.PlayTest.<name>). action: run (default; plan or name), save, list, stub (a C++ or Blueprint Functional Test from the plan). Read the project's input actions first (unreal_read_graph / game_find for IA_*) instead of guessing paths. ${PLAN_HELP}`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["run", "save", "list", "stub"] },
          plan: { type: "object", description: "The test plan (see the description)." },
          name: { type: "string", description: "A kept test's name (instead of plan)." },
          save: { type: "boolean", description: "run: also keep the plan in the project." },
          stub: { type: "string", enum: ["cpp", "blueprint"], description: "stub: which kind (default cpp)." },
        },
      },
    },
    preview: async (input) => {
      if (input.action === "list") return "List the gameplay tests kept in the project";
      const plan = await planOf(input).catch(() => undefined);
      if (!plan) return `Gameplay test ${String(input.name ?? "")}`;
      const head = input.action === "save" ? `Keep the test as Content/KesherTests/${plan.name}.json` : input.action === "stub" ? `Write a ${input.stub === "blueprint" ? "Blueprint" : "C++"} Functional Test from ${plan.name}` : `Play the game to test ${plan.name}${input.save ? ` (and keep it as Content/KesherTests/${plan.name}.json)` : ""}; the level is not changed`;
      return `${head}:\n${plan.steps.map((s, i) => `${i + 1}. ${stepLabel(s)}`).join("\n")}`;
    },
    run: async (input, ctx) => {
      const action = String(input.action ?? "run");
      if (action === "list") {
        const tests = await listPlans(needDir());
        return { output: tests.length ? tests.map((t) => `${t.name} (${t.steps} steps${t.map ? `, ${t.map}` : ""})${t.description ? `: ${t.description}` : ""}`).join("\n") : "No gameplay tests are kept in this project yet (Content/KesherTests)." };
      }
      const plan = await planOf(input);
      if (action === "stub") return { output: functionalTestStub(plan, input.stub === "blueprint" ? "blueprint" : "cpp") };
      const saved = action === "save" || input.save === true ? await savePlan(needDir(), plan) : undefined;
      if (action === "save") return { output: `Kept the test as ${saved}. Run it again with unreal_play_test name "${plan.name}", or in Unreal: Session Frontend → Automation → KesherAI.PlayTest.${plan.name}.` };
      ctx.progress?.(`▶ ${plan.name}: ${plan.steps.length} steps\n`);
      const run = await runPlayTest(o.bridge, plan, { signal: ctx.signal, onStep: (r) => ctx.progress?.(`${stepLine(r, plan)}\n`) });
      const ids: string[] = [];
      for (const p of run.pictures.slice(0, 4)) if (o.saveImage) ids.push(await o.saveImage(p.data));
      const text = `${describePlayTest(run, plan)}${saved ? `\nKept as ${saved}.` : ""}`;
      return {
        output: text.slice(0, 8000),
        ...(ids.length ? { assetIds: ids } : {}),
        ...(run.pictures.length ? { images: run.pictures.slice(0, 4).map((p) => ({ mimeType: "image/png", data: p.data.toString("base64") })) } : {}),
      };
    },
  };
}
