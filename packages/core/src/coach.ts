import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, Conversation } from "@kesher/shared";
import type { ModelTurn } from "@kesher/agent";

/**
 * The coach: looks at how a conversation went (what the user asked, what
 * each request cost in tokens, what was wasted on failed steps and rework)
 * and suggests how to get better results: a clearer prompt, a tool, a
 * plugin or MCP server, a skill, another model or setting. It keeps a small
 * local profile of the user's habits, learned from their own usage, and
 * uses it next time. Nothing leaves the computer except the analysis call
 * to the model the user chose.
 */

/** Cost and waste of one user request (one message and everything it triggered). */
export interface RequestStats {
  /** The user's message (first 400 characters). */
  prompt: string;
  /** Model calls made for it. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens spent on calls whose actions failed or were denied, and on answers a reviewer sent back. */
  wastedTokens: number;
  /** Tool calls that failed or were denied. */
  failedSteps: number;
  /** Times the app had to push the model back to work. */
  nudges: number;
  /** Times a reviewer sent the answer back. */
  reworks: number;
  /** Tools used, with counts. */
  tools: Record<string, number>;
  /** Whether any token count was estimated rather than reported by the provider. */
  estimated: boolean;
  /** Tokens per model. */
  byModel: Record<string, number>;
}

/** A suggestion from the coach. */
export interface CoachSuggestion {
  kind: "prompt" | "tool" | "mcp" | "skill" | "model" | "setting" | "plugin";
  title: string;
  why: string;
  /** For `prompt`: a better way to write the request, ready to use. */
  example?: string;
}

/** What the coach has learned about this user, kept in `<data>/coach.json`. */
export interface CoachProfile {
  /** Short notes about how the user works ("asks for Windows .exe programs", "writes in Hebrew"). */
  notes: string[];
  /** Total requests analysed. */
  analysed: number;
  updatedAt?: string;
}

const NUDGE_NOTE = /^KesherAI asked the model/i;

/**
 * Splits a conversation's events into requests and measures each one.
 *
 * @param events - The conversation's events.
 * @returns One entry per user message, oldest first.
 */
export function requestStats(events: readonly AgentEvent[]): RequestStats[] {
  const out: RequestStats[] = [];
  let cur: RequestStats | undefined;
  // Usage events of this request that asked for tools, by tool-call order, to charge failures to them.
  let pendingCalls: Array<{ tokens: number; tools: string[]; failed: boolean }> = [];
  let sinceReview = 0;
  const close = () => {
    if (!cur) return;
    cur.wastedTokens += pendingCalls.filter((c) => c.failed).reduce((a, c) => a + c.tokens, 0);
    out.push(cur);
  };
  for (const e of events) {
    if (e.type === "user") {
      close();
      cur = { prompt: e.text.slice(0, 400), calls: 0, inputTokens: 0, outputTokens: 0, wastedTokens: 0, failedSteps: 0, nudges: 0, reworks: 0, tools: {}, estimated: false, byModel: {} };
      pendingCalls = [];
      sinceReview = 0;
      continue;
    }
    if (!cur) continue;
    if (e.type === "usage") {
      const tokens = e.input + e.output;
      cur.calls++;
      cur.inputTokens += e.input;
      cur.outputTokens += e.output;
      cur.estimated ||= e.estimated;
      cur.byModel[e.modelId] = (cur.byModel[e.modelId] ?? 0) + tokens;
      if (e.role === "main") {
        sinceReview += tokens;
        if (e.tools.length) pendingCalls.push({ tokens, tools: [...e.tools], failed: false });
      }
      for (const t of e.tools) cur.tools[t] = (cur.tools[t] ?? 0) + 1;
    } else if (e.type === "tool_result" && !e.ok) {
      cur.failedSteps++;
      const owner = [...pendingCalls].reverse().find((c) => c.tools.includes(e.name));
      if (owner) owner.failed = true;
    } else if (e.type === "note" && NUDGE_NOTE.test(e.text)) {
      cur.nudges++;
    } else if (e.type === "teammate" && e.role === "reviewer") {
      if (e.approved === false) {
        cur.reworks++;
        cur.wastedTokens += sinceReview;
        pendingCalls = []; // already counted as rework
      }
      sinceReview = 0;
    }
  }
  close();
  return out;
}

const COACH_PROMPT = `You are the coach inside KesherAI, a local-first AI app. You help the user get better results from their AI models with less waste.
You get: the user's recent requests with what each cost in tokens and what went wrong, the tools the models have, the plugins installed, and notes about how this user works.
Answer ONLY with JSON: {"suggestions":[{"kind":"prompt|tool|mcp|skill|model|setting|plugin","title":"…","why":"…","example":"…"}],"learned":["…"]}
- 2 to 6 suggestions, the most useful first, each specific to what you saw (no generic advice). "why" says what it fixes, with the numbers when they matter.
- kind "prompt": a better way to write one of their requests; put the rewritten request, ready to send, in "example" (in the user's language).
- kind "tool"/"plugin"/"mcp"/"skill": something to turn on or install that would have done the job better (e.g. an MCP server for GitHub, Notion, Unity or a database; a skill with house rules). Say what it is.
- kind "model": a better-suited model for this kind of request (smaller for simple ones, stronger for hard ones), or adding a reviewer teammate.
- kind "setting": e.g. permission mode, a permanent approval, the context size.
- "learned": up to 5 short, durable notes about how this user works (their language, the kinds of tasks, their stack, what they dislike). No secrets, no personal details beyond work habits.
Write "title", "why" and "learned" in the user's language.`;

