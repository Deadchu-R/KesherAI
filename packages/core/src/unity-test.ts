import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestLine, TestRun } from "./blueprint-test.js";
import type { UnityCli } from "./unity-cli.js";

/**
 * Runs the open Unity project's scene in Play Mode for a few seconds, the way
 * the Unreal "Test" does: auto-tick on first (an unfocused Editor otherwise
 * freezes at frame 1 while still "playing"), Play, wait, a picture of the Game
 * view, the Console since Play started, then Stop (always, even on an error).
 *
 * @param unity - Unity's CLI (an Editor with the Pipeline package must be open).
 * @param opts.seconds - How long to play (1–60).
 * @param opts.dir - Where the picture is written (KesherAI's own folder).
 * @param opts.signal - Stops early.
 */
export async function runUnityTest(unity: Pick<UnityCli, "cliRaw" | "activeProject">, opts: { seconds?: number; dir: string; signal?: AbortSignal }): Promise<TestRun> {
  const project = unity.activeProject;
  if (!project) throw new Error("Open a Unity project in KesherAI first (the Unity page): a test runs its scene in Play Mode.");
  const at = ["--project-path", project];
  const seconds = Math.min(60, Math.max(1, Math.round(opts.seconds ?? 6)));
  const cmd = (args: string[], ms = 60_000) => unity.cliRaw(["command", ...args.slice(0, 2), ...at, "--result-only", ...(args.length > 2 ? ["--", ...args.slice(2)] : [])], ms);
  const err = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);

  // What the Console already holds, so only what Play adds is reported.
  const before = await consoleLines(unity, at);
  await cmd(["editor", "set_auto_tick"]).catch(() => undefined);
  const start = await cmd(["editor.playmode", "start"], 120_000);
  if (start.code !== 0) {
    const compile = (await consoleLines(unity, at, "error")).map((l) => l.text).slice(-20);
    return { played: false, reason: `Play Mode did not start: ${err(start)}`, compile, log: [], seconds: 0 };
  }
  const began = Date.now();
  let picture: Buffer | undefined;
  try {
    const until = began + seconds * 1000;
    while (Date.now() < until && !opts.signal?.aborted) await new Promise((r) => setTimeout(r, 500));
    await mkdir(opts.dir, { recursive: true });
    const file = join(opts.dir, "unity-test-run.png");
    await rm(file, { force: true });
    const shot = await cmd(["capture", "screenshot", "--view", "game", "--output-path", file]);
    if (shot.code !== 0 || !existsSync(file)) await cmd(["capture", "screenshot", "--output", file]);
    picture = await readFile(file).catch(() => undefined);
  } finally {
    await cmd(["editor.playmode", "stop"]).catch(() => undefined);
  }
  const after = await consoleLines(unity, at);
  return { played: true, compile: [], log: newLines(before, after), ...(picture ? { picture } : {}), seconds: Math.round((Date.now() - began) / 1000) };
}

/** The Console's last 200 entries as test lines. */
async function consoleLines(unity: Pick<UnityCli, "cliRaw">, at: string[], level = "info"): Promise<TestLine[]> {
  const r = await unity.cliRaw(["logs", "--console", "--level", level, "--tail", "200", ...at, "--format", "json"], 30_000).catch(() => undefined);
  if (!r || r.code !== 0) return [];
  return parseConsole(r.stdout);
}

/**
 * Reads `unity logs --console --format json` (rows under data.items, or a bare list).
 *
 * @param stdout - The CLI's JSON.
 */
export function parseConsole(stdout: string): TestLine[] {
  let rows: unknown;
  try {
    const j = JSON.parse(stdout) as { data?: { items?: unknown[] }; items?: unknown[] } | unknown[];
    rows = Array.isArray(j) ? j : (j.data?.items ?? j.items ?? []);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const level = String(o.level ?? o.type ?? o.logType ?? "log").toLowerCase();
    const kind: TestLine["kind"] = /error|exception|assert/.test(level) ? "error" : /warn/.test(level) ? "warning" : "log";
    return { kind, category: "", text: String(o.message ?? o.text ?? o.condition ?? "").replace(/\s+/g, " ").trim().slice(0, 400) };
  }).filter((l) => l.text);
}

/**
 * The lines in `after` that were not already at the end of `before` (the
 * Console keeps old entries; only what Play added counts).
 */
export function newLines(before: TestLine[], after: TestLine[]): TestLine[] {
  const key = (l: TestLine) => `${l.kind}|${l.text}`;
  // Find the longest tail of `before` that starts `after`.
  for (let k = Math.min(before.length, after.length); k > 0; k--) {
    const tail = before.slice(-k).map(key).join("\n");
    for (let i = 0; i + k <= after.length; i++) {
      if (after.slice(i, i + k).map(key).join("\n") === tail) return after.slice(i + k).slice(0, 120);
    }
  }
  return after.slice(0, 120);
}
