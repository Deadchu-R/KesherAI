import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HelperKind, SpecialistId } from "@kesher/shared";

/**
 * Agents: named helpers the chat's model hands work to by their description (like Claude Code's subagents and
 * Codex's custom agents). They come from personas that say when to use them, and from a project's agent files:
 * `.kesher/agents/*.md`, and `.claude/agents/*.md` in Claude Code's format, so agents a project already has work.
 * An agent runs as a `delegate` helper: own context, read-only tools, its own instructions and model.
 *
 * Three helpers are built in (docs/RESEARCH_LOG.md, "Helper agents in the chat"): `lookup` (reads, a small model, 8
 * steps), `research` (reads and the web, the chat's model, 20 steps) and `build` (edits in its own copy of the
 * project, a strong model, 30 steps). Agent files may add `background`, `maxTurns` and `model: small|strong|inherit|auto`
 * (tiers, so one file works on any computer).
 */

/** A model by tier instead of an id: chosen on each computer by `pickHelperModel` (helper-model.ts). */
export type ModelTier = "auto" | "inherit" | "small" | "strong";

/** One agent the chat's model may use. */
export interface AgentDef {
  name: string;
  /** When to hand it work. */
  description: string;
  /** Its system prompt. */
  instructions: string;
  /** A KesherAI model id; absent = the chat's model. */
  model?: string;
  /** The tools it may use (KesherAI names); absent = all read-only tools. */
  tools?: string[];
  /** Where it was defined. */
  source: "persona" | "project" | "builtin";
  /** A worker: it may change files, in its own copy of the project (a git worktree); its changes come back as a diff. */
  write?: boolean;
  /** Its job type (built-in helpers; others are `lookup`, or `build` when they write). */
  kind?: HelperKind;
  /** A model by tier, when the file names one instead of an id. */
  tier?: ModelTier;
  /** Runs in the background: the chat goes on, the report comes when it ends. */
  background?: boolean;
  /** Its step cap (the last step only writes the report). */
  maxTurns?: number;
  /** Its time cap, in minutes. */
  maxMinutes?: number;
  /** The file it came from (project agents), relative to the project. */
  file?: string;
  /** An engine specialist (engine-specialists.ts): its own curated engine tools, which act with the user's approval. */
  specialist?: SpecialistId;
}

/** Steps per built-in type (the research plan, step 1). */
export const HELPER_STEPS: Record<Exclude<HelperKind, "external">, number> = { lookup: 8, research: 20, build: 30, operate: 25 };

/**
 * The built-in helpers. Their models come from Settings > Helpers (`pickHelperModel`), not from here.
 *
 * @param steps - Steps per type as set in Settings (default `HELPER_STEPS`).
 */
export function builtinHelpers(steps: Partial<Record<Exclude<HelperKind, "external">, number>> = {}): AgentDef[] {
  return [
    { name: "lookup", kind: "lookup", source: "builtin", tier: "auto", maxTurns: steps.lookup ?? HELPER_STEPS.lookup, description: "Find where something is in the project, read files and quote them, list matches. Read only. Fast and small.", instructions: "You look things up. Search and read only what the task needs, then report exact paths, line numbers, names and short quotes." },
    { name: "research", kind: "research", source: "builtin", tier: "auto", maxTurns: steps.research ?? HELPER_STEPS.research, description: "Read code and the web on one question and summarise it with sources. Read only.", instructions: "You research one question. Read the code and the web as needed. Report what you found with its sources (paths or links), what it means for the task, and what stays unclear." },
    { name: "build", kind: "build", source: "builtin", tier: "auto", write: true, maxTurns: steps.build ?? HELPER_STEPS.build, description: "Make one change in its own copy of the project (a git worktree) and run the project's tests there; the change comes back as a diff to review, with the test result. Only in a code chat on a git project.", instructions: "You build one change. Read what you need, make the change with write_file and edit_file, keep it small and in the style of the code around it, run the project's checks with run_tests, then report what you changed, why, and whether the checks passed." },
    { name: "operate", kind: "operate", source: "builtin", tier: "auto", maxTurns: steps.operate ?? HELPER_STEPS.operate, description: "Do one task in the user's browser or on the computer: open pages, click, type, control an app. Every action that changes something waits for the user's approval on a card that names it.", instructions: "You operate the browser and the computer for one task. Look first (read the page or take a screenshot), then act one step at a time; each click, typing or opened page waits for the user's approval. Never type passwords, keys or payment details: ask the assistant to have the user do that. Report what you did, what you saw, and anything left for the user." },
  ];
}

/** Claude Code's model names as tiers (`sonnet` and `inherit` mean the chat's model). */
const CLAUDE_TIERS: Record<string, ModelTier> = { haiku: "small", opus: "strong", small: "small", strong: "strong", auto: "auto", inherit: "inherit", sonnet: "inherit" };

