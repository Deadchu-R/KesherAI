import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Agents: named helpers the chat's model hands work to by their description (like Claude Code's subagents and
 * Codex's custom agents). They come from personas that say when to use them, and from a project's agent files:
 * `.kesher/agents/*.md`, and `.claude/agents/*.md` in Claude Code's format, so agents a project already has work.
 * An agent runs as a `delegate` helper: own context, read-only tools, its own instructions and model.
 */

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
  source: "persona" | "project";
  /** A worker: it may change files, in its own copy of the project (a git worktree); its changes come back as a diff. */
  write?: boolean;
}

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
  const raw = fields.tools ? list(fields.tools) : [];
  const tools = fields.tools ? [...new Set(raw.flatMap((t) => CLAUDE_TOOLS[t.toLowerCase()] ?? [t]))] : undefined;
  // Claude Code's Edit / Write (or KesherAI's edit_file / write_file) make a worker.
  const write = raw.some((t) => /^(edit|write|multiedit|edit_file|write_file)$/i.test(t));
  return { name, description, instructions, ...(model ? { model } : {}), ...(tools?.length ? { tools } : {}), ...(write ? { write: true } : {}), source: "project" };
}

const cache = new Map<string, { at: number; agents: AgentDef[] }>();

/**
 * A project's agent files (`.kesher/agents`, then `.claude/agents`; the first of a name wins), read again after
 * 30 seconds. At most 20 files of 64 KB each.
 *
 * @param workspace - The project's folder.
 */
export function projectAgents(workspace: string | undefined): AgentDef[] {
  if (!workspace) return [];
  const hit = cache.get(workspace);
  if (hit && Date.now() - hit.at < 30_000) return hit.agents;
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
        if (a && !out.some((x) => x.name.toLowerCase() === a.name.toLowerCase())) out.push(a);
      } catch {
        /* unreadable: skipped */
      }
    }
  }
  cache.set(workspace, { at: Date.now(), agents: out });
  return out;
}
