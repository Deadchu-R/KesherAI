/**
 * Reads a Server-Sent Events stream and yields the payload of every
 * `data:` field. Comment lines, `event:` and `id:` fields are ignored,
 * and multi-line `data:` fields are joined with `\n`, as the SSE spec says.
 *
 * @param body - The `ReadableStream` of a `fetch` response.
 * @returns An async iterator of `data` payloads, one per event.
 *
 * @example
 * ```ts
 * for await (const data of readSSE(res.body!)) {
 *   if (data === "[DONE]") break;
 *   console.log(JSON.parse(data));
 * }
 * ```
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (dataLines.length > 0) yield dataLines.join("\n");
        dataLines = [];
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  if (dataLines.length > 0) yield dataLines.join("\n");
}

/** An error from a non-2xx answer: the status and the rate-limit headers the server sent (never the request's own headers). */
export interface HttpError extends Error {
  /** The HTTP status. */
  status: number;
  /** `retry-after` and the `x-ratelimit-*` / `ratelimit-*` headers of the answer, lower-cased. */
  rateHeaders: Record<string, string>;
}

/**
 * The headers of an answer that say how long to wait or how much is left (`retry-after`, `x-ratelimit-*`, `ratelimit-*`).
 *
 * @param headers - The answer's headers.
 * @returns Those headers, lower-cased.
 */
export function rateHeadersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (key === "retry-after" || key.startsWith("x-ratelimit-") || key.startsWith("ratelimit-")) out[key] = v.slice(0, 80);
  });
  return out;
}

/**
 * `fetch` that throws a readable error for non-2xx responses, including the
 * start of the response body (servers usually explain the problem there).
 * The error is an {@link HttpError}: it carries the status and the rate-limit headers.
 *
 * @param url - Request URL.
 * @param init - Standard `fetch` options.
 * @returns The response, guaranteed `ok`.
 */
export async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`${init?.method ?? "GET"} ${url} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`), { status: res.status, rateHeaders: rateHeadersOf(res.headers) }) as HttpError;
  }
  return res;
}