/** Claude Code's tool names, as KesherAI's. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  edit: ["edit_file"],
  multiedit: ["edit_file"],
  write: ["write_file"],
  read: ["read_file", "view_image", "read_document"],
  grep: ["search", "find_symbol"],
  glob: ["list_files", "code_map"],
  ls: ["list_files"],
  websearch: ["web_search"],
  webfetch: ["web_fetch"],
};

/** A frontmatter value: "a, b" or "[a, b]" as a list. */
function list(v: string): string[] {
  return v.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * Reads one agent file: YAML frontmatter (`name`, `description`, optional `tools`, `model`) and the instructions
 * under it. Claude Code's tool and model names are mapped; a model KesherAI does not know means the chat's model.
 *
 * @param text - The file's text.
 * @param fallbackName - The file's name, when the frontmatter has none.
 * @returns The agent, or undefined when the file is not one.
 */
export function parseAgentFile(text: string, fallbackName: string): AgentDef | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  const name = (fields.name || fallbackName).trim().slice(0, 60);
  const description = (fields.description ?? "").slice(0, 500);
  const instructions = m[2]!.trim().slice(0, 20_000);
  if (!name || !description || !instructions) return undefined;
  const model = fields.model && fields.model.includes("/") ? fields.model : undefined;
  const tier = !model && fields.model ? CLAUDE_TIERS[fields.model.toLowerCase()] : undefined;
  const turns = Number(fields.maxturns ?? fields.steps);
  const minutes = Number(fields.maxminutes);
  const raw = fields.tools ? list(fields.tools) : [];
  const tools = fields.tools ? [...new Set(raw.flatMap((t) => CLAUDE_TOOLS[t.toLowerCase()] ?? [t]))] : undefined;
  // Claude Code's Edit / Write (or KesherAI's edit_file / write_file) make a worker.
  const write = raw.some((t) => /^(edit|write|multiedit|edit_file|write_file)$/i.test(t));
  return {
    name,
    description,
    instructions,
    ...(model ? { model } : {}),
    ...(tier && tier !== "inherit" ? { tier } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(write ? { write: true } : {}),
    ...(/^true$/i.test(fields.background ?? "") ? { background: true } : {}),
    ...(Number.isFinite(turns) && turns > 0 ? { maxTurns: Math.min(60, Math.round(turns)) } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { maxMinutes: Math.min(60, Math.round(minutes)) } : {}),
    source: "project",
  };
}

/** KesherAI's tool names back as Claude Code's, so a file saved here works in Claude Code too. */
const TO_CLAUDE: Record<string, string> = { read_file: "Read", search: "Grep", list_files: "Glob", web_search: "WebSearch", web_fetch: "WebFetch", edit_file: "Edit", write_file: "Write" };

/**
 * Writes an agent as a file (Settings > Helpers > New helper): the same frontmatter Claude Code reads, plus
 * KesherAI's own fields, so one file works in both.
 *
 * @param a - The agent (name, description, instructions; optional tools, model or tier, background, steps, minutes).
 * @returns The file's text.
 */
export function agentFileText(a: Pick<AgentDef, "name" | "description" | "instructions" | "tools" | "model" | "tier" | "background" | "maxTurns" | "maxMinutes">): string {
  const one = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const tools = a.tools?.length ? [...new Set(a.tools.map((t) => TO_CLAUDE[t] ?? t))] : undefined;
  return [
    "---",
    `name: ${one(a.name)}`,
    `description: ${one(a.description)}`,
    ...(tools ? [`tools: ${tools.join(", ")}`] : []),
    `model: ${a.model ?? a.tier ?? "auto"}`,
    ...(a.background ? ["background: true"] : []),
    ...(a.maxTurns ? [`maxTurns: ${a.maxTurns}`] : []),
    ...(a.maxMinutes ? [`maxMinutes: ${a.maxMinutes}`] : []),
    "---",
    a.instructions.trim(),
    "",
  ].join("\n");
}

const cache = new Map<string, { at: number; agents: AgentDef[] }>();

/**
 * A project's agent files (`.kesher/agents`, then `.claude/agents`; the first of a name wins), read again after
 * 30 seconds. At most 20 files of 64 KB each.
 *
 * @param workspace - The project's folder.
 * @param fresh - Read the files again now (after Settings saved one).
 */
export function projectAgents(workspace: string | undefined, fresh = false): AgentDef[] {
  if (!workspace) return [];
  const hit = cache.get(workspace);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.agents;
  const out: AgentDef[] = [];
  for (const dir of [join(workspace, ".kesher", "agents"), join(workspace, ".claude", "agents")]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (out.length >= 20) break;
      try {
        const f = join(dir, n);
        if (statSync(f).size > 64 * 1024) continue;
        const a = parseAgentFile(readFileSync(f, "utf8"), n.replace(/\.md$/, ""));
        if (a && !out.some((x) => x.name.toLowerCase() === a.name.toLowerCase())) out.push({ ...a, file: `${dir === join(workspace, ".kesher", "agents") ? ".kesher" : ".claude"}/agents/${n}` });
      } catch {
        /* unreadable: skipped */
      }
    }
  }
  cache.set(workspace, { at: Date.now(), agents: out });
  return out;
}
