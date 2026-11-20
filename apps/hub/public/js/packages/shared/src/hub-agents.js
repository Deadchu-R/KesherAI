/**
 * Live agent activity, the viewer's side (the hub page and the phone's Cloud tab, which is the same page): turns the
 * opened `agent_event` batches into one card per run, in the order the page shows them. Plain data, no browser API,
 * so it is tested in Node and compiled into the hub page as is.
 */
import { HUB_LIMITS } from "./hub-protocol.js";
/** The map key of a run. */
export const agentKey = (deviceId, runId) => `${deviceId}/${runId}`;
const GOING = new Set(["queued", "running", "waiting"]);
/**
 * Applies one opened batch: its events join the run's (each once, by its own number), and its state replaces the
 * card's unless an older batch arrives late (catch-up after a live one).
 *
 * @param cards - The cards by {@link agentKey} (changed in place).
 * @param deviceId - The sender (from the envelope, which opened with its key).
 * @param body - The opened body.
 * @param at - When the hub got it (`env.at`), or now.
 * @param seq - The hub's order number (`env.seq`), or 0.
 * @returns The card.
 */
export function applyAgentBatch(cards, deviceId, body, at, seq) {
    const key = agentKey(deviceId, body.runId);
    const old = cards.get(key);
    const seen = new Set(old?.events.map((e) => e.seq));
    const events = [...(old?.events ?? []), ...body.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq).slice(-HUB_LIMITS.agentEventsPerRun);
    const newer = !old || body.state.lastEventAt >= old.state.lastEventAt;
    const card = { deviceId, runId: body.runId, state: newer ? body.state : old.state, events, at: Math.max(at, old?.at ?? 0), seq: Math.max(seq, old?.seq ?? 0) };
    cards.set(key, card);
    return card;
}
/**
 * The state to show now: a going run whose heartbeat stopped for {@link HUB_LIMITS.agentStaleMs} is `stale` (a
 * Claude-chat run, which has no heartbeat: after {@link HUB_LIMITS.agentChatStaleMs}).
 *
 * @param c - The card.
 * @param now - Now (ms).
 * @returns The state.
 */
export function shownState(c, now) {
    const limit = c.state.source === "claude-chat" ? HUB_LIMITS.agentChatStaleMs : HUB_LIMITS.agentStaleMs;
    return GOING.has(c.state.state) && now - c.at > limit ? "stale" : c.state.state;
}
/** Whether a run is still going (queued, running, waiting; a stale one counts as going). */
export const isGoing = (c) => GOING.has(c.state.state);
/**
 * The cards in the page's order: waiting first (they need the user), then the going ones, then the ended ones,
 * newest first in each group. Ended cards older than the hub keeps them (7 days) are left out.
 *
 * @param cards - All cards.
 * @param now - Now (ms).
 * @returns The cards to show.
 */
export function sortedCards(cards, now) {
    const rank = (c) => (c.state.state === "waiting" ? 0 : isGoing(c) ? 1 : 2);
    return [...cards]
        .filter((c) => isGoing(c) || now - (c.state.endedAt ?? c.at) < HUB_LIMITS.agentKeepMs)
        .sort((a, b) => rank(a) - rank(b) || b.state.lastEventAt - a.state.lastEventAt);
}
