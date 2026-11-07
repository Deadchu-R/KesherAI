import { categoryForPipelineTag, type CategoryId } from "@kesher/shared";

/** Hugging Face, or a mirror set with `HF_ENDPOINT` (the variable Hugging Face's own tools use). */
const HF = (process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "");

/** One search result from the Hugging Face Hub. */
export interface HubModel {
  /** Repo id, e.g. `city96/FLUX.1-dev-gguf`. */
  repo: string;
  /** KesherAI category derived from the repo's `pipeline_tag`, if any. */
  category?: CategoryId;
  pipelineTag?: string;
  downloads: number;
  likes: number;
  /** `true` (or `"auto"`/`"manual"`) when the repo requires accepting a licence first. */
  gated: boolean | string;
  tags: string[];
  /** Author or organisation (the part before the slash). */
  author: string;
  /** ISO date the repo was created on the Hub. */
  createdAt?: string;
  /** ISO date of the last change. */
  lastModified?: string;
  /** Hugging Face's trending score (recent likes). */
  trendingScore?: number;
  /** Library, e.g. `gguf`, `diffusers`, `transformers`. */
  library?: string;
  /** Licence from the model card, e.g. `apache-2.0`. */
  license?: string;
  /** Model it is based on, from the model card. */
  baseModel?: string;
  /** Size from the name, e.g. `8B`, when it says so. */
  parameters?: string;
}

/** How {@link searchHub} sorts results. */
export type HubSort = "downloads" | "likes" | "trending" | "created" | "modified";

const SORT_FIELD: Record<HubSort, string> = {
  downloads: "downloads",
  likes: "likes",
  trending: "trendingScore",
  created: "createdAt",
  modified: "lastModified",
};

/** One file in a Hub repo. */
export interface HubFile {
  /** Path inside the repo, e.g. `flux1-dev-Q4_K_S.gguf`. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** SHA-256 of the file when it is stored with Git LFS (all large model files are). */
  sha256?: string;
  /** Direct download URL. */
  url: string;
}

