/**
 * Playtest bug-report receipts and anomaly detectors.
 *
 * A **receipt** is a structured bug report produced after a playtest run:
 * type of anomaly, player position at detection, log excerpt, and a screenshot.
 * Stored under `<data>/playtest-receipts/<project>/<date>/` as JSON files.
 *
 * **Anomaly detectors** run over a stream of position samples and log lines
 * to find common problems: stuck player, fall-through-floor, shader errors,
 * fps drops.
 *
 * Based on docs/research/c-20261122-19.md and SYNTHESIS-2026-11-22.md GE-1.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestLine } from "./blueprint-test.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Anomaly kinds the detectors can find. */
export type AnomalyKind = "STUCK" | "FALL_THROUGH" | "CLIP" | "SHADER_ERROR" | "FPS_DROP";

/** Severity of the bug. */
export type Severity = "critical" | "high" | "medium" | "low";

/** A 3D position (Unity: meters, Unreal: cm). */
export interface Position {
  x: number;
  y: number;
  z: number;
}

/** A rotation (quaternion). */
export interface Rotation {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Transform (position + rotation). */
export interface Transform {
  position: Position;
  rotation: Rotation;
}

/** Camera state at detection. */
export interface CameraState {
  position: Position;
  rotation: Rotation;
  fov: number;
}

/** One sample from the playtest position stream. */
export interface PositionSample {
  /** Milliseconds since the run started. */
  t_ms: number;
  position: Position;
  velocity?: { x: number; y: number; z: number };
  fps?: number;
}

/** One input event during the run. */
export interface InputEvent {
  /** Milliseconds since the run started. */
  t_ms: number;
  device: "keyboard" | "gamepad" | "touch";
  key?: string;
  action?: "press" | "release" | "move";
  axis?: { x: number; y: number };
}

/**
 * A structured bug report (receipt) produced after a playtest run.
 * Maps directly onto the existing ToolOutput interface for the chat card.
 */
export interface BugReceipt {
  /** UUID v4. */
  receipt_id: string;
  /** ISO 8601 UTC. */
  timestamp_utc: string;
  /** Engine that ran the test. */
  engine: "unity" | "unreal";
  /** Project name (no paths). */
  project: string;
  /** Scene or level that was playing. */
  scene_or_level: string;
  /** Kind of anomaly detected. */
  anomaly_type: AnomalyKind;
  /** Severity rating. */
  severity: Severity;
  /** Player transform at detection. */
  player_transform: Transform;
  /** Camera state at detection. */
  camera_transform: CameraState;
  /** Engine log lines around the anomaly (before and after). */
  engine_log_trace: TestLine[];
  /** FPS at the moment of detection. */
  fps_at_detection: number;
  /** Window used to measure FPS in ms. */
  fps_window_ms: number;
  /** Screenshot path relative to the data dir. */
  screenshot_path: string;
  /** Steps to reproduce the bug, in order. */
  reproduction_steps: string[];
  /** Seconds into the exploration when detected. */
  exploration_seconds_elapsed: number;
  /** Total seconds the run lasted. */
  total_run_seconds: number;
  /** Phase of the exploration agent when detected. */
  agent_phase: string;
}

/**
 * Summary of all receipts from one playtest run.
 */
export interface RunSummary {
  /** Project name. */
  project: string;
  /** ISO 8601 UTC. */
  timestamp_utc: string;
  /** Total duration of the run in seconds. */
  total_seconds: number;
  /** Number of anomalies detected. */
  anomalies_count: number;
  /** Receipt ids found in this run. */
  receipt_ids: string[];
  /** Any anomalies classified as critical. */
  has_critical: boolean;
}

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * Returns the folder for a project's playtest receipts on a given date.
 *
 * @param dataDir - Root data directory (e.g. `~/.kesher`).
 * @param project - Project name.
 * @param date - Date string (e.g. `"2026-11-22"`).
 * @returns Absolute path to `<data>/playtest-receipts/<project>/<date>/`.
 */
export function receiptDir(dataDir: string, project: string, date: string): string {
  return join(dataDir, "playtest-receipts", project, date);
}

/**
 * Saves a bug receipt to disk.
 *
 * @param dataDir - Root data directory.
 * @param project - Project name.
 * @param receipt - The receipt to save.
 * @returns The file path written.
 */
export async function saveReceipt(dataDir: string, project: string, receipt: BugReceipt): Promise<string> {
  const date = receipt.timestamp_utc.slice(0, 10);
  const dir = receiptDir(dataDir, project, date);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${receipt.receipt_id}.json`);
  await writeFile(file, JSON.stringify(receipt, null, 2));
  return file;
}

/**
 * Loads a receipt from disk.
 *
 * @param dataDir - Root data directory.
 * @param project - Project name.
 * @param id - Receipt UUID.
 * @returns The receipt, or `undefined` if not found.
 */
export async function loadReceipt(dataDir: string, project: string, id: string): Promise<BugReceipt | undefined> {
  const files = await findReceiptFiles(dataDir, project);
  const relPath = files.find((f) => f.includes(`${id}.json`));
  if (!relPath) return undefined;
  const fullPath = join(dataDir, "playtest-receipts", project, relPath);
  const text = await readFile(fullPath, "utf-8");
  return JSON.parse(text) as BugReceipt;
}

/**
 * Lists all receipt file paths for a project (all dates).
 *
 * @param dataDir - Root data directory.
 * @param project - Project name.
 * @returns Array of file names (just the id + `.json`), empty when none.
 */
export async function findReceiptFiles(dataDir: string, project: string): Promise<string[]> {
  const base = join(dataDir, "playtest-receipts", project);
  try {
    const dirs = await readdir(base, { withFileTypes: true });
    const result: string[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const files = await readdir(join(base, d.name));
      for (const f of files) {
        if (f.endsWith(".json")) result.push(join(d.name, f));
      }
    }
    return result;
  } catch {
    return [];
  }
}

// ── Anomaly detectors ─────────────────────────────────────────────────────

/** Default config for anomaly detectors. */
const DEFAULTS = {
  /** Player is considered stuck when velocity is below this (m/s) for this long (ms). */
  stuckThreshold: 0.05,
  stuckDuration: 5_000,
  /** Player falls through floor when y position drops below this (meters). */
  fallThreshold: -100,
  /** FPS is considered a drop when it falls below this for this many samples. */
  fpsThreshold: 15,
  fpsSampleCount: 5,
  /** Shader error log categories. */
  shaderCategories: ["LogShaderCompilers", "Shader", "shader"],
};

interface DetectorConfig {
  stuckThreshold: number;
  stuckDuration: number;
  fallThreshold: number;
  fpsThreshold: number;
  fpsSampleCount: number;
  shaderCategories: string[];
}

/** Result of running all detectors on a position stream and log lines. */
export interface DetectionResult {
  /** Anomalies found (may be multiple). */
  anomalies: DetectedAnomaly[];
}

/** One anomaly found by a detector. */
export interface DetectedAnomaly {
  kind: AnomalyKind;
  /** Index of the sample where it was detected. */
  sampleIndex: number;
  /** Milliseconds since run start. */
  t_ms: number;
  /** Why the detector fired (for debugging). */
  reason: string;
}

/**
 * Runs all anomaly detectors over a position stream and engine log lines.
 *
 * @param samples - Position samples collected during the playtest run.
 * @param logs - Engine log lines (warnings and errors).
 * @param config - Override detector thresholds (defaults used for missing fields).
 * @returns All anomalies detected.
 */
export function detectAnomalies(
  samples: PositionSample[],
  logs: TestLine[],
  config: Partial<DetectorConfig> = {},
): DetectionResult {
  const cfg = { ...DEFAULTS, ...config };
  const anomalies: DetectedAnomaly[] = [];

  // Stuck detection
  let stuckStart = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const speed = s.velocity ? Math.sqrt(s.velocity.x ** 2 + s.velocity.y ** 2 + s.velocity.z ** 2) : 0;
    if (speed < cfg.stuckThreshold) {
      if (stuckStart < 0) stuckStart = i;
    } else {
      stuckStart = -1;
    }
    if (stuckStart >= 0 && s.t_ms - samples[stuckStart]!.t_ms >= cfg.stuckDuration) {
      anomalies.push({
        kind: "STUCK",
        sampleIndex: stuckStart,
        t_ms: samples[stuckStart]!.t_ms,
        reason: `Player velocity below ${cfg.stuckThreshold} m/s for ${cfg.stuckDuration} ms`,
      });
      stuckStart = -1; // Don't re-fire for the same stuck period
    }
  }

  // Fall-through detection
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.position.y < cfg.fallThreshold) {
      anomalies.push({
        kind: "FALL_THROUGH",
        sampleIndex: i,
        t_ms: s.t_ms,
        reason: `Player y position (${s.position.y}) below threshold (${cfg.fallThreshold})`,
      });
      break; // One fall-through per run
    }
  }

  // FPS drop detection
  let lowFpsCount = 0;
  let firstLowIndex = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const fps = s.fps;
    if (fps !== undefined && fps < cfg.fpsThreshold) {
      if (firstLowIndex < 0) firstLowIndex = i;
      lowFpsCount++;
      if (lowFpsCount >= cfg.fpsSampleCount) {
        anomalies.push({
          kind: "FPS_DROP",
          sampleIndex: firstLowIndex,
          t_ms: samples[firstLowIndex]!.t_ms,
          reason: `FPS below ${cfg.fpsThreshold} for ${lowFpsCount} consecutive samples`,
        });
        break;
      }
    } else {
      lowFpsCount = 0;
      firstLowIndex = -1;
    }
  }

  // Shader error detection (from logs)
  const shaderErrors = logs.filter(
    (l) => l.kind === "error" && cfg.shaderCategories.some((c) => l.category.toLowerCase().includes(c.toLowerCase())),
  );
  if (shaderErrors.length > 0) {
    anomalies.push({
      kind: "SHADER_ERROR",
      sampleIndex: 0,
      t_ms: 0,
      reason: `${shaderErrors.length} shader error(s) in engine log`,
    });
  }

  return { anomalies };
}

/**
 * Determines the severity of an anomaly kind.
 *
 * @param kind - The anomaly kind.
 * @returns Severity rating.
 */
export function anomalySeverity(kind: AnomalyKind): Severity {
  switch (kind) {
    case "FALL_THROUGH":
    case "STUCK":
      return "critical";
    case "CLIP":
      return "high";
    case "SHADER_ERROR":
      return "medium";
    case "FPS_DROP":
      return "low";
  }
}

/**
 * Builds a BugReceipt from a detection result.
 *
 * @param anomaly - The detected anomaly.
 * @param sample - The position sample at detection.
 * @param engine - Engine that ran the test.
 * @param project - Project name.
 * @param scene - Scene or level name.
 * @param logs - Engine log lines around the anomaly.
 * @param screenshotPath - Path to the screenshot.
 * @param totalSeconds - Total run duration.
 * @param agentPhase - Phase of the exploration agent.
 * @returns A complete BugReceipt.
 */
export function buildReceipt(
  anomaly: DetectedAnomaly,
  sample: PositionSample,
  engine: "unity" | "unreal",
  project: string,
  scene: string,
  logs: TestLine[],
  screenshotPath: string,
  totalSeconds: number,
  agentPhase: string,
): BugReceipt {
  const fps = sample.fps ?? 0;
  return {
    receipt_id: randomUUID(),
    timestamp_utc: new Date().toISOString(),
    engine,
    project,
    scene_or_level: scene,
    anomaly_type: anomaly.kind,
    severity: anomalySeverity(anomaly.kind),
    player_transform: {
      position: sample.position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
    camera_transform: {
      position: { ...sample.position, y: sample.position.y + 1.7 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      fov: 60,
    },
    engine_log_trace: logs,
    fps_at_detection: fps,
    fps_window_ms: 3000,
    screenshot_path: screenshotPath,
    reproduction_steps: [
      "Entered Play Mode",
      `Ran for ${(anomaly.t_ms / 1000).toFixed(1)} s`,
      `Player at (${sample.position.x.toFixed(1)}, ${sample.position.y.toFixed(1)}, ${sample.position.z.toFixed(1)})`,
      `${anomaly.kind}: ${anomaly.reason}`,
    ],
    exploration_seconds_elapsed: anomaly.t_ms / 1000,
    total_run_seconds: totalSeconds,
    agent_phase: agentPhase,
  };
}
