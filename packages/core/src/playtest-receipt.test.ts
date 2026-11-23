/**
 * Tests for playtest-receipt.ts: anomaly detectors, storage, and receipt building.
 */
import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestLine } from "./blueprint-test.js";
import type { PositionSample } from "./playtest-receipt.js";
import { detectAnomalies, buildReceipt, saveReceipt, loadReceipt, findReceiptFiles, anomalySeverity, receiptDir } from "./playtest-receipt.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function sample(t_ms: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, fps?: number): PositionSample {
  return { t_ms, position: { x, y, z }, velocity: { x: vx, y: vy, z: vz }, fps };
}

// ── Anomaly detectors ─────────────────────────────────────────────────────

describe("detectAnomalies", () => {
  it("detects STUCK when velocity stays below threshold for long enough", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 1, 0, 1),
      sample(1000, 1, 0, 1, 0.01, 0, 0.01),
      sample(2000, 1.01, 0, 1.01, 0.02, 0, 0.02),
      sample(3000, 1.03, 0, 1.03, 0.01, 0, 0.01),
      sample(4000, 1.04, 0, 1.04, 0.01, 0, 0.01),
      sample(5000, 1.05, 0, 1.05, 0.01, 0, 0.01),
      sample(6001, 1.06, 0, 1.06, 0.01, 0, 0.01),
    ];
    const { anomalies } = detectAnomalies(samples, []);
    assert.ok(anomalies.some((a) => a.kind === "STUCK"), "should detect stuck");
    const stuck = anomalies.find((a) => a.kind === "STUCK")!;
    assert.equal(stuck.sampleIndex, 1, "stuck starts at first low-velocity sample");
  });

  it("does NOT detect STUCK when player moves normally", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 1, 0, 1),
      sample(1000, 1, 0, 1, 1, 0, 1),
      sample(2000, 2, 0, 2, 1, 0, 1),
    ];
    const { anomalies } = detectAnomalies(samples, []);
    assert.ok(!anomalies.some((a) => a.kind === "STUCK"), "should not detect stuck");
  });

  it("detects FALL_THROUGH when y drops below threshold", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 0, 0, 1),
      sample(1000, 0, -50, 10, 0, -10, 1),
      sample(2000, 0, -150, 20, 0, -20, 1),
    ];
    const { anomalies } = detectAnomalies(samples, []);
    assert.ok(anomalies.some((a) => a.kind === "FALL_THROUGH"), "should detect fall-through");
  });

  it("does NOT detect FALL_THROUGH when player stays above threshold", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 0, 0, 1),
      sample(1000, 0, 1, 10, 0, 0, 1),
    ];
    const { anomalies } = detectAnomalies(samples, []);
    assert.ok(!anomalies.some((a) => a.kind === "FALL_THROUGH"), "should not detect fall-through");
  });

  it("detects FPS_DROP when fps stays below threshold for enough samples", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 1, 0, 1, 60),
      sample(1000, 1, 0, 1, 1, 0, 1, 10),
      sample(2000, 2, 0, 2, 1, 0, 1, 8),
      sample(3000, 3, 0, 3, 1, 0, 1, 12),
      sample(4000, 4, 0, 4, 1, 0, 1, 5),
      sample(5000, 5, 0, 5, 1, 0, 1, 3),
    ];
    const { anomalies } = detectAnomalies(samples, []);
    assert.ok(anomalies.some((a) => a.kind === "FPS_DROP"), "should detect fps drop");
  });

  it("does NOT detect FPS_DROP when fps recovers", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 1, 0, 1, 60),
      sample(1000, 1, 0, 1, 1, 0, 1, 10),
      sample(2000, 2, 0, 2, 1, 0, 1, 60),
      sample(3000, 3, 0, 3, 1, 0, 1, 10),
      sample(4000, 4, 0, 4, 1, 0, 1, 60),
    ];
    const { anomalies } = detectAnomalies(samples, []);
    assert.ok(!anomalies.some((a) => a.kind === "FPS_DROP"), "should not detect fps drop");
  });

  it("detects SHADER_ERROR from engine logs", () => {
    const logs: TestLine[] = [
      { kind: "error", category: "LogShaderCompilers", text: "Failed to compile shader" },
    ];
    const { anomalies } = detectAnomalies([], logs);
    assert.ok(anomalies.some((a) => a.kind === "SHADER_ERROR"), "should detect shader error");
  });

  it("does NOT detect SHADER_ERROR from warnings", () => {
    const logs: TestLine[] = [
      { kind: "warning", category: "LogShaderCompilers", text: "Shader compiled with warnings" },
    ];
    const { anomalies } = detectAnomalies([], logs);
    assert.ok(!anomalies.some((a) => a.kind === "SHADER_ERROR"), "should not detect shader error from warning");
  });

  it("detects multiple anomalies in one run", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 0.01, 0, 0.01, 60),
      sample(1000, 0.01, 0, 0.01, 0.01, 0, 0.01, 10),
      sample(2000, 0.02, 0, 0.02, 0.01, 0, 0.01, 8),
      sample(3000, 0.03, 0, 0.03, 0.01, 0, 0.01, 12),
      sample(4000, 0.04, 0, 0.04, 0.01, 0, 0.01, 5),
      sample(5001, 0.05, 0, 0.05, 0.01, 0, 0.01, 3),
    ];
    const logs: TestLine[] = [
      { kind: "error", category: "LogShaderCompilers", text: "Shader compile failed" },
    ];
    const { anomalies } = detectAnomalies(samples, logs);
    assert.ok(anomalies.some((a) => a.kind === "STUCK"), "should detect stuck");
    assert.ok(anomalies.some((a) => a.kind === "FPS_DROP"), "should detect fps drop");
    assert.ok(anomalies.some((a) => a.kind === "SHADER_ERROR"), "should detect shader error");
  });

  it("respects custom config thresholds", () => {
    const samples: PositionSample[] = [
      sample(0, 0, 0, 0, 0.1, 0, 0.1),
      sample(1000, 0.1, 0, 0.1, 0.1, 0, 0.1),
      sample(2000, 0.2, 0, 0.2, 0.1, 0, 0.1),
    ];
    // Default threshold is 0.05, so 0.1 should not fire. But with 0.2 it should.
    const { anomalies } = detectAnomalies(samples, [], { stuckThreshold: 0.2, stuckDuration: 2000 });
    assert.ok(anomalies.some((a) => a.kind === "STUCK"), "should detect stuck with custom threshold");
  });
});

