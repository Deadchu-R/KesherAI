import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Finds the folders that cloud apps keep in sync on this computer
 * (OneDrive, Google Drive for desktop, Dropbox, iCloud Drive), so backing
 * up to one of them is one click. KesherAI writes into a `KesherAI`
 * folder inside it; the cloud app does the uploading.
 *
 * @param env - The environment (tests pass their own).
 * @param home - The home folder.
 * @returns Each service found, with the folder KesherAI would use.
 */
export function cloudFolders(env: NodeJS.ProcessEnv = process.env, home = homedir()): Array<{ service: string; folder: string }> {
  const out: Array<{ service: string; folder: string }> = [];
  const add = (service: string, root: string | undefined) => {
    if (root && existsSync(root) && !out.some((x) => x.folder === join(root, "KesherAI"))) out.push({ service, folder: join(root, "KesherAI") });
  };
  // OneDrive sets these on Windows (personal and work or school).
  add("OneDrive", env.OneDriveConsumer);
  add("OneDrive", env.OneDrive);
  add("OneDrive (work)", env.OneDriveCommercial);
  add("OneDrive", join(home, "OneDrive"));
  // macOS keeps cloud apps under ~/Library/CloudStorage.
  const cloud = join(home, "Library", "CloudStorage");
  let entries: string[] = [];
  try {
    entries = readdirSync(cloud);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (/^OneDrive/i.test(name)) add("OneDrive", join(cloud, name));
    if (/^GoogleDrive/i.test(name)) add("Google Drive", existsSync(join(cloud, name, "My Drive")) ? join(cloud, name, "My Drive") : join(cloud, name));
    if (/^Dropbox/i.test(name)) add("Dropbox", join(cloud, name));
  }
  // Google Drive for desktop on Windows: a drive letter with "My Drive".
  if (process.platform === "win32") for (const letter of "GHIJKLMNOPQRSTUVWXYZ") add("Google Drive", `${letter}:\\My Drive`);
  add("Dropbox", join(home, "Dropbox"));
  add("iCloud Drive", join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"));
  return out;
}
