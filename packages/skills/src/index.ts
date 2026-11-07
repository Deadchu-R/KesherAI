/**
 * `@kesher/skills` — discover and load `SKILL.md` skills.
 *
 * @packageDocumentation
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A skill's summary — what models see before choosing to load it. */
export interface SkillSummary {
  /** From the frontmatter `name`; falls back to the folder name. */
  name: string;
  /** From the frontmatter `description`. Models choose skills by this text. */
  description: string;
  /** Absolute path of the skill folder. */
  dir: string;
  /** Any other frontmatter keys, kept as strings. */
  meta: Record<string, string>;
}

/**
 * Splits a `SKILL.md` into frontmatter and body. Supports the simple
 * `key: value` YAML that skills use (quoted or not, one line per key).
 *
 * @param text - Full file contents.
 * @returns Frontmatter keys and the Markdown body.
 */
export function parseSkillMarkdown(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    frontmatter[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { frontmatter, body: match[2]!.trim() };
}

/**
 * Lists the skills in one or more folders. Folders that do not exist are
 * skipped; a skill folder without a valid `SKILL.md` is skipped too.
 *
 * @param roots - Folders whose sub-folders are skills.
 * @returns Skill summaries, sorted by name. On a name clash the first root wins.
 */
export async function discoverSkills(roots: string[]): Promise<SkillSummary[]> {
  const byName = new Map<string, SkillSummary>();
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const { frontmatter } = parseSkillMarkdown(text);
      const { name = entry.name, description = "", ...meta } = frontmatter;
      if (!description || byName.has(name)) continue;
      byName.set(name, { name, description, dir, meta });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Loads a skill's instructions, to put into a model's context once it has
 * chosen the skill.
 *
 * @param skill - A summary from {@link discoverSkills}.
 * @returns The Markdown body of its `SKILL.md`, without frontmatter.
 */
export async function loadSkillBody(skill: SkillSummary): Promise<string> {
  return parseSkillMarkdown(await readFile(join(skill.dir, "SKILL.md"), "utf8")).body;
}

/**
 * Formats skill summaries as a system-prompt section, the way KesherAI tells a
 * model which skills exist.
 *
 * @param skills - Summaries to list.
 * @returns Markdown text, or an empty string when there are no skills.
 */
export function skillsPromptSection(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `Available skills (ask to load one by name when it fits the task):\n${lines.join("\n")}`;
}
