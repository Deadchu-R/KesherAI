/**
 * OpenRouter's free tier, for the task inbox's free coder: the day's request count from `GET /api/v1/key`
 * (`free_model_daily_requests`), when the account reports it. Never sends anything but the key to OpenRouter itself.
 */

/** The free tier's day: requests used, the day's limit and what is left. */
export interface FreeUsage {
  used: number;
  limit: number;
  remaining: number;
}

/** The first UTC midnight after `now` (ms): when the free requests reset. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Reads today's free-model request count from OpenRouter.
 *
 * @param apiKey - The user's OpenRouter key (from the saved connection; sent only as the bearer header).
 * @param fetchFn - `fetch`, replaceable for tests.
 * @param baseUrl - The API root (default OpenRouter's).
 * @returns The count, or undefined when the answer is not OK or does not carry it (the caller then counts locally).
 */
export async function fetchFreeUsage(apiKey: string, fetchFn: typeof fetch = fetch, baseUrl = "https://openrouter.ai/api/v1"): Promise<FreeUsage | undefined> {
  try {
    const res = await fetchFn(`${baseUrl}/key`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { free_model_daily_requests?: Partial<FreeUsage> }; free_model_daily_requests?: Partial<FreeUsage> };
    const f = json.data?.free_model_daily_requests ?? json.free_model_daily_requests;
    if (!f || !Number.isFinite(f.used) || !Number.isFinite(f.limit)) return undefined;
    const used = Math.max(0, Number(f.used));
    const limit = Math.max(0, Number(f.limit));
    return { used, limit, remaining: Number.isFinite(f.remaining) ? Math.max(0, Number(f.remaining)) : Math.max(0, limit - used) };
  } catch {
    return undefined;
  }
}
