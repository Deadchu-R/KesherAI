import type { Library } from "./library.js";
import { rank } from "./knowledge.js";

/**
 * Search across every conversation: what the user wrote and the answers,
 * ranked like the knowledge bases (BM25, Hebrew prefixes handled), with
 * the matching passage. Conversations are read once and kept until they
 * change.
 */

/** A result. */
export interface ConversationHit {
  id: string;
  title: string;
  updatedAt: string;
  kind: string;
  /** The matching passage, around the words. */
  snippet: string;
  /** The event it came from, to scroll to. */
  seq: number;
  role: "user" | "assistant";
  score: number;
}

type Passage = { text: string; seq: number; role: "user" | "assistant" };

/** Searches conversations. */
export class ConversationSearch {
  private cache = new Map<string, { updatedAt: string; passages: Passage[] }>();

  /** @param library - Where conversations are kept. */
  constructor(private readonly library: Library) {}

  private async passages(id: string, updatedAt: string): Promise<Passage[]> {
    const hit = this.cache.get(id);
    if (hit && hit.updatedAt === updatedAt) return hit.passages;
    const c = await this.library.getConversation(id).catch(() => undefined);
    const passages: Passage[] = [];
    for (const e of c?.events ?? []) {
      if ((e.type === "user" || e.type === "assistant") && e.text.trim()) {
        // Long answers are cut into parts, so the snippet is the part that matches.
        for (let i = 0; i < e.text.length; i += 1200) passages.push({ text: e.text.slice(i, i + 1400), seq: e.seq, role: e.type });
      }
    }
    this.cache.set(id, { updatedAt, passages });
    return passages;
  }

  /**
   * @param query - Words to look for.
   * @param limit - How many results.
   * @returns The best matches, at most one per conversation, best first.
   */
  async search(query: string, limit = 20): Promise<ConversationHit[]> {
    const q = query.trim();
    if (!q) return [];
    const convs = this.library.listConversations().slice(0, 2000);
    const all: Array<Passage & { conv: (typeof convs)[number] }> = [];
    for (const c of convs) {
      // The title counts as a passage too.
      all.push({ text: c.title, seq: 0, role: "user", conv: c });
      for (const p of await this.passages(c.id, c.updatedAt)) all.push({ ...p, conv: c });
    }
    const seen = new Set<string>();
    const out: ConversationHit[] = [];
    for (const h of rank(all, q, 400)) {
      if (seen.has(h.conv.id)) continue;
      seen.add(h.conv.id);
      out.push({ id: h.conv.id, title: h.conv.title, updatedAt: h.conv.updatedAt, kind: h.conv.kind, snippet: snippet(h.text, q), seq: h.seq, role: h.role, score: Math.round(h.score * 100) / 100 });
      if (out.length >= limit) break;
    }
    return out;
  }
}

/**
 * The part of a passage around the first word of the query found in it.
 *
 * @param text - The passage.
 * @param query - The words.
 * @returns About 200 characters.
 */
export function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const at = words.map((w) => lower.indexOf(w.replace(/^[והבלמשכ](?=[֐-׿]{3,})/, ""))).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 70);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 200)}${start + 200 < flat.length ? "…" : ""}`;
}
