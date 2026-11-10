/**
 * LM Studio loads a model with a small context by default (often 4096
 * tokens): enough for a chat, far too little for a coding agent, whose
 * instructions and tools alone are several thousand tokens (self-work's first
 * runs failed with "500 Internal Server Error" from LM Studio for this). Before
 * long work this asks LM Studio's own API (`/api/v1/models`) how the model is
 * loaded and, when its context is too small, loads it again with a bigger one
 * (`/api/v1/models/unload` then `/load`).
 */

interface LmsModel { key: string; max_context_length?: number | null; loaded_instances?: Array<{ id: string; config?: { context_length?: number } }> }

/** The server's root (`http://localhost:1234`) from a provider's `/v1` URL. */
export const lmStudioRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * Makes sure an LM Studio model is loaded with at least `want` tokens of context.
 *
 * @returns What was there and what is there now; `undefined` when the server is not LM Studio (no such API) or does not know the model.
 */
export async function ensureLmStudioContext(baseUrl: string, model: string, want: number, apiKey?: string, f: typeof fetch = fetch): Promise<{ before?: number; after: number; reloaded: boolean } | undefined> {
  const root = lmStudioRoot(baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const list = await f(`${root}/api/v1/models`, { headers, signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? (r.json() as Promise<{ models?: LmsModel[] }>) : undefined), () => undefined);
  const m = list?.models?.find((x) => x.key === model || x.loaded_instances?.some((i) => i.id === model));
  if (!m) return undefined;
  const loaded = m.loaded_instances ?? [];
  const before = loaded.length ? Math.max(...loaded.map((i) => i.config?.context_length ?? 0)) : undefined;
  const target = Math.min(want, m.max_context_length || want);
  if (before !== undefined && before >= target) return { before, after: before, reloaded: false };
  // One copy at a time: the small one goes first (two copies of a 20 GB model would not fit).
  for (const i of loaded) await f(`${root}/api/v1/models/unload`, { method: "POST", headers, body: JSON.stringify({ instance_id: i.id }), signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
  const r = await f(`${root}/api/v1/models/load`, { method: "POST", headers, body: JSON.stringify({ model: m.key, context_length: target, flash_attention: true, echo_load_config: true }), signal: AbortSignal.timeout(600_000) });
  if (!r.ok) throw new Error(`LM Studio could not load ${m.key} with ${target} tokens of context (${r.status}).`);
  const j = (await r.json().catch(() => ({}))) as { load_config?: { context_length?: number } };
  return { ...(before !== undefined ? { before } : {}), after: j.load_config?.context_length ?? target, reloaded: true };
}
