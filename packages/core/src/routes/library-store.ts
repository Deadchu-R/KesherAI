import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PROMPT_TEMPLATES } from "../prompts.js";
import { PERSONA_TEMPLATES } from "../personas.js";

/** The shared library in the main repository: prompts, personas and skills checked by the project. */
const LIBRARY_URL = "https://raw.githubusercontent.com/Deadchu-R/KesherAI/main/community/library.json";

interface Library {
  prompts: Array<{ command: string; title: string; text: string }>;
  personas: Array<{ name: string; icon?: string; instructions: string }>;
  skills: Array<{ source: string; name: string; description: string }>;
}

/**
 * The store's second half: prompts, personas and skills. `official` is the
 * project's library (community/library.json); `community` is any public
 * GitHub repository with the topic `kesherai-skill`, not checked.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function libraryStoreRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  let cached: { at: number; value: unknown } | undefined;
  app.get("/api/library/catalog", async () => {
    if (cached && Date.now() - cached.at < 10 * 60_000) return mark(cached.value as Awaited<ReturnType<typeof load>>);
    const value = await load();
    cached = { at: Date.now(), value };
    return mark(value);
  });

  async function load() {
    const official: Library = await fetch(LIBRARY_URL, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? (r.json() as Promise<Library>) : Promise.reject(new Error(String(r.status)))))
      .catch(() => ({
        prompts: PROMPT_TEMPLATES,
        personas: PERSONA_TEMPLATES,
        skills: ["unity-code-review", "hebrew-writing", "meeting-notes"].map((name) => ({ source: `Deadchu-R/KesherAI/community/skills/${name}`, name, description: "" })),
      }));
    type Repo = { full_name: string; description: string | null; stargazers_count: number; html_url: string; updated_at: string; owner?: { login: string } };
    const community = await fetch("https://api.github.com/search/repositories?q=topic:kesherai-skill&sort=stars&per_page=50", { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(10_000) })
      .then(async (r) => (r.ok ? (((await r.json()) as { items?: Repo[] }).items ?? []) : []))
      .catch(() => [] as Repo[]);
    return {
      official: { prompts: official.prompts ?? [], personas: official.personas ?? [], skills: official.skills ?? [] },
      community: community.map((r) => ({ source: r.full_name, name: r.full_name.split("/")[1] ?? r.full_name, description: r.description ?? "", stars: r.stargazers_count, url: r.html_url, author: r.owner?.login ?? "" })),
    };
  }

  /** Marks what the user already has. */
  async function mark(v: Awaited<ReturnType<typeof load>>) {
    const prompts = new Set((await s.prompts.list()).map((p) => p.command));
    const personas = new Set((await s.personas.list()).map((p) => p.name.toLowerCase()));
    const skills = new Set((await s.skills.list()).map((k) => k.name));
    return {
      official: {
        prompts: v.official.prompts.map((p) => ({ ...p, have: prompts.has(p.command) })),
        personas: v.official.personas.map((p) => ({ ...p, have: personas.has(p.name.toLowerCase()) })),
        skills: v.official.skills.map((k) => ({ ...k, have: skills.has(k.name) })),
      },
      community: v.community.map((k) => ({ ...k, have: skills.has(k.name.toLowerCase()) })),
    };
  }
}
