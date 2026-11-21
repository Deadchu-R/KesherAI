/**
 * The data folder, read first at start-up (docs/ARCHITECTURE_REVIEW.md B2): "start over", the config file, the paths,
 * and what the options and worker mode change in them.
 */
import { mkdir } from "node:fs/promises";
import { dataPaths, loadConfig, saveConfig, useSecretBox, type DataPaths, type KesherConfig } from "../config.js";
import { applyPendingReset } from "../reset.js";
import { fileSecretBox } from "../secret-file.js";
import { finishPending } from "../heavy-folder.js";
import type { KesherServerOptions } from "./options.js";

/**
 * Opens the data folder: a pending "start over" moves the old folder aside first, then the config is read.
 *
 * @param options - The server's options (data folder, port, worker mode).
 * @returns The paths, the config, and where "start over" put the old folder (if it just ran).
 */
export async function openDataDir(options: KesherServerOptions): Promise<{ paths: DataPaths; config: KesherConfig; resetBackup: string | undefined }> {
  const paths = dataPaths(options.dataDir);
  // "Start over" (Settings → General): the old data folder moves aside before anything uses it.
  const resetBackup = await applyPendingReset(paths.root).catch(() => undefined);
  // Keys at rest (S2): read and written through the system's protection when the desktop app gives it.
  // A headless run (no desktop app) uses a key file next to the data folder instead (secret-file.ts).
  useSecretBox(options.secrets ?? fileSecretBox(`${paths.root}.key`));
  const config = await loadConfig(paths);
  // Keys saved as plain text by an older start are written sealed now (once; later saves keep them sealed).
  await saveConfig(paths, config).catch(() => undefined);
  if (config.modelsDir) {
    paths.models = config.modelsDir;
    await mkdir(paths.models, { recursive: true }).catch(() => undefined);
  }
  // Heavy folders copied to another drive finish moving now, before any engine runs (the main app only).
  if (!options.worker && config.heavyPending.length) {
    const left = await finishPending(paths.root, config.heavyPending, (l) => console.log(l)).catch(() => config.heavyPending);
    if (left.length !== config.heavyPending.length) {
      config.heavyPending = left;
      await saveConfig(paths, config).catch(() => undefined);
    }
  }
  if (options.port !== undefined) config.port = options.port;
  if (options.worker) {
    // The worker only works for the main app on this computer: no remote access, no device sharing.
    config.remote.enabled = false;
    config.devices.share = false;
    process.env.KESHER_NO_BEACON = "1";
  }
  return { paths, config, resetBackup };
}
