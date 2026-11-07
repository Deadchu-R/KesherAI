import { categoryForPipelineTag, type CategoryId } from "@kesher/shared";

const HF = "https://huggingface.co";

/** One search result from the Hugging Face Hub. */
export interface HubModel {
  /** Repo id, e.g. `city96/FLUX.1-dev-gguf`. */
  repo: string;
  /** Kesher category derived from the repo's `pipeline_tag`, if any. */
  category?: CategoryId;
  pipelineTag?: string;
  downloads: number;
  likes: number;
  /** `true` (or `"auto"`/`"manual"`) when the repo requires accepting a licence first. */
  gated: boolean | string;
  tags: string[];
}

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
  /** Hugging Face access token, for gated or private repos. */
  token?: string;
  signal?: AbortSignal;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Searches the Hub, most downloaded first.
 *
 * @param opts - Search options.
 * @returns Matching models.
 *
 * @example
 * ```ts
 * const results = await searchHub({ search: "flux", filter: "gguf" });
 * ```
 */
export async function searchHub(opts: HubSearchOptions = {}): Promise<HubModel[]> {
  const params = new URLSearchParams({ sort: "downloads", direction: "-1", limit: String(opts.limit ?? 30) });
  if (opts.search) params.set("search", opts.search);
  if (opts.pipelineTag) params.set("pipeline_tag", opts.pipelineTag);
  if (opts.filter) params.set("filter", opts.filter);

  const res = await fetch(`${HF}/api/models?${params}`, { headers: authHeaders(opts.token), signal: opts.signal });
  if (!res.ok) throw new Error(`Hugging Face search failed: ${res.status} ${res.statusText}`);
  const items = (await res.json()) as Array<{
    id: string;
    pipeline_tag?: string;
    downloads?: number;
    likes?: number;
    gated?: boolean | string;
    tags?: string[];
  }>;
  return items.map((m) => ({
    repo: m.id,
    category: categoryForPipelineTag(m.pipeline_tag),
    pipelineTag: m.pipeline_tag,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    gated: m.gated ?? false,
    tags: m.tags ?? [],
  }));
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