// ── Severity ───────────────────────────────────────────────────────────────

describe("anomalySeverity", () => {
  it("returns critical for STUCK and FALL_THROUGH", () => {
    assert.equal(anomalySeverity("STUCK"), "critical");
    assert.equal(anomalySeverity("FALL_THROUGH"), "critical");
  });

  it("returns high for CLIP", () => {
    assert.equal(anomalySeverity("CLIP"), "high");
  });

  it("returns medium for SHADER_ERROR", () => {
    assert.equal(anomalySeverity("SHADER_ERROR"), "medium");
  });

  it("returns low for FPS_DROP", () => {
    assert.equal(anomalySeverity("FPS_DROP"), "low");
  });
});

// ── Receipt building ──────────────────────────────────────────────────────

describe("buildReceipt", () => {
  it("creates a valid receipt with all fields", () => {
    const anomaly = { kind: "STUCK" as const, sampleIndex: 0, t_ms: 5000, reason: "test" };
    const receipt = buildReceipt(
      anomaly,
      sample(5000, 10, 0, -20, 0, 0, 0, 30),
      "unity",
      "MyGame",
      "Scene1",
      [],
      "screenshot.png",
      60,
      "exploration",
    );
    assert.ok(receipt.receipt_id.length === 36, "has UUID");
    assert.ok(receipt.timestamp_utc, "has timestamp");
    assert.equal(receipt.engine, "unity");
    assert.equal(receipt.project, "MyGame");
    assert.equal(receipt.anomaly_type, "STUCK");
    assert.equal(receipt.severity, "critical");
    assert.equal(receipt.exploration_seconds_elapsed, 5);
    assert.equal(receipt.total_run_seconds, 60);
    assert.equal(receipt.agent_phase, "exploration");
    assert.ok(receipt.reproduction_steps.length >= 4, "has reproduction steps");
  });
});

// ── Storage ────────────────────────────────────────────────────────────────

describe("receipt storage", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kesher-receipt-"));
  });

  it("saves and loads a receipt", async () => {
    const anomaly = { kind: "FPS_DROP" as const, sampleIndex: 0, t_ms: 1000, reason: "test" };
    const receipt = buildReceipt(
      anomaly,
      sample(1000, 0, 0, 0, 1, 0, 1, 10),
      "unreal",
      "TestProject",
      "Level01",
      [],
      "screenshot.png",
      30,
      "exploration",
    );
    const path = await saveReceipt(dataDir, "TestProject", receipt);
    assert.ok(path.includes(receipt.receipt_id), "path contains receipt id");

    const loaded = await loadReceipt(dataDir, "TestProject", receipt.receipt_id);
    assert.ok(loaded, "receipt was loaded");
    assert.equal(loaded!.receipt_id, receipt.receipt_id);
    assert.equal(loaded!.anomaly_type, receipt.anomaly_type);
  });

  it("finds receipt files for a project", async () => {
    const anomaly = { kind: "STUCK" as const, sampleIndex: 0, t_ms: 0, reason: "test" };
    const receipt = buildReceipt(
      anomaly,
      sample(0, 0, 0, 0, 0, 0, 0),
      "unity",
      "FindMe",
      "Scene",
      [],
      "s.png",
      10,
      "exploration",
    );
    await saveReceipt(dataDir, "FindMe", receipt);
    const files = await findReceiptFiles(dataDir, "FindMe");
    assert.ok(files.length >= 1, "found at least one receipt file");
    assert.ok(files.some((f) => f.includes(receipt.receipt_id)), "file contains receipt id");
  });

  it("returns empty array when project has no receipts", async () => {
    const files = await findReceiptFiles(dataDir, "NoProject");
    assert.deepEqual(files, []);
  });

  it("returns undefined for non-existent receipt", async () => {
    const loaded = await loadReceipt(dataDir, "TestProject", "00000000-0000-0000-0000-000000000000");
    assert.equal(loaded, undefined);
  });

  it("receiptDir returns correct path", () => {
    const dir = receiptDir("/home/user/.kesher", "MyGame", "2026-11-22");
    assert.ok(dir.includes("playtest-receipts"), "path includes playtest-receipts");
    assert.ok(dir.includes("MyGame"), "path includes project name");
    assert.ok(dir.includes("2026-11-22"), "path includes date");
  });
});
