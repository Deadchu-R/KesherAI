import { open, rm } from "node:fs/promises";

/**
 * Downloads one big file (the update installer) quickly and reliably:
 * several parts at once over HTTP ranges (GitHub's release servers allow
 * it), each part resumes where it stopped if the connection stalls or
 * drops, and the result must be exactly the expected size.
 *
 * @param url - The file.
 * @param file - Where to save it.
 * @param opts.size - Its size in bytes (from the release), to split it and check it.
 * @param opts.parts - How many at once (default 4).
 * @param opts.stallMs - No data for this long = reconnect that part (default 30 s).
 * @param opts.onProgress - Bytes so far, total, bytes per second.
 * @param opts.log - A line for the update log.
 */
export async function fastDownload(
  url: string,
  file: string,
  opts: { size: number; parts?: number; stallMs?: number; headers?: Record<string, string>; signal?: AbortSignal; fetchImpl?: typeof fetch; onProgress?: (got: number, total: number, bps: number) => void; log?: (line: string) => void },
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  let size = opts.size;
  // Size unknown: ask the server first (the release list sometimes leaves it out).
  if (!(size > 0)) {
    const head = await f(url, { method: "HEAD", headers: opts.headers ?? {}, ...(opts.signal ? { signal: opts.signal } : {}) }).catch(() => undefined);
    size = Number(head?.headers.get("content-length") ?? 0);
    if (!(size > 0)) throw new Error("Could not tell the size of the download.");
  }
  const log = opts.log ?? (() => undefined);
  const parts = size > 8 * 1024 * 1024 ? Math.max(1, Math.min(8, opts.parts ?? 4)) : 1;
  const stallMs = opts.stallMs ?? 30_000;
  const fh = await open(file, "w");
  const got: number[] = new Array(parts).fill(0);
  const started = Date.now();
  let lastShown = 0;
  const report = () => {
    const sum = got.reduce((a, b) => a + b, 0);
    const now = Date.now();
    if (now - lastShown < 400 && sum < size) return;
    lastShown = now;
    opts.onProgress?.(sum, size, sum / Math.max(0.001, (now - started) / 1000));
  };
  try {
    const span = Math.ceil(size / parts);
    await Promise.all(
      Array.from({ length: parts }, async (_, i) => {
        const from = i * span;
        const to = Math.min(size, from + span) - 1;
        for (let attempt = 1; ; attempt++) {
          const at = from + got[i]!;
          if (at > to) return;
          const stall = new AbortController();
          let timer = setTimeout(() => stall.abort(), stallMs);
          try {
            const res = await f(url, {
              headers: { ...opts.headers, ...(parts > 1 || at > 0 ? { range: `bytes=${at}-${to}` } : {}) },
              signal: AbortSignal.any([stall.signal, ...(opts.signal ? [opts.signal] : [])]),
            });
            if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
            // A server that ignores ranges sends the whole file: only one part can use that.
            if ((parts > 1 || at > 0) && res.status !== 206) throw new Error("the server does not resume downloads");
            let pos = at;
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              clearTimeout(timer);
              timer = setTimeout(() => stall.abort(), stallMs);
              const take = chunk.subarray(0, Math.max(0, to + 1 - pos));
              await fh.write(take, 0, take.length, pos);
              pos += take.length;
              got[i] = pos - from;
              report();
            }
            clearTimeout(timer);
            if (from + got[i]! > to) return;
            throw new Error("the connection closed early");
          } catch (err) {
            clearTimeout(timer);
            if (opts.signal?.aborted) throw new Error("Stopped.");
            const why = stall.signal.aborted ? `no data for ${Math.round(stallMs / 1000)} s` : (err as Error).message;
            if (attempt >= 6 || /does not resume/.test(why)) throw new Error(`Part ${i + 1} failed: ${why}.`);
            log(`part ${i + 1}: ${why}; trying again from ${Math.round((from + got[i]!) / 1048576)} MB (attempt ${attempt + 1})`);
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }),
    );
    const total = got.reduce((a, b) => a + b, 0);
    if (total !== size) throw new Error(`The download is ${total} bytes, not ${size}.`);
    report();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw err;
  }
  await fh.close();
}

/** Takes secrets out of a log line: access tokens, keys and passwords in addresses or headers. */
export function redact(line: string): string {
  return line
    .replace(/([?&](?:token|key|access_token|code|sig|signature)=)[^&\s"]+/gi, "$1…")
    .replace(/\b(Bearer|token)\s+[\w.~+/-]{8,}/gi, "$1 …")
    .replace(/\b(kd_|kai-|ghp_|github_pat_|sk-)[\w-]{6,}/g, "$1…")
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, "://…@");
}
