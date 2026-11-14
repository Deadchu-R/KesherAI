/**
 * "Connect to Noctalia" (asked for: one click): copies KesherAI's Noctalia plugin into Noctalia's plugin folder and
 * enables it, the way Noctalia's plugin guide says for a local plugin (v4: ~/.config/noctalia/plugins/<id> and
 * plugins.json). Noctalia then needs a restart, and the widget is added to the bar from its Settings → Bar.
 * Linux only; nothing outside Noctalia's own folders is touched.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "kesherai";

/** Where the plugin's files are: bundled with the app, or in the repository. */
export function noctaliaPluginSource(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return [resources && join(resources, "noctalia-plugin", ID), resolve(here, "../../../integrations/noctalia", ID)].find((p): p is string => !!p && existsSync(join(p, "manifest.json")));
}

/** Noctalia on this computer, and whether the plugin is in. */
export function noctaliaStatus(home = homedir()): { linux: boolean; found: boolean; installed: boolean; folder: string } {
  const folder = join(home, ".config", "noctalia");
  return { linux: process.platform === "linux", found: existsSync(folder), installed: existsSync(join(folder, "plugins", ID, "manifest.json")), folder };
}

/**
 * Copies the plugin in (an older copy is replaced, its own settings kept) and marks it enabled in plugins.json
 * (other plugins' entries untouched).
 *
 * @returns What to tell the user.
 */
export async function installNoctaliaPlugin(source: string, home = homedir()): Promise<string> {
  const st = noctaliaStatus(home);
  if (!st.found) throw new Error("Noctalia was not found on this computer (no ~/.config/noctalia). Install Noctalia first.");
  const dest = join(st.folder, "plugins", ID);
  const settingsFile = join(dest, "settings.json");
  const keep = existsSync(settingsFile) ? await readFile(settingsFile, "utf8").catch(() => undefined) : undefined;
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, force: true });
  if (keep !== undefined) await writeFile(settingsFile, keep);
  const list = join(st.folder, "plugins.json");
  let states: Record<string, unknown> = {};
  if (existsSync(list)) {
    try {
      states = JSON.parse(await readFile(list, "utf8")) as Record<string, unknown>;
      if (!states || typeof states !== "object" || Array.isArray(states)) throw new Error("not an object");
    } catch {
      throw new Error("Noctalia's plugins.json could not be read, so it was left as it is. The plugin was copied: enable it in Noctalia → Settings → Plugins.");
    }
  }
  states[ID] = { ...((states[ID] as object | undefined) ?? {}), enabled: true, sourceUrl: "https://github.com/Deadchu-R/KesherAI" };
  const tmp = `${list}.tmp`;
  await writeFile(tmp, JSON.stringify(states, null, 2));
  await rename(tmp, list);
  return "KesherAI's plugin is in Noctalia. Restart Noctalia, then add the KesherAI widget to the bar in Noctalia → Settings → Bar.";
}