/** Reads, updates and runs the coach. */
export class Coach {
  /** @param dir - KesherAI's data folder. */
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, "coach.json");
  }

  /** @returns The saved profile (empty when there is none). */
  async profile(): Promise<CoachProfile> {
    try {
      const p = JSON.parse(await readFile(this.file, "utf8")) as Partial<CoachProfile>;
      return { notes: Array.isArray(p.notes) ? p.notes.filter((n) => typeof n === "string") : [], analysed: Number(p.analysed ?? 0), ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}) };
    } catch {
      return { notes: [], analysed: 0 };
    }
  }

  /**
   * Saves the profile.
   *
   * @param p - The profile.
   */
  async save(p: CoachProfile): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2));
    await rename(tmp, this.file);
  }

  /** Forgets everything learned. */
  async reset(): Promise<void> {
    await this.save({ notes: [], analysed: 0 });
  }

  /**
   * Analyses a conversation and returns suggestions; learned notes are merged into the profile.
   *
   * @param conversation - The conversation to look at.
   * @param model - The model that coaches.
   * @param context - Tools and plugins available.
   * @param signal - Cancels the call.
   * @returns Suggestions and the per-request numbers they are based on.
   */
  async analyze(
    conversation: Conversation,
    model: ModelTurn,
    context: { tools: string[]; plugins: string[]; mainModel: string; team: string[] },
    signal?: AbortSignal,
  ): Promise<{ suggestions: CoachSuggestion[]; stats: RequestStats[]; learned: string[] }> {
    const stats = requestStats(conversation.events);
    if (stats.length === 0) return { suggestions: [], stats, learned: [] };
    const profile = await this.profile();
    const recent = stats.slice(-8);
    const brief = [
      `Main model: ${context.mainModel}${context.team.length ? `; teammates: ${context.team.join(", ")}` : ""}`,
      `Tools the model has: ${context.tools.join(", ")}`,
      `Plugins installed: ${context.plugins.join(", ") || "none"}`,
      `Notes about this user: ${profile.notes.length ? profile.notes.map((n) => `\n- ${n}`).join("") : "none yet"}`,
      "",
      "Recent requests (oldest first):",
      ...recent.map(
        (r, i) =>
          `${i + 1}. "${r.prompt.replace(/\s+/g, " ")}"\n   ${r.calls} model calls, ${r.inputTokens + r.outputTokens} tokens (${r.wastedTokens} wasted), ${r.failedSteps} failed steps, ${r.nudges} nudges, ${r.reworks} sent back by reviewer; tools: ${Object.entries(r.tools).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`,
      ),
    ].join("\n");
    const r = await model({ messages: [{ role: "system", content: COACH_PROMPT }, { role: "user", content: brief }], tools: [] }, signal ?? new AbortController().signal, () => undefined);
    const parsed = parseCoachJson(r.text);
    const learned = parsed.learned.slice(0, 5);
    if (learned.length) {
      const seen = new Set(profile.notes.map((n) => n.toLowerCase()));
      const merged = [...profile.notes, ...learned.filter((n) => !seen.has(n.toLowerCase()))].slice(-20);
      await this.save({ notes: merged, analysed: profile.analysed + recent.length, updatedAt: new Date().toISOString() });
    }
    return { suggestions: parsed.suggestions, stats, learned };
  }
}

const KINDS = new Set(["prompt", "tool", "mcp", "skill", "model", "setting", "plugin"]);

/**
 * Pulls the coach's JSON out of a model answer (models wrap it in prose or code fences).
 *
 * @param text - The model's answer.
 * @returns Valid suggestions and learned notes; empty lists if nothing parses.
 */
export function parseCoachJson(text: string): { suggestions: CoachSuggestion[]; learned: string[] } {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) return { suggestions: [], learned: [] };
  try {
    const j = JSON.parse(clean.slice(start, end + 1)) as { suggestions?: unknown[]; learned?: unknown[] };
    const suggestions = (j.suggestions ?? []).flatMap((x) => {
      const s = x as Partial<CoachSuggestion>;
      if (!s || typeof s.title !== "string" || typeof s.why !== "string") return [];
      const kind = KINDS.has(String(s.kind)) ? (s.kind as CoachSuggestion["kind"]) : "prompt";
      return [{ kind, title: s.title, why: s.why, ...(typeof s.example === "string" && s.example.trim() ? { example: s.example } : {}) }];
    });
    const learned = (j.learned ?? []).filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim().slice(0, 200));
    return { suggestions: suggestions.slice(0, 6), learned };
  } catch {
    return { suggestions: [], learned: [] };
  }
}
