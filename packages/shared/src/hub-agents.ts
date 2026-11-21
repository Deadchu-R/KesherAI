/**
 * Live agent activity, the viewer's side (the hub page and the phone's Cloud tab, which is the same page): turns the
 * opened `agent_event` batches into one card per run, in the order the page shows them. Plain data, no browser API,
 * so it is tested in Node and compiled into the hub page as is.
 */
import { HUB_LIMITS, type ActivityEvent, type AgentRunState, type AgentRunStateName, type SealedBody } from "./hub-protocol.js";

/** One run as a viewer shows it. */
export interface AgentCard {
  /** The device the run is on. */
  deviceId: string;
  runId: string;
  state: AgentRunState;
  /** Its last events, oldest first (at most {@link HUB_LIMITS.agentEventsPerRun}). */
  events: ActivityEvent[];
  /** When the hub got its newest batch (ms; the heartbeat clock for `stale`). */
  at: number;
  /** The hub's order number of its newest batch. */
  seq: number;
}

/** The map key of a run. */
export const agentKey = (deviceId: string, runId: string): string => `${deviceId}/${runId}`;

const GOING: ReadonlySet<AgentRunStateName> = new Set(["queued", "running", "waiting"]);

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
export function applyAgentBatch(cards: Map<string, AgentCard>, deviceId: string, body: Extract<SealedBody, { type: "agent_event" }>, at: number, seq: number): AgentCard {
  const key = agentKey(deviceId, body.runId);
  const old = cards.get(key);
  const seen = new Set(old?.events.map((e) => e.seq));
  const events = [...(old?.events ?? []), ...body.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq).slice(-HUB_LIMITS.agentEventsPerRun);
  const newer = !old || body.state.lastEventAt >= old.state.lastEventAt;
  const state = withLabel(newer ? body.state : old.state, (body.state.labelAt ?? 0) >= (old?.state.labelAt ?? 0) ? body.state : old!.state);
  const card: AgentCard = { deviceId, runId: body.runId, state, events, at: Math.max(at, old?.at ?? 0), seq: Math.max(seq, old?.seq ?? 0) };
  cards.set(key, card);
  return card;
}

/** A state with the name and note of another (the newer label; a label is changed without new events). */
function withLabel(s: AgentRunState, from: AgentRunState): AgentRunState {
  if (s === from) return s;
  const { name: _n, note: _o, labelAt: _a, ...rest } = s;
  return { ...rest, ...(from.name ? { name: from.name } : {}), ...(from.note ? { note: from.note } : {}), ...(from.labelAt ? { labelAt: from.labelAt } : {}) };
}

/**
 * The name to show for a run: the owner's, or its title.
 *
 * @param s - The run's state.
 * @returns The name, and the original title when a name replaces it.
 */
export function agentName(s: Pick<AgentRunState, "title" | "name">): { name: string; title?: string } {
  return s.name && s.name !== s.title ? { name: s.name, title: s.title } : { name: s.title };
}

/**
 * The state to show now: a going run whose heartbeat stopped for {@link HUB_LIMITS.agentStaleMs} is `stale` (a
 * Claude-chat run, which has no heartbeat: after {@link HUB_LIMITS.agentChatStaleMs}).
 *
 * @param c - The card.
 * @param now - Now (ms).
 * @returns The state.
 */
export function shownState(c: AgentCard, now: number): AgentRunStateName {
  const limit = c.state.source === "claude-chat" ? HUB_LIMITS.agentChatStaleMs : HUB_LIMITS.agentStaleMs;
  return GOING.has(c.state.state) && now - c.at > limit ? "stale" : c.state.state;
}

/** Whether a run is still going (queued, running, waiting; a stale one counts as going). */
export const isGoing = (c: AgentCard): boolean => GOING.has(c.state.state);

/**
 * The cards in the page's order: waiting first (they need the user), then the going ones, then the ended ones,
 * newest first in each group. Ended cards older than the hub keeps them (7 days) are left out.
 *
 * @param cards - All cards.
 * @param now - Now (ms).
 * @returns The cards to show.
 */
export function sortedCards(cards: Iterable<AgentCard>, now: number): AgentCard[] {
  const rank = (c: AgentCard) => (c.state.state === "waiting" ? 0 : isGoing(c) ? 1 : 2);
  return [...cards]
    .filter((c) => isGoing(c) || now - (c.state.endedAt ?? c.at) < HUB_LIMITS.agentKeepMs)
    .sort((a, b) => rank(a) - rank(b) || b.state.lastEventAt - a.state.lastEventAt);
}

/** A task that waits for Run this long is offered "Cancel" (the ask long expired, the owner likely forgot it). */
export const RUN_WAIT_CANCEL_MS = 7 * 24 * 3600 * 1000;

/** How a run's task waits for the owner's Run (see {@link runWait}). */
export interface RunWait {
  /** The "Run this?" ask is gone (expired or answered "Not now"): offer "ask again". */
  expired: boolean;
  /** Waiting more than {@link RUN_WAIT_CANCEL_MS}: offer "Cancel". */
  old: boolean;
}

/**
 * Whether the task behind an Antigravity run is waiting for the owner's Run, and how. A run whose ask expired is not
 * "waiting" any more and its heartbeat stops, so it would show as "Not answering"; it is waiting for Run.
 *
 * @param c - The run's card.
 * @param task - The task's page status and creation time (ms), when the page has the task.
 * @param now - Now (ms).
 * @returns undefined when the task is not waiting for Run.
 */
export function runWait(c: AgentCard, task: { status: string; createdAt: number } | undefined, now: number): RunWait | undefined {
  if (c.state.source !== "antigravity" || task?.status !== "waiting-run" || !isGoing(c)) return undefined;
  return { expired: shownState(c, now) !== "waiting", old: now - task.createdAt > RUN_WAIT_CANCEL_MS };
}
