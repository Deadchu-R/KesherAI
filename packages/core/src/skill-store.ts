import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { discoverSkills, loadSkillBody, parseSkillMarkdown, skillsPromptSection, type SkillSummary } from "@kesher/skills";
import type { AgentTool } from "@kesher/agent";

/**
 * Skills: folders with a SKILL.md (the open format Claude Code and others
 * use) that teach models how to do a kind of task. Models see each skill's
 * name and description and load one with `use_skill` when it fits.
 *
 * They live in KesherAI's skills folder; a code session also sees the
 * project's own `.claude/skills` and `.kesher/skills`. They can be written
 * here or installed from GitHub (only their files are copied; nothing runs).
 */

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 6 * 1024 * 1024;
const MAX_FILES = 120;

/** Where a GitHub skill is: `owner/repo`, `owner/repo/path`, or a github.com URL. */
export function parseSkillSource(source: string): { owner: string; repo: string; path: string; ref?: string } {
  const s = source.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/.exec(s);
  if (url) return { owner: url[1]!, repo: url[2]!, path: (url[4] ?? "").replace(/\/SKILL\.md$/i, ""), ...(url[3] ? { ref: url[3] } : {}) };
  const short = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(s);
  if (!short) throw new Error("Give a GitHub repository, like owner/repo, owner/repo/skills/name, or its github.com link.");
  return { owner: short[1]!, repo: short[2]!, path: (short[3] ?? "").replace(/\/SKILL\.md$/i, "") };
}

/** Keeps the user's skills. */
export class SkillStore {
  private cache?: { at: number; roots: string; list: SkillSummary[] };
  /** How many skills the last look found (models get `use_skill` only when there are some). */
  count = 0;

