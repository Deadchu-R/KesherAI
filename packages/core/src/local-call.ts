/**
 * Calls one of KesherAI's own routes over 127.0.0.1, as this computer would.
 * Used instead of Fastify's `inject`, which fails in the packaged app (its
 * cookie helper is an ES module that cannot be required there).
 *
 * @param port - The port KesherAI listens on.
 * @param method - GET or POST.
 * @param path - The route, e.g. `/api/self-work`.
 * @param body - A JSON body for POST.
 * @returns The status and the parsed answer (an empty object when it is not JSON).
 */
export async function localCall<T = unknown>(port: number, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
}
