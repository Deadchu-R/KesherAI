/**
 * The base for more than one relay (docs/research/c-20261122-37.md): the PC's hub link works with a list of relays in
 * priority order, so a second, independent relay provider can be added later without changing hub-client.ts. Today
 * the list holds one relay: the user's Kesher Cloud hub.
 *
 * Dedupe: every sealed message already carries a unique id (`SealedEnvelope.id`, made by `sealMessage`), and the
 * receiving side keeps the ids it has seen (`ReplayGuard` in hub-crypto.ts). So when the same message comes through two
 * relays, the second copy is acknowledged and dropped. A new relay provider must pass envelopes through unchanged.
 */

/** The kinds of relay KesherAI can use. Only the Kesher Cloud hub exists today; a new provider adds its kind here. */
export type RelayKind = "kesher-hub";

/** One relay the PC can reach its phones through. */
export interface RelayProvider {
  /** Stable id (for logs and the failure count), e.g. `hub:https://hub.example.com`. */
  id: string;
  kind: RelayKind;
  /** The relay's base address (https, no trailing slash). */
  url: string;
}

/**
 * The relays in priority order, from the hub settings. Today: the one hub, when an address is set.
 *
 * @param s - The hub settings (`url`; later, more relays).
 * @returns The relays, best first (empty without an address).
 */
export function relayList(s: { url?: string }): RelayProvider[] {
  return s.url ? [{ id: `hub:${s.url}`, kind: "kesher-hub", url: s.url }] : [];
}

/**
 * The relay to use next: the first in priority order that has not failed since the last success, or the first again
 * when all have failed (it retries from the top on its usual backoff).
 *
 * @param list - The relays, best first.
 * @param failed - Ids of the relays that failed since the last success.
 * @returns The relay, or undefined for an empty list.
 */
export function pickRelay(list: readonly RelayProvider[], failed: ReadonlySet<string>): RelayProvider | undefined {
  return list.find((r) => !failed.has(r.id)) ?? list[0];
}
