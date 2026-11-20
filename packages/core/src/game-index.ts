import { basename, extname } from "node:path";
import { join } from "node:path";
import { bare, indexProject, listAssets, type AgentTool, type Indexed } from "@kesher/agent";
import type { GameProject } from "./game-projects.js";
import { packageFileOf, packageNameOf } from "./uasset.js";
import { unrealAssetInfo, usersOf, withUnrealKinds, type IndexedAsset } from "./unreal-assets.js";

/**
 * Project index and search with the engine closed (RESEARCH_LOG "Gap list: engine work without the engine open",
 * 2026-11-20, step 3): the code index the coding agent already keeps (code_map, find_symbol: every C#, C++, GDScript
 * and Verse file with its classes and functions, reused while a file's size and time stay the same) and the asset
 * list (find_assets: prefabs, scenes, Blueprints, materials…, a folder re-read only when its time changed), searched
 * together for the Game projects page and the chat tool `game_find`. Unreal .uasset/.umap files get their class and
 * Blueprint parent from their headers (step 7, unreal-assets.ts). Nothing here opens an engine.
 */

/** The kinds of results, in the order the search sheet shows them. */
export const HIT_KINDS = ["code", "script", "scene", "prefab", "asset"] as const;
/** A kind of result: code (a class or function), script (a file), scene, prefab (also Blueprints), asset. */
export type HitKind = (typeof HIT_KINDS)[number];

/** One search result. */
export interface GameHit {
  kind: HitKind;
  /** What it is called: a class or function, a file name, an asset name. */
  name: string;
  /** Its file, relative to the project (with /). */
  path: string;
  /** The definition's line (symbols only). */
  line?: number;
  /** A short kind word in English ("class", "C#", "Blueprint", "material"…). */
  detail: string;
  score: number;
}

/** A project's search answer. */
export interface GameSearch {
  hits: GameHit[];
  /** How many matched of each kind (also beyond the limit). */
  counts: Record<HitKind, number>;
  /** How many source files and assets were looked at. */
  files: number;
  assets: number;
}

/** Source files' language names, for the results. */
const LANG_NAME: Record<string, string> = { ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".h": "C++", ".hpp": "C++", ".gd": "GDScript", ".verse": "Verse" };
/** The source files that belong to a game (the agent's index also has .ts, .py… for other projects). */
const GAME_CODE = /\.(cs|cpp|cc|h|hpp|gd|verse)$/i;

/** Hebrew words a search may use for a kind, as the English word the results carry (stems: "סצנות" has "סצנ"). */
const HE_WORDS: Array<[string, string]> = [["סצנ", "scene"], ["שלב", "level"], ["מפה", "level"], ["פריפאב", "prefab"], ["פרפאב", "prefab"], ["בלופרינט", "blueprint"], ["חומר", "material"], ["טקסטור", "texture"], ["מרקם", "texture"], ["סקריפט", "script"], ["מחלק", "class"], ["פונקצי", "function"], ["אנימצי", "animation"], ["צליל", "sound"], ["סאונד", "sound"], ["ווידג", "widget"], ["ממשק", "ui"], ["רשת", "mesh"], ["מודל", "mesh"], ["שיידר", "shader"]];

/**
 * The words of a search, Hebrew kind words turned into the English ones the results carry.
 *
 * @param query - What was typed.
 * @returns Lower-case words of 2+ letters.
 */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1)
    .map((w) => HE_WORDS.find(([he]) => w.includes(he))?.[1] ?? w);
}

/**
 * Which group an asset kind goes in.
 *
 * @param kind - The asset's kind ("level", "Blueprint", "material"…).
 */
export function assetGroup(kind: string): HitKind {
  if (/^(scene|level)$/.test(kind)) return "scene";
  if (/^(prefab|Blueprint|widget|anim Blueprint)$/.test(kind)) return "prefab";
  return "asset";
}

/**
 * How well a name matches the words: every word must be in the name, the path or the kind; a whole name beats its
 * start, which beats a part.
 *
 * @returns 0 for no match.
 */
function scoreOf(words: string[], name: string, path: string, detail: string): number {
  const n = name.toLowerCase();
  const p = path.toLowerCase();
  const d = detail.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (n === w) score += 100;
    else if (n.startsWith(w)) score += 60;
    else if (n.includes(w)) score += 30;
    else if (d === w || d.split(" ").includes(w) || (w === "script" && GAME_CODE.test(p))) score += 15;
    else if (p.includes(w)) score += 10;
    else return 0;
  }
  return score;
}

/** Recent indexes by project folder: a search per key press reuses them for a few seconds. */
const recent = new Map<string, { at: number; files: Indexed[]; assets: IndexedAsset[] }>();
const RECENT_MS = 15_000;

/**
 * The project's code index and assets (cached underneath by file and folder times; kept a few seconds here so typing
 * in the search box does not walk the folders on every key). Unreal packages carry their class from their headers
 * (read within a time budget; the rest on a later call).
 *
 * @param root - The project folder.
 */
