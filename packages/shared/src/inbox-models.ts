/**
 * Which model an Antigravity task runs on (Roee, 2026-11-22). Antigravity (`agy acp`) lists the models of the user's
 * plan in its ACP session; KesherAI keeps the last list it saw and lets each task pick one (frontmatter `model:`, or
 * the picker in "Who does it" on the PC, the phone and the hub page). With no pick, a default by the kind of work:
 *
 * - research → Claude Opus (Thinking): deep reading and writing;
 * - code that builds, tests or converts → Claude Opus;
 * - small text work (docs only, or one or two files without a check) → Gemini Flash (its own, larger quota).
 *
 * When the chosen model's quota runs out or it is unavailable, the run falls back Opus → Sonnet → Flash by itself
 * and says so in the result. Nothing paid is ever switched on (no AI-credit overage): only models the plan lists.
 */
import type { InboxTaskSpec } from "./task-inbox.js";

/** A model as the inbox keeps it (from the agent's last session). */
export interface InboxModel {
  /** The agent's own id for it. */
  id: string;
  /** Its name as the agent shows it, e.g. "Claude Opus 4.6 (Thinking)". */
  name: string;
  /** False when the user's plan cannot use it (listed so the picker can explain, never chosen). */
  available: boolean;
}

/** The families KesherAI knows by name, strongest first: the fallback order. */
export const MODEL_FAMILIES = ["opus", "sonnet", "flash"] as const;
/** One of {@link MODEL_FAMILIES}. */
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** The names Roee's plan shows (2026-11-22), used before Antigravity has been asked once. */
export const KNOWN_MODELS: Record<ModelFamily, string> = {
  opus: "Claude Opus 4.6 (Thinking)",
  sonnet: "Claude Sonnet 4.6 (Thinking)",
  flash: "Gemini 3.8 Flash (Medium)",
};

/** Words that mark a choice as paid or as overage credit: never picked, never shown in the picker. */
const PAID = /\b(credit|credits|overage|pay[- ]as[- ]you[- ]go|billing|paid)\b/i;

/**
 * The family of a model name ("Claude Opus 4.6 (Thinking)" → opus).
 *
 * @param name - A model's name or id.
 * @returns Its family, or undefined for others (GPT-OSS, Gemini Pro…).
 */
export function familyOf(name: string): ModelFamily | undefined {
  const n = name.toLowerCase();
  if (/\bopus\b/.test(n)) return "opus";
  if (/\bsonnet\b/.test(n)) return "sonnet";
  if (/\bflash\b/.test(n) && !/\blite\b/.test(n)) return "flash";
  return undefined;
}

/** Text that marks a code task as small text work (docs only). */
const DOCS_PATH = /^(docs\/|README|CHANGELOG|.*\.(md|txt)$)/i;
/** A goal that converts or ports something (big work). */
const CONVERSION = /\b(convert|conversion|port|porting|migrate)\b|המר|העבר/i;

/**
 * The default model family for a task with no `model:` of its own.
 *
 * @param t - The task's kind, title, goal, check, allowed paths and file limit.
 * @returns opus for research and code that builds, tests or converts; flash for small text work.
 */
export function defaultFamilyFor(t: Pick<InboxTaskSpec, "title" | "goal" | "check" | "allowedPaths" | "maxFiles"> & { kind?: string | undefined }): ModelFamily {
  if (t.kind === "research") return "opus";
  if (CONVERSION.test(`${t.title}\n${t.goal.slice(0, 400)}`)) return "opus";
  const docsOnly = t.allowedPaths.length > 0 && t.allowedPaths.every((p) => DOCS_PATH.test(p));
  if (docsOnly || (!t.check.trim() && t.maxFiles <= 2)) return "flash";
  return "opus";
}

/**
 * The models the picker offers: available ones only, never a paid or credit choice. Before the agent was asked once,
 * the three known names.
 *
 * @param list - The inbox's last list (may be empty).
 * @returns Models to show, in the agent's order.
 */
export function pickableModels(list: readonly InboxModel[] | undefined): InboxModel[] {
  const ok = (list ?? []).filter((m) => m.available && !PAID.test(m.name));
  return ok.length ? ok : MODEL_FAMILIES.map((f) => ({ id: KNOWN_MODELS[f], name: KNOWN_MODELS[f], available: true }));
}

/**
 * Finds a model in a list by what a task asked for: its exact id or name, a part of the name ("opus"), or a family.
 *
 * @param list - Available models.
 * @param want - The task's `model:` (or a family name).
 * @returns The model, or undefined.
 */
export function matchModel(list: readonly InboxModel[], want: string): InboxModel | undefined {
  const w = want.trim().toLowerCase();
  if (!w) return undefined;
  const ok = list.filter((m) => m.available && !PAID.test(m.name));
  return (
    ok.find((m) => m.id.toLowerCase() === w || m.name.toLowerCase() === w) ??
    ok.find((m) => m.name.toLowerCase().includes(w) || m.id.toLowerCase().includes(w)) ??
    (familyOf(w) ? ok.find((m) => familyOf(m.name) === familyOf(w)) : undefined)
  );
}

/**
 * The order to try models in: the chosen one, then the fallbacks after its family (Opus → Sonnet → Flash). A model
 * outside the three families (GPT-OSS…) falls back to Flash.
 *
 * @param list - Available models.
 * @param want - The task's `model:` or empty.
 * @param family - The default family when `want` is empty or not found.
 * @returns Models to try, without repeats (may be empty when the agent lists none).
 */
export function modelChain(list: readonly InboxModel[], want: string, family: ModelFamily): InboxModel[] {
  const first = matchModel(list, want) ?? matchModel(list, family);
  const from = first ? familyOf(first.name) : family;
  const after = from ? MODEL_FAMILIES.slice(MODEL_FAMILIES.indexOf(from) + 1) : (["flash"] as ModelFamily[]);
  const chain = [first, ...after.map((f) => matchModel(list, f))].filter((m): m is InboxModel => !!m);
  return chain.filter((m, i) => chain.findIndex((x) => x.id === m.id) === i);
}

/**
 * Whether an agent's error says the chosen model cannot run now (its quota ran out, or the plan cannot use it), so the
 * next model may be tried.
 *
 * @param msg - The error text.
 * @returns True for a quota or unavailable model.
 */
export function isModelUnavailable(msg: string): boolean {
  return /\b(429|RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit|limit (reached|exceeded)|exhausted|unavailable|not available|model.*not (found|supported|allowed))\b/i.test(msg);
}