  /**
   * @param dir - KesherAI's skills folder.
   * @param fetcher - For tests.
   */
  constructor(
    private readonly dir: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private roots(workspace?: string): string[] {
    return [this.dir, ...(workspace ? [join(workspace, ".kesher", "skills"), join(workspace, ".claude", "skills")] : [])];
  }

  /**
   * @param workspace - A code session's project, whose own skills count too.
   * @returns The skills, by name.
   */
  async list(workspace?: string): Promise<Array<SkillSummary & { own: boolean }>> {
    const roots = this.roots(workspace);
    const key = roots.join("|");
    if (!this.cache || this.cache.roots !== key || Date.now() - this.cache.at > 10_000) this.cache = { at: Date.now(), roots: key, list: await discoverSkills(roots) };
    this.count = this.cache.list.length;
    return this.cache.list.map((s) => ({ ...s, own: resolve(s.dir).startsWith(resolve(this.dir) + sep) }));
  }

  /**
   * Writes a skill.
   *
   * @param input - Name, description and instructions.
   * @returns The skill's folder.
   */
  async save(input: { name: string; description: string; body: string }): Promise<string> {
    const name = input.name.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    if (!name) throw new Error("Give the skill a name.");
    if (!input.description.trim()) throw new Error("Say when to use the skill (its description); models choose skills by it.");
    const folder = join(this.dir, name);
    await mkdir(folder, { recursive: true });
    const desc = input.description.trim().replace(/\s+/g, " ").slice(0, 1000);
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${input.body.trim()}\n`);
    this.cache = undefined;
    return folder;
  }

  /** Deletes one of KesherAI's own skills (never a project's). */
  async remove(name: string): Promise<void> {
    const s = (await this.list()).find((x) => x.name === name && x.own);
    if (!s) throw new Error("No such skill in KesherAI's skills folder.");
    await rm(s.dir, { recursive: true, force: true });
    this.cache = undefined;
  }

  private async gh(path: string): Promise<unknown> {
    const r = await this.fetcher(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) throw new Error("Not found on GitHub (check the repository and path, and that it is public).");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
    return r.json();
  }

  /**
   * Installs skills from GitHub: the folder named, or every skill folder in
   * it (one level down). Copies their files; nothing runs.
   *
   * @param source - `owner/repo[/path]` or a github.com link.
   * @returns The names installed.
   */
  async install(source: string): Promise<string[]> {
    const { owner, repo, path, ref } = parseSkillSource(source);
    type Entry = { name: string; path: string; type: "file" | "dir"; size: number; download_url: string | null };
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const list = (p: string) => this.gh(`/repos/${owner}/${repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}${q}`) as Promise<Entry[] | Entry>;
    const top = await list(path);
    const entries = Array.isArray(top) ? top : [top];
    let folders: string[] = [];
    if (entries.some((e) => e.type === "file" && e.name.toUpperCase() === "SKILL.MD")) folders = [path];
    else {
      for (const d of entries.filter((e) => e.type === "dir").slice(0, 40)) {
        const inside = await list(d.path);
        if (Array.isArray(inside) && inside.some((e) => e.type === "file" && e.name.toUpperCase() === "SKILL.MD")) folders.push(d.path);
        else if (Array.isArray(inside) && d.name === "skills") {
          for (const sub of inside.filter((e) => e.type === "dir").slice(0, 40)) {
            const deeper = await list(sub.path);
            if (Array.isArray(deeper) && deeper.some((e) => e.type === "file" && e.name.toUpperCase() === "SKILL.MD")) folders.push(sub.path);
          }
        }
      }
    }
    if (!folders.length) throw new Error("No SKILL.md found there.");
    const installed: string[] = [];
    for (const folder of folders) {
      const files: Array<{ rel: string; url: string; size: number }> = [];
      const walk = async (p: string, depth: number) => {
        if (depth > 4 || files.length >= MAX_FILES) return;
        const items = await list(p);
        for (const e of Array.isArray(items) ? items : [items]) {
          if (e.type === "dir") await walk(e.path, depth + 1);
          else if (e.download_url && e.size <= MAX_FILE) files.push({ rel: relative(folder || ".", e.path), url: e.download_url, size: e.size });
        }
      };
      await walk(folder, 0);
      if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw new Error(`${folder || repo} is too big for a skill (over 6 MB).`);
      const md = files.find((f) => f.rel.toUpperCase() === "SKILL.MD");
      const text = md ? await (await this.fetcher(md.url, { signal: AbortSignal.timeout(15_000) })).text() : "";
      const { frontmatter } = parseSkillMarkdown(text);
      const name = (frontmatter.name ?? folder.split("/").pop() ?? repo).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60);
      if (!frontmatter.description) throw new Error(`${folder || repo}/SKILL.md has no description.`);
      const target = join(this.dir, name);
      await rm(target, { recursive: true, force: true });
      for (const f of files) {
        const dest = resolve(target, f.rel);
        if (!dest.startsWith(resolve(target) + sep)) continue;
        await mkdir(dirname(dest), { recursive: true });
        const data = f === md ? Buffer.from(text) : Buffer.from(await (await this.fetcher(f.url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer());
        await writeFile(dest, data);
      }
      await writeFile(join(target, ".kesher-source.json"), JSON.stringify({ source: `${owner}/${repo}/${folder}`.replace(/\/$/, ""), ref: ref ?? null, installedAt: new Date().toISOString() }));
      installed.push(name);
    }
    this.cache = undefined;
    return installed;
  }

  /**
   * The system-prompt lines that list the skills.
   *
   * @param workspace - The session's project, if any.
   * @returns The section, or an empty string.
   */
  async promptSection(workspace?: string): Promise<string> {
    const list = await this.list(workspace).catch(() => []);
    return list.length ? `${skillsPromptSection(list.slice(0, 60))}\nTo load one, call use_skill with its name.` : "";
  }

  /**
   * The `use_skill` tool.
   *
   * @returns The tool.
   */
  tool(): AgentTool {
    return {
      risk: "read",
      spec: {
        name: "use_skill",
        description: "Load a skill's instructions (see the list of available skills) when it fits the task, then follow them. A skill may come with more files: pass `file` to read one of them.",
        inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string", description: "A file in the skill's folder, as listed." } }, required: ["name"] },
      },
      run: async (input, ctx) => {
        const s = (await this.list(ctx.workspace)).find((x) => x.name === String(input.name ?? ""));
        if (!s) return { output: `No skill named "${String(input.name)}". Skills: ${(await this.list(ctx.workspace)).map((x) => x.name).join(", ") || "none"}.` };
        if (typeof input.file === "string" && input.file.trim()) {
          const p = resolve(s.dir, input.file);
          if (!p.startsWith(resolve(s.dir) + sep)) throw new Error("That file is not in the skill's folder.");
          const st = await stat(p);
          if (st.size > 400_000) throw new Error("That file is too big to read here.");
          return { output: await readFile(p, "utf8") };
        }
        const others: string[] = [];
        const walk = async (d: string, depth: number) => {
          for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (e.name.startsWith(".") || others.length > 60) continue;
            const full = join(d, e.name);
            if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
            else if (e.isFile() && e.name !== "SKILL.md") others.push(relative(s.dir, full).split(sep).join("/"));
          }
        };
        await walk(s.dir, 0);
        return { output: `# Skill: ${s.name}\n\n${await loadSkillBody(s)}${others.length ? `\n\n(Files in this skill: ${others.join(", ")} — read one with use_skill { name, file }.)` : ""}` };
      },
    };
  }
}