export async function projectIndex(root: string): Promise<{ files: Indexed[]; assets: IndexedAsset[] }> {
  const hit = recent.get(root);
  if (hit && Date.now() - hit.at < RECENT_MS) return hit;
  // One walk at a time per project: key presses while a big project is read wait for that walk (scan 168).
  const running = building.get(root);
  if (running) return running;
  const job = (async () => {
    const [files, listed] = await Promise.all([indexProject(root).then((f) => f.filter((x) => GAME_CODE.test(x.path))), listAssets(root)]);
    const { assets } = await withUnrealKinds(root, listed);
    const item = { at: Date.now(), files, assets };
    recent.set(root, item);
    if (recent.size > 20) recent.delete(recent.keys().next().value!);
    return item;
  })().finally(() => building.delete(root));
  building.set(root, job);
  return job;
}

/** Index walks running now, by project folder. */
const building = new Map<string, Promise<{ at: number; files: Indexed[]; assets: IndexedAsset[] }>>();

/**
 * Searches one game project: classes and functions (with their lines), script files, scenes and levels, prefabs and
 * Blueprints, and other assets, best first.
 *
 * @param root - The project folder.
 * @param query - Words (Hebrew kind words work too: "סצנה", "בלופרינט").
 * @param opts.kind - Only this kind of result.
 * @param opts.limit - At most this many results (default 60).
 * @returns The results and the counts of each kind.
 */
export async function searchGameProject(root: string, query: string, opts: { kind?: HitKind; limit?: number } = {}): Promise<GameSearch> {
  const { files, assets } = await projectIndex(root);
  const counts: Record<HitKind, number> = { code: 0, script: 0, scene: 0, prefab: 0, asset: 0 };
  const words = searchWords(query);
  const hits: GameHit[] = [];
  const add = (h: GameHit) => {
    counts[h.kind]++;
    if (!opts.kind || opts.kind === h.kind) hits.push(h);
  };
  if (words.length) {
    for (const f of files) {
      const lang = LANG_NAME[extname(f.path).toLowerCase()] ?? "code";
      const fileName = basename(f.path);
      const fileScore = scoreOf(words, fileName.replace(/\.[^.]+$/, ""), f.path, lang);
      if (fileScore) add({ kind: "script", name: fileName, path: f.path, detail: lang, score: fileScore });
      f.symbols.forEach((sym, i) => {
        const name = bare(sym);
        const detail = /\(\)$/.test(sym) ? "function" : sym.split(/\s+/)[0]!;
        const score = scoreOf(words, name, f.path, detail);
        if (score) add({ kind: "code", name, path: f.path, line: f.lines[i]!, detail: `${detail} · ${lang}`, score: score + 5 });
      });
    }
    for (const a of assets) {
      const name = basename(a.path).replace(/\.[^.]+$/, "");
      const detail = a.parent ? `${a.kind} · ${a.parent}` : a.kind;
      const score = scoreOf(words, name, a.path, detail);
      if (score) add({ kind: assetGroup(a.kind), name, path: a.path, detail, score });
    }
  } else {
    // No words: only the counts, for the sheet's header.
    for (const f of files) {
      counts.script++;
      counts.code += f.symbols.length;
    }
    for (const a of assets) counts[assetGroup(a.kind)]++;
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.path.localeCompare(b.path));
  return { hits: hits.slice(0, opts.limit ?? 60), counts, files: files.length, assets: assets.length };
}

/**
 * Where a name is defined in a project (for go-to-definition in the Source view).
 *
 * @param root - The project folder.
 * @param name - A class or function name (`A::B` is read as B).
 * @returns The definitions, at most 20.
 */
export async function definitionsOf(root: string, name: string): Promise<Array<{ path: string; line: number; symbol: string }>> {
  const want = name.replace(/\(\)$/, "").split("::").pop()!.trim();
  if (!want) return [];
  const { files } = await projectIndex(root);
  const out: Array<{ path: string; line: number; symbol: string }> = [];
  for (const f of files) f.symbols.forEach((s, i) => bare(s) === want && out.length < 20 && out.push({ path: f.path, line: f.lines[i]!, symbol: s }));
  return out;
}

/**
 * An Unreal package's references for the model: its class and parent, the /Game packages it uses and those that use
 * it (read from the headers, no engine).
 *
 * @param root - The project folder.
 * @param rel - The package's file (Content/…/X.uasset).
 * @returns Lines, or "" for a file that is not an Unreal package.
 */
