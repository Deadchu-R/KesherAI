import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setIniKey } from "./unreal-install.js";

/**
 * Known engine bugs, checked before every build and fixed in the project
 * when a setting avoids them.
 *
 * Found the hard way (the user's phone, Unreal 5.8): two documented engine
 * bugs, each one a full build-install-crash-bug-report round. Both were on
 * Epic's forums. How others handle it: Unity's Project Validation and
 * Android Studio's Lint flag known-bad settings before a build; Epic's
 * Project Launcher/Turnkey checks the SDK, not the project. KesherAI keeps a
 * list of known issues (engine, versions, platform, the setting that
 * triggers it, the fix, the source), shipped with the app and refreshed from
 * the project's GitHub once a day, so an issue found once protects every
 * copy. The model is also told to search the web for the engine version and
 * platform before a first build, and for the exact error line after a crash.
 */

/** One known issue. */
export interface KnownIssue {
  id: string;
  engine: "unreal" | "unity";
  /** Engine versions it affects: from (inclusive) and until (exclusive, the fixed version); "" = open. */
  from: string;
  until: string;
  /** Platforms it affects, e.g. ["android"]; empty = all. */
  platforms: string[];
  title: string;
  /** Where it is documented. */
  source: string;
  /** The project setting that triggers it: an .ini key with the values that are bad. */
  check: { file: string; section: string; key: string; bad: string[] };
  /** The value that avoids it (written with a backup), or none when only a warning is possible. */
  fix?: string;
}

/** The issues known when this version was released. */
export const BUILTIN_ISSUES: KnownIssue[] = [
  {
    id: "UE-396689",
    engine: "unreal",
    from: "5.8.0",
    until: "5.8.4",
    platforms: ["android", "ios"],
    title: "Shared shader library misses shaders on Android Vulkan (the game quits right after the logo) and breaks materials on Metal",
    source: "https://forums.unrealengine.com/t/5-8-2-bsharematerialshadercode-missing-shader-resource-for-hash-fatal-on-android-vulkan-global-shadermap-all-materials-break-on-ios-metal-worked-in-5-7-4/2763737",
    check: { file: "Config/DefaultGame.ini", section: "[/Script/UnrealEd.ProjectPackagingSettings]", key: "bShareMaterialShaderCode", bad: ["True", "true", "1"] },
    fix: "False",
  },
  {
    id: "kesher-mobile-ldr-vulkan",
    engine: "unreal",
    from: "5.8.0",
    until: "",
    platforms: ["android"],
    title: "Mobile HDR off: Android Vulkan stops at start with 'Null Unordered Access View … FMobileBasePassUniformParameters' (found on a OnePlus 13, Android 16)",
    source: "https://github.com/Deadchu-R/KesherAI/blob/main/docs/known-issues.json",
    check: { file: "Config/DefaultEngine.ini", section: "[/Script/Engine.RendererSettings]", key: "r.MobileHDR", bad: ["False", "false", "0"] },
    fix: "True",
  },
];

const REMOTE = "https://raw.githubusercontent.com/Deadchu-R/KesherAI/main/docs/known-issues.json";

/** Compares dotted versions ("5.8.2" vs "5.8.10"). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(/[.\-a-z]/i).map((n) => Number(n) || 0);
  const y = b.split(/[.\-a-z]/i).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Whether an issue applies to this engine version and platform. */
export function applies(issue: KnownIssue, engine: KnownIssue["engine"], version: string, platform: string): boolean {
  if (issue.engine !== engine) return false;
  if (issue.platforms.length && !issue.platforms.includes(platform)) return false;
  if (issue.from && compareVersions(version, issue.from) < 0) return false;
  if (issue.until && compareVersions(version, issue.until) >= 0) return false;
  return true;
}

/** Reads one key of one .ini section (undefined when missing). */
export function iniValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^\[.*\]$/.test(l)) inSection = l === section;
    else if (inSection && l.split("=")[0]?.trim() === key) return l.slice(l.indexOf("=") + 1).trim();
  }
  return undefined;
}

function valid(x: unknown): x is KnownIssue {
  const i = x as KnownIssue;
  return !!i && typeof i.id === "string" && (i.engine === "unreal" || i.engine === "unity") && typeof i.title === "string" && !!i.check && typeof i.check.file === "string" && !/(^|[\\/])\.\.([\\/]|$)/.test(i.check.file) && /^Config\//.test(i.check.file) && typeof i.check.key === "string" && Array.isArray(i.check.bad);
}

/**
 * The known issues: the built-in ones plus the list on GitHub (refreshed at
 * most once a day, kept in the cache file; offline, the last copy is used).
 */
export async function knownIssues(cacheFile?: string): Promise<KnownIssue[]> {
  const byId = new Map(BUILTIN_ISSUES.map((i) => [i.id, i]));
  let remote: unknown[] = [];
  try {
    const cached = cacheFile && existsSync(cacheFile) ? (JSON.parse(await readFile(cacheFile, "utf8")) as { at: number; issues: unknown[] }) : undefined;
    if (cached && Date.now() - cached.at < 86_400_000) remote = cached.issues;
    else {
      const r = await fetch(REMOTE, { signal: AbortSignal.timeout(6000) }).catch(() => undefined);
      if (r?.ok) {
        const j = (await r.json()) as { issues?: unknown[] };
        remote = Array.isArray(j.issues) ? j.issues : [];
        if (cacheFile) {
          await mkdir(dirname(cacheFile), { recursive: true });
          await writeFile(cacheFile, JSON.stringify({ at: Date.now(), issues: remote }));
        }
      } else if (cached) remote = cached.issues;
    }
  } catch {
    // offline or a bad file: the built-in list
  }
  for (const i of remote) if (valid(i)) byId.set(i.id, i);
  return [...byId.values()];
}

/**
 * Checks a project against the known issues for this build and fixes what a
 * setting fixes (a backup of each changed file is kept next to it).
 *
 * @returns One line per issue found: fixed, or a warning.
 */
export async function preflight(projectDir: string, engine: KnownIssue["engine"], version: string, platform: string, issues: KnownIssue[]): Promise<string[]> {
  const out: string[] = [];
  for (const issue of issues.filter((i) => applies(i, engine, version, platform))) {
    const file = join(projectDir, issue.check.file);
    const text = existsSync(file) ? await readFile(file, "utf8") : "";
    const now = iniValue(text, issue.check.section, issue.check.key);
    if (now === undefined || !issue.check.bad.includes(now)) continue;
    if (issue.fix === undefined) {
      out.push(`Known issue ${issue.id} (${issue.title}): ${issue.check.key}=${now} in ${issue.check.file}. Not changed automatically; see ${issue.source}`);
      continue;
    }
    if (!existsSync(`${file}.kesher-backup`)) await writeFile(`${file}.kesher-backup`, text);
    await writeFile(file, setIniKey(text, issue.check.section, issue.check.key, issue.fix));
    out.push(`Avoided known issue ${issue.id}: ${issue.title}. Set ${issue.check.key}=${issue.fix} in ${issue.check.file} (was ${now}; backup kept). Source: ${issue.source}`);
  }
  return out;
}

/** What the model is told to do around builds (all engines). */
export const BUILD_RESEARCH_NOTE =
  "Before the first build for a platform with an engine version in this chat, use web_search for known problems with that exact version and platform (e.g. \"Unreal 5.8.2 Android Vulkan crash\", \"Unity 6000.2 Android build error\") and tell the user anything that applies. When a game crashes or a build fails, search the exact error line (in quotes) before changing anything, and prefer the documented fix.";
