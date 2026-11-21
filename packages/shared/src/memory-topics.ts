/**
 * The Memory page's topic tools (FEATURE_REVIEW 2026-11-21 "Chat and UI", as Claude's memory topics and ChatGPT's
 * memory management): merge two topics, move one fact to another topic, search, and the opt-in monthly recap ("what I
 * learned about you this month", each fact with Remove).
 *
 * Pure: the server's memory store (core/memory-store.ts) changes its data with these and saves; the page uses the same
 * search. Topics stay in their scope: general memory and each project's are never mixed by a merge or a move.
 */

/** A remembered fact, as the memory keeps it. */
export interface TopicFact {
  text: string;
  /** When it was filed (ISO). */
  at: string;
  source: "you" | "auto";
}

/** A topic, as the memory keeps it. */
export interface FactTopic {
  id: string;
  title: string;
  project?: string;
  facts: TopicFact[];
  updatedAt: string;
}

/** A fact in the recap or a search result, with where it lives (for Remove). */
export interface FactRef {
  topicId: string;
  title: string;
  project?: string;
  index: number;
  text: string;
  at: string;
}

/** At most this many facts in one topic (the oldest go first), as the store keeps. */
export const MAX_TOPIC_FACTS = 40;

const sameScope = (a: FactTopic, b: { project?: string }) => (a.project ?? "") === (b.project ?? "");

/** Adds facts to a topic: a fact with the same words replaces the older one; at most MAX_TOPIC_FACTS, newest kept. */
function addFacts(t: FactTopic, facts: TopicFact[], now: string): void {
  const byKey = new Map(t.facts.map((f) => [f.text.toLowerCase(), f]));
  for (const f of facts) {
    const key = f.text.toLowerCase();
    const old = byKey.get(key);
    if (!old || old.at < f.at) byKey.set(key, f);
  }
  t.facts = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_TOPIC_FACTS);
  t.updatedAt = now;
}

/**
 * Merges one topic into another (same scope): its facts join the target's, it is removed.
 *
 * @param topics - All topics (changed in place).
 * @param fromId - The topic that goes.
 * @param intoId - The topic that stays.
 * @param now - The time to mark the target updated (ISO; default now).
 * @returns The topics; throws when either is missing, they are the same, or their scopes differ.
 */
export function mergeTopics<T extends FactTopic>(topics: T[], fromId: string, intoId: string, now = new Date().toISOString()): T[] {
  const from = topics.find((t) => t.id === fromId);
  const into = topics.find((t) => t.id === intoId);
  if (!from || !into) throw new Error("That topic is gone.");
  if (from === into) throw new Error("Choose another topic to merge with.");
  if (!sameScope(from, into)) throw new Error("A project's topics merge only with that project's topics.");
  addFacts(into, from.facts, now);
  topics.splice(topics.indexOf(from), 1);
  return topics;
}

/**
 * Moves one fact to another topic in the same scope: an existing topic (`toId`) or a new one by `title` (an existing
 * topic of that title is used). An emptied topic is removed.
 *
 * @param topics - All topics (changed in place).
 * @param topicId - The fact's topic; `index` its place there.
 * @param to - Where to: `{ toId }` or `{ title }`.
 * @param makeId - Makes a new topic's id.
 * @param now - The time to mark the target updated (ISO; default now).
 * @returns The topics; throws when the fact or the target is missing, or the target is in another scope.
 */
export function moveFact<T extends FactTopic>(topics: T[], topicId: string, index: number, to: { toId: string } | { title: string }, makeId: () => string, now = new Date().toISOString()): T[] {
  const from = topics.find((t) => t.id === topicId);
  const fact = from?.facts[index];
  if (!from || !fact) throw new Error("That fact is gone.");
  let target: FactTopic | undefined;
  if ("toId" in to) {
    target = topics.find((t) => t.id === to.toId);
    if (!target) throw new Error("That topic is gone.");
    if (!sameScope(from, target)) throw new Error("A project's facts move only within that project.");
  } else {
    const title = to.title.trim().slice(0, 60);
    if (!title) throw new Error("Name the topic.");
    target = topics.find((t) => sameScope(t, from) && t.title.toLowerCase() === title.toLowerCase());
    if (!target) {
      target = { id: makeId(), title, ...(from.project ? { project: from.project } : {}), facts: [], updatedAt: now };
      topics.push(target as T);
    }
  }
  if (target === from) return topics;
  from.facts.splice(index, 1);
  addFacts(target, [fact], now);
  if (!from.facts.length) topics.splice(topics.indexOf(from as T), 1);
  return topics;
}

/**
 * The topics and facts that match the words (in a fact or a topic's title, any case), each with the indices of its
 * shown facts (so Edit, Move and Delete still name the right fact). A topic whose title matches shows all its facts.
 * Empty words: everything.
 *
 * @param topics - The topics.
 * @param words - What to look for.
 */
export function searchTopics<T extends FactTopic>(topics: T[], words: string): Array<{ topic: T; indices: number[] }> {
  const q = words.trim().toLowerCase();
  const all = (t: T) => t.facts.map((_, i) => i);
  if (!q) return topics.map((topic) => ({ topic, indices: all(topic) }));
  return topics
    .map((topic) => ({ topic, indices: topic.title.toLowerCase().includes(q) ? all(topic) : all(topic).filter((i) => topic.facts[i]!.text.toLowerCase().includes(q)) }))
    .filter((r) => r.indices.length);
}

/** The month a time falls in, as "YYYY-MM" (local time of the computer). */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The monthly recap: the facts filed in the last `days` days, newest first (at most `max`), each with where it lives
 * so it can be removed.
 *
 * @param topics - The topics.
 * @param now - The time now.
 * @param days - How far back (default 30).
 * @param max - At most this many (default 30).
 */
export function monthlyRecap(topics: FactTopic[], now: Date, days = 30, max = 30): FactRef[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const out: FactRef[] = [];
  for (const t of topics) {
    t.facts.forEach((f, index) => {
      if (f.at >= since) out.push({ topicId: t.id, title: t.title, ...(t.project ? { project: t.project } : {}), index, text: f.text, at: f.at });
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}