export async function unrealAssetText(root: string, rel: string): Promise<string> {
  const pkg = packageNameOf(rel);
  if (!pkg) return "";
  const info = await unrealAssetInfo(join(root, rel));
  if (info?.cloudOnly) return `${pkg}: only in OneDrive (not downloaded on this computer), so it was not read.`;
  if (!info?.className) return "";
  const { assets } = await projectIndex(root);
  await withUnrealKinds(root, assets, 4000);
  const { users, complete } = usersOf(root, assets, pkg);
  const list = (xs: string[]) => (xs.length ? xs.slice(0, 15).map((x) => packageFileOf(x) ?? x).join(", ") + (xs.length > 15 ? ` (+${xs.length - 15})` : "") : "none");
  return [
    `${pkg}: ${info.className}${info.parent ? `, parent ${info.parent}` : ""}`,
    `  uses: ${list(info.uses)}${info.soft.length ? `; soft: ${list(info.soft)}` : ""}`,
    `  used by: ${list(users.map((u) => u.path.replace(/\.(uasset|umap)$/i, "")))}${complete ? "" : " (not all files read yet)"}`,
  ].join("\n");
}

/** The kind words a model may pass to game_find, in English. */
const KIND_ARG: Record<string, HitKind> = { code: "code", symbol: "code", class: "code", function: "code", script: "script", file: "script", scene: "scene", level: "scene", prefab: "prefab", blueprint: "prefab", asset: "asset" };

/**
 * One results list as text for the model.
 *
 * @param r - A project's search answer.
 * @returns Lines like `code  class Player · C#  Assets/Scripts/Player.cs:12`.
 */
export function hitsText(r: GameSearch): string {
  return r.hits.map((h) => `${h.kind.padEnd(6)} ${h.name} (${h.detail})  ${h.path}${h.line ? `:${h.line}` : ""}`).join("\n");
}

/**
 * The chat tool `game_find`: searches the user's Unity, Unreal and Godot projects (the ones found on this computer)
 * for classes, functions, scripts, scenes, prefabs, Blueprints and assets, with the engine closed.
 *
 * @param found - The projects found on this computer.
 * @param current - The project in use in this chat or on the engine pages (its folder or name), to search first.
 * @returns The tool.
 */
export function gameFindTool(found: () => Promise<GameProject[]>, current: () => string | undefined): AgentTool {
  return {
    risk: "read",
    spec: {
      name: "game_find",
      description:
        "Search the user's game projects (Unity, Unreal, Godot) with the engine closed: classes and functions (file:line), C#/C++/GDScript/Verse scripts, scenes and levels, prefabs and Blueprints, materials, textures and other assets. Unreal .uasset/.umap results carry their class (and a Blueprint's parent) read from the file; an exact Unreal asset name also lists what it uses and what uses it. Give `query` (names or kinds, e.g. 'Player', 'BP_Door', 'enemy prefab', 'main scene'); `project` (a name, else the one in use or all); `kind` to narrow (code, script, scene, prefab, asset). Then read the file you need. No query: what each project holds.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Names or kinds to find." },
          project: { type: "string", description: "A project name (as listed), when there are several." },
          kind: { type: "string", enum: ["code", "script", "scene", "prefab", "asset"] },
        },
      },
    },
    async run(input) {
      const query = typeof input.query === "string" ? input.query.slice(0, 200) : "";
      const want = typeof input.project === "string" ? input.project.trim().toLowerCase() : "";
      const kind = KIND_ARG[String(input.kind ?? "").toLowerCase()];
      const all = await found();
      if (!all.length) return { output: "No Unity, Unreal or Godot projects were found on this computer." };
      const cur = current()?.toLowerCase();
      const isCur = (p: GameProject) => !!cur && (p.path.toLowerCase() === cur || p.name.toLowerCase() === cur || cur.startsWith(p.path.toLowerCase()));
      const chosen = want ? all.filter((p) => p.name.toLowerCase() === want || p.path.toLowerCase() === want) : all.filter(isCur);
      if (want && !chosen.length) return { output: `No project named "${input.project}". Projects: ${all.map((p) => `${p.name} (${p.kind})`).join(", ")}` };
      const list = (chosen.length ? chosen : all).slice(0, 6);
      const parts: string[] = [];
      for (const p of list) {
        const r = await searchGameProject(p.path, query, { ...(kind ? { kind } : {}), limit: list.length > 1 ? 25 : 60 });
        const head = `## ${p.name} (${p.kind}${p.engine ? ` ${p.engine}` : ""})`;
        if (!query.trim()) parts.push(`${head}: ${r.files} scripts, ${r.counts.code} classes/functions, ${r.counts.scene} scenes/levels, ${r.counts.prefab} prefabs/Blueprints, ${r.counts.asset} other assets.`);
        else {
          const best = r.hits[0];
          const more = p.kind === "unreal" && best && best.score >= 100 ? await unrealAssetText(p.path, best.path) : "";
          parts.push(`${head}\n${r.hits.length ? hitsText(r) : "Nothing matches."}${more ? `\n${more}` : ""}`);
        }
      }
      if (all.length > list.length && !want) parts.push(`(Searched ${list.map((p) => p.name).join(", ")}; others: ${all.filter((p) => !list.includes(p)).map((p) => p.name).slice(0, 20).join(", ")})`);
      return { output: parts.join("\n\n") };
    },
  };
}
