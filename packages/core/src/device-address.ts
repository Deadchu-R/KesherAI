/**
 * Finding another computer fast: the address that worked last time is tried first (a short wait), and only when
 * it does not answer are all the published addresses tried at once. Pure logic around a `probe` function, so it
 * is tested without a network.
 */

/** How long the last-known address gets before the others are tried too. */
export const LAST_ADDRESS_MS = 2500;

/**
 * Puts the last-known address first (when it is still one of the computer's published addresses; a stale or
 * foreign address is never tried, so a changed network or a planted entry cannot redirect the connection).
 *
 * @param urls - The addresses the computer published, best first.
 * @param last - The address that answered last time.
 * @returns The addresses to try, last-known first, each once.
 */
export function addressOrder(urls: string[], last: string | undefined): string[] {
  const clean = [...new Set(urls.map((u) => u.replace(/\/$/, "")))];
  const l = last?.replace(/\/$/, "");
  return l && clean.includes(l) ? [l, ...clean.filter((u) => u !== l)] : clean;
}

/**
 * Finds the first address that answers: the last-known one alone first (up to {@link LAST_ADDRESS_MS}), then every
 * address at once, the first to answer wins.
 *
 * @param urls - The addresses the computer published.
 * @param last - The address that answered last time.
 * @param probe - Asks one address; resolves with its answer or rejects.
 * @param lastMs - How long the last-known address gets (for tests).
 * @returns The winning address and its answer, or undefined when none answers.
 */
export async function findAddress<T>(urls: string[], last: string | undefined, probe: (url: string) => Promise<T>, lastMs = LAST_ADDRESS_MS): Promise<{ url: string; value: T } | undefined> {
  const order = addressOrder(urls, last);
  if (!order.length) return undefined;
  const run = (url: string) => probe(url).then((value) => ({ url, value }));
  if (order[0] === last?.replace(/\/$/, "")) {
    const first = await Promise.race([run(order[0]!), new Promise<undefined>((r) => setTimeout(() => r(undefined), lastMs).unref?.())]).catch(() => undefined);
    if (first) return first;
  }
  return Promise.any(order.map(run)).catch(() => undefined);
}
