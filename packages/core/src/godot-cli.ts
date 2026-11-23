import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs Godot in headless mode to validate scripts or scenes without the editor.
 *
 * Godot's `--headless` mode runs the engine without a display server. Combined
 * with custom GDScript runners in the KesherAI Bridge addon, it validates
 * GDScript syntax and loads/inspects scene files offline.
 *
 * - Script validation: runs a small GDScript that reloads the given source code
 *   and checks for parse errors (`eval_script.gd`).
 * - Scene validation: instantiates the scene, walks the node tree, and reports
 *   missing references or invalid nodes (`apply_batch.gd`).
 *
 * @example
 *   ```ts
 *   const result = await validateScript(godotPath, projectDir, code);
 *   if (result.valid) console.log("Script is valid");
 *   ```
 */

/** Result of a headless Godot validation run. */
export interface GodotValidationResult {
  /** Whether the validation succeeded (no errors). */
  valid: boolean;
  /** Standard output from Godot (may contain SCENE_VALID or VALID markers). */
  stdout: string;
  /** Standard error from Godot (error messages, stack traces). */
  stderr: string;
  /** Exit code from the Godot process. */
  code: number;
}

/**
 * Validates GDScript source code by running it through Godot's headless mode.
 *
 * Uses the `eval_script.gd` helper from the KesherAI Bridge addon, which
 * creates a GDScript resource from the source string and calls `reload()`.
 *
 * @param godotPath - Path to the Godot executable (e.g. `Godot_v4.3.exe`).
 * @param projectDir - Path to the Godot project folder (containing `project.godot`).
 * @param sourceCode - The GDScript source code to validate.
 * @param timeoutMs - Maximum time for the validation (default 30 seconds).
 * @returns Result with validity flag, output and exit code.
 */
export function validateScript(
  godotPath: string,
  projectDir: string,
  sourceCode: string,
  timeoutMs = 30_000,
): Promise<GodotValidationResult> {
  return runGodotHeadless(
    godotPath,
    projectDir,
    [`-s`, `res://addons/kesher_bridge/eval_script.gd`, `--`, sourceCode],
    timeoutMs,
  );
}

/**
 * Validates a scene file by loading and instantiating it in headless mode.
 *
 * Uses the scene validator script from the KesherAI Bridge addon, which
 * loads the scene with `ResourceLoader`, instantiates it, and walks the
 * entire node tree checking for missing references and invalid nodes.
 *
 * @param godotPath - Path to the Godot executable.
 * @param projectDir - Path to the Godot project folder.
 * @param scenePath - Path to the `.tscn` file to validate (absolute or `res://` path).
 * @param timeoutMs - Maximum time for the validation (default 30 seconds).
 * @returns Result with validity flag, output and exit code.
 */
export function validateScene(
  godotPath: string,
  projectDir: string,
  scenePath: string,
  timeoutMs = 30_000,
): Promise<GodotValidationResult> {
  const path = scenePath.startsWith("res://") ? scenePath : `res://${scenePath.replace(/\\/g, "/")}`;
  return runGodotHeadless(
    godotPath,
    projectDir,
    [`--script`, `res://addons/kesher_bridge/apply_batch.gd`, `--`, `validate`, path],
    timeoutMs,
  );
}

/**
 * Runs a Godot headless command and collects the output.
 *
 * @internal
 */
function runGodotHeadless(
  godotPath: string,
  projectDir: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<GodotValidationResult> {
  const args = ["--headless", "--path", projectDir, ...extraArgs];
  return new Promise((resolve) => {
    execFile(
      godotPath,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = Number(error?.code ?? 0);
        const out = String(stdout ?? "").trim();
        const err = String(stderr ?? "").trim();
        // Exit code 0 means success; the scripts print "VALID" or "SCENE_VALID"
        const valid = code === 0 && (out.includes("VALID") || out.includes("SCENE_VALID"));
        resolve({ valid, stdout: out, stderr: err, code });
      },
    );
  });
}

/**
 * Checks whether a Godot project has the KesherAI Bridge addon installed
 * (required for headless validation scripts).
 *
 * @param projectDir - Path to the Godot project folder.
 * @returns True if the addon's scripts exist and are ready for headless use.
 */
export function hasBridgeAddon(projectDir: string): boolean {
  const addonDir = join(projectDir, "addons", "kesher_bridge");
  return (
    existsSync(join(addonDir, "eval_script.gd")) &&
    existsSync(join(addonDir, "apply_batch.gd"))
  );
}
