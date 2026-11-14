/**
 * "Connect to Noctalia" (asked for: one click): puts KesherAI's bar plugin into Noctalia and switches it on.
 *
 * Two Noctalias exist, with different plugins:
 * - Noctalia v5 (the `noctalia` program): Luau plugins with a plugin.toml, placed by hand in
 *   $XDG_DATA_HOME/noctalia/plugins/<plugin>, switched on with `noctalia msg plugins enable <author>/<plugin>` or
 *   `[plugins] enabled` in config.toml. Config is hot-reloaded, so no restart.
 * - Noctalia Shell v4 (Quickshell): QML plugins in ~/.config/noctalia/plugins/<id> and plugins.json; needs a restart.
 * The widget is then added to the bar from Noctalia's Settings → Bar. Linux only; nothing outside Noctalia's own
 * folders is touched.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "kesherai";
/** The v5 plugin's id (`<author>/<plugin>`). */
export const NOCTALIA_V5_ID = "kesherai/kesherai";

type Env = Record<string, string | undefined>;

/**
 * Where the plugin's files are: bundled with the app, or in the repository.
 *
 * @param version - "v5" (Luau) or "v4" (QML).
 */
export function noctaliaPluginSource(version: "v4" | "v5" = "v4"): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  const [bundled, repo, marker] = version === "v5" ? ["noctalia-plugin-v5", "noctalia-v5", "plugin.toml"] : ["noctalia-plugin", "noctalia", "manifest.json"];
  return [resources && join(resources, bundled, ID), resolve(here, "../../../integrations", repo, ID)].find((p): p is string => !!p && existsSync(join(p, marker)));
}

/** Noctalia's folders on this computer (XDG, as Noctalia reads them). */
function folders(home: string, env: Env) {
  const config = join(env.NOCTALIA_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, ".config"), "noctalia");
  const data = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "noctalia");
  const state = join(env.NOCTALIA_STATE_HOME || env.XDG_STATE_HOME || join(home, ".local", "state"), "noctalia");
  return { config, data, state };
}

/** Whether the `noctalia` program (v5) is on the PATH. */
function hasProgram(env: Env): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "noctalia")));
}

/**
 * Noctalia on this computer: which one, and whether the plugin is in.
 *
 * @param home - The home folder (a test gives its own).
 * @param env - The environment (a test gives its own).
 */
export function noctaliaStatus(home = homedir(), env: Env = process.env): { linux: boolean; found: boolean; installed: boolean; version?: "v4" | "v5"; folder: string } {
  const f = folders(home, env);
  let tomls = false;
  try {
    tomls = readdirSync(f.config).some((n) => n.endsWith(".toml"));
  } catch {
    /* no config folder */
  }
  const v5 = tomls || hasProgram(env) || existsSync(join(f.state, "settings.toml")) || existsSync(join(f.data, "plugins"));
  const v4 = !v5 && existsSync(f.config);
  const linux = process.platform === "linux";
  if (v5) return { linux, found: true, version: "v5", installed: existsSync(join(f.data, "plugins", ID, "plugin.toml")), folder: join(f.data, "plugins") };
  if (v4) return { linux, found: true, version: "v4", installed: existsSync(join(f.config, "plugins", ID, "manifest.json")), folder: join(f.config, "plugins") };
  return { linux, found: false, installed: false, folder: f.config };
}

/** Runs `noctalia msg plugins enable …` (v5); false when it did not work (Noctalia not running, an older build). */
function enableByMessage(): Promise<boolean> {
  return new Promise((done) => {
    execFile("noctalia", ["msg", "plugins", "enable", NOCTALIA_V5_ID], { timeout: 8000 }, (err) => done(!err));
  });
}

/**
 * Adds the plugin to `[plugins] enabled` in a config.toml's text, touching nothing else.
 *
 * @returns The new text, the same text when it is already there, or undefined when the file is laid out in a way
 * that is not safe to change by hand (the person enables it in Settings instead).
 */
export function enableInConfigToml(text: string, id = NOCTALIA_V5_ID): string | undefined {
  const quoted = JSON.stringify(id);
  const lines = text.split("\n");
  const head = lines.findIndex((l) => /^\s*\[plugins\]\s*(#.*)?$/.test(l));
  if (head < 0) return `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n[plugins]\nenabled = [${quoted}]\n`;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  for (let i = head + 1; i < end; i++) {
    const m = /^(\s*enabled\s*=\s*\[)(.*)\](\s*(#.*)?)$/.exec(lines[i]!);
    if (m) {
      if (m[2]!.includes(quoted) || m[2]!.includes(`'${id}'`)) return text;
      const items = m[2]!.trim().replace(/,\s*$/, "");
      lines[i] = `${m[1]}${items ? `${items}, ` : ""}${quoted}]${m[3]}`;
      return lines.join("\n");
    }
    if (/^\s*enabled\s*=/.test(lines[i]!)) return undefined;
  }
  lines.splice(head + 1, 0, `enabled = [${quoted}]`);
  return lines.join("\n");
}

async function installV5(source: string, home: string, env: Env): Promise<string> {
  const f = folders(home, env);
  const dest = join(f.data, "plugins", ID);
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await cp(source, dest, { recursive: true });
  const added = "KesherAI's plugin is in Noctalia and switched on. Add it to the bar: Noctalia → Settings → Bar → Add widget → KesherAI.";
  if (env.KESHER_NO_NOCTALIA_MSG !== "1" && (await enableByMessage())) return added;
  const file = join(f.config, "config.toml");
  const before = existsSync(file) ? await readFile(file, "utf8") : "";
  const after = enableInConfigToml(before);
  if (after === undefined) return "KesherAI's plugin is in Noctalia. Switch it on in Noctalia → Settings → Plugins, then add it to the bar in Settings → Bar.";
  if (after !== before) {
    await mkdir(f.config, { recursive: true });
    if (before) await writeFile(`${file}.kesher-backup`, before);
    await writeFile(`${file}.tmp`, after);
    await rename(`${file}.tmp`, file);
  }
  return added;
}

async function installV4(source: string, home: string, env: Env): Promise<string> {
  const config = folders(home, env).config;
  const dest = join(config, "plugins", ID);
  const settingsFile = join(dest, "settings.json");
  const keep = existsSync(settingsFile) ? await readFile(settingsFile, "utf8").catch(() => undefined) : undefined;
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, force: true });
  if (keep !== undefined) await writeFile(settingsFile, keep);
  const list = join(config, "plugins.json");
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

/**
 * Puts the plugin that fits this computer's Noctalia in and switches it on (other plugins and settings untouched;
 * a changed config.toml is kept as config.toml.kesher-backup first).
 *
 * @param home - The home folder (a test gives its own).
 * @param env - The environment (a test gives its own).
 * @returns What to tell the user.
 */
export async function installNoctaliaPlugin(home = homedir(), env: Env = process.env): Promise<string> {
  const st = noctaliaStatus(home, env);
  if (!st.found) throw new Error("Noctalia was not found on this computer. Install Noctalia first.");
  const source = noctaliaPluginSource(st.version);
  if (!source) throw new Error("The plugin's files are missing from this build.");
  return st.version === "v5" ? installV5(source, home, env) : installV4(source, home, env);
}