/** Options for {@link searchHub}. */
export interface HubSearchOptions {
  /** Free-text search. */
  search?: string;
  /** Restrict to one Hugging Face pipeline tag, e.g. `text-to-image`. */
  pipelineTag?: string;
  /** Restrict to a library or format tag, e.g. `gguf`, `diffusers`. */
  filter?: string;
  /** Max results (default 30). */
  limit?: number;
  /** Sort order, newest or biggest first (default `downloads`). */
  sort?: HubSort;
  /** Hugging Face access token, for gated or private repos. */
  token?: string;
  signal?: AbortSignal;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

interface RawHubModel {
  id: string;
  pipeline_tag?: string;
  downloads?: number;
  likes?: number;
  gated?: boolean | string;
  tags?: string[];
  createdAt?: string;
  lastModified?: string;
  trendingScore?: number;
  library_name?: string;
  cardData?: { license?: string | string[]; base_model?: string | string[] };
}

const EXPAND = ["downloads", "likes", "gated", "tags", "pipeline_tag", "createdAt", "lastModified", "trendingScore", "library_name", "cardData"];

/** Reads the size from a repo name: "Qwen3-8B-GGUF" → "8B", "Qwen3-30B-A3B" → "30B". */
export function parametersFromName(repo: string): string | undefined {
  const m = /(?:^|[-_./])(\d+(?:\.\d+)?)([BM])(?=$|[-_.])/i.exec(repo.split("/").pop() ?? repo);
  return m ? `${m[1]}${m[2]!.toUpperCase()}` : undefined;
}

function toHubModel(m: RawHubModel): HubModel {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const license = first(m.cardData?.license) ?? m.tags?.find((t) => t.startsWith("license:"))?.slice(8);
  const baseModel = first(m.cardData?.base_model);
  const parameters = parametersFromName(m.id);
  return {
    repo: m.id,
    author: m.id.split("/")[0] ?? "",
    category: categoryForPipelineTag(m.pipeline_tag),
    pipelineTag: m.pipeline_tag,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    gated: m.gated ?? false,
    tags: m.tags ?? [],
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(m.lastModified ? { lastModified: m.lastModified } : {}),
    ...(m.trendingScore !== undefined ? { trendingScore: m.trendingScore } : {}),
    ...(m.library_name ? { library: m.library_name } : {}),
    ...(license ? { license } : {}),
    ...(baseModel ? { baseModel } : {}),
    ...(parameters ? { parameters } : {}),
  };
}

/**
 * Searches the Hub.
 *
 * @param opts - Search options.
 * @returns Matching models.
 *
 * @example
 * ```ts
 * const results = await searchHub({ search: "flux", filter: "gguf", sort: "likes" });
 * ```
 */
export async function searchHub(opts: HubSearchOptions = {}): Promise<HubModel[]> {
  const params = new URLSearchParams({ sort: SORT_FIELD[opts.sort ?? "downloads"], direction: "-1", limit: String(opts.limit ?? 30) });
  if (opts.search) params.set("search", opts.search);
  if (opts.pipelineTag) params.set("pipeline_tag", opts.pipelineTag);
  if (opts.filter) params.set("filter", opts.filter);
  const withExpand = new URLSearchParams(params);
  for (const e of EXPAND) withExpand.append("expand[]", e);

  let res = await fetch(`${HF}/api/models?${withExpand}`, { headers: authHeaders(opts.token), signal: opts.signal });
  // If the Hub ever rejects the extra fields, the plain search still works.
  if (res.status === 400) res = await fetch(`${HF}/api/models?${params}`, { headers: authHeaders(opts.token), signal: opts.signal });
  if (!res.ok) throw new Error(`Hugging Face search failed: ${res.status} ${res.statusText}`);
  return ((await res.json()) as RawHubModel[]).map(toHubModel);
}

const summaries = new Map<string, string>();

/**
 * A short description of a model from its model card (README.md): the
 * first paragraphs of text, without the metadata block, headings, images,
 * badges, links and tables.
 *
 * @param repo - Repo id.
 * @param opts - Token for gated repos.
 * @returns Up to about 600 characters, or an empty string if the card has no text.
 */
export async function modelSummary(repo: string, opts: { token?: string; signal?: AbortSignal } = {}): Promise<string> {
  const cached = summaries.get(repo);
  if (cached !== undefined) return cached;
  const res = await fetch(`${HF}/${repo}/raw/main/README.md`, { headers: authHeaders(opts.token), signal: opts.signal });
  const text = res.ok ? summarizeCard(await res.text()) : "";
  summaries.set(repo, text);
  return text;
}

/**
 * Turns a model card into a short plain-text summary.
 *
 * @param md - README.md.
 * @param max - Character budget.
 * @returns Plain text.
 */
export function summarizeCard(md: string, max = 600): string {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  const paragraphs: string[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b || /^(#|\||<|!\[|```|>|\[!\[|- \[|\* \[)/.test(b)) continue;
    const plain = b
      .replace(/<[^>]+>/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length < 30) continue;
    paragraphs.push(plain);
    if (paragraphs.join(" ").length >= max) break;
  }
  const out = paragraphs.join("\n\n");
  return out.length > max ? `${out.slice(0, max).replace(/\s+\S*$/, "")}…` : out;
}

/**
 * Lists every file in a repo (recursively), with size and SHA-256.
 *
 * @param repo - Repo id.
 * @param opts - `revision` (default `main`), `token`, `signal`.
 * @returns The repo's files.
 */
export async function listHubFiles(
  repo: string,
  opts: { revision?: string; token?: string; signal?: AbortSignal } = {},
): Promise<HubFile[]> {
  const revision = opts.revision ?? "main";
  const res = await fetch(`${HF}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`, {
    headers: authHeaders(opts.token),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Could not list files of ${repo}: ${res.status} ${res.statusText}`);
  const entries = (await res.json()) as Array<{ type: string; path: string; size: number; lfs?: { oid: string; size: number } }>;
  return entries
    .filter((e) => e.type === "file")
    .map((e) => ({
      path: e.path,
      size: e.lfs?.size ?? e.size,
      ...(e.lfs ? { sha256: e.lfs.oid } : {}),
      url: `${HF}/${repo}/resolve/${encodeURIComponent(revision)}/${e.path.split("/").map(encodeURIComponent).join("/")}`,
    }));
}

/**
 * Whether a file is a model-weights format that can run code when loaded
 * (Python pickle). The UI warns before downloading these.
 *
 * @param path - File path.
 * @returns `true` for `.ckpt`, `.pt`, `.pth`, `.bin`, `.pkl`.
 */
export function isPickleFormat(path: string): boolean {
  return /\.(ckpt|pt|pth|bin|pkl)$/i.test(path);
}
