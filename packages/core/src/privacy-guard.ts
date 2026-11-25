/**
 * The server side of the privacy guard (Roee, 2026-11-23). Every model request passes {@link guardMessages} before it
 * goes to a service that may train on it (shared training-risk.ts): the chat's messages, attachments, files an agent
 * read (tool results), the tool calls it made, helper and task inbox prompts. Sensitive things (shared leak-guard.ts)
 * are hidden behind placeholders, or the request is stopped:
 * - Settings › Privacy `block-training-providers`: nothing with a hit is sent; the error says what to do.
 * - `ask` (the chat asked before sending: the dialog) and `auto-hide`: what is left is hidden.
 * - An unattended run (task inbox, self-work) whose hit is in a file the agent read stops with a "privacy skip": the
 *   task moves to a model that does not train, so placeholders are never written back into the code it edits.
 */
import { LEAK_LABEL, leakSummary, looksFakeKey, privacyModeOf, redactLeaks, trainingRiskOf, type AgentMessage, type LeakContext, type LeakHit, type PrivacyMode } from "@kesher/shared";

/** What the guard needs from the server: the user's settings and this computer's user name and home folder. */
export interface PrivacyGuardSource {
  mode: PrivacyMode;
  neverSend: readonly string[];
  username?: string;
  home?: string;
}

let source: (() => PrivacyGuardSource) | undefined;

/**
 * Connects the guard to the server's settings (called once at start; read on every request, so changes apply at once).
 *
 * @param fn - Returns the current settings and this computer's names.
 */
export function setPrivacyGuard(fn: (() => PrivacyGuardSource) | undefined): void {
  source = fn;
}

/** The leak context the guard uses now (for the chat's check route too). */
export function privacyContext(): { mode: PrivacyMode; ctx: LeakContext } {
  const s = source?.();
  return { mode: privacyModeOf(s?.mode), ctx: { neverSend: s?.neverSend ?? [], ...(s?.username ? { username: s.username } : {}), ...(s?.home ? { home: s.home } : {}) } };
}

/** The start of every error the guard throws (the task inbox and the chat recognise it). */
export const PRIVACY_ERROR = "Privacy guard:";

/** Whether an error message is the guard's "this file must not go to a training service" for an unattended run. */
export const isPrivacySkip = (message: string): boolean => message.startsWith(`${PRIVACY_ERROR} skip`);

/** Told to the model once something was hidden, so it never writes a placeholder back into a file. */
const HIDDEN_NOTE =
  "Some values in this conversation were hidden by KesherAI's privacy guard (shown as [key hidden], [password hidden], [email hidden], [home hidden] and the like). Never write these placeholders into a file; leave the lines that hold them as they are.";

/** Results of earlier scans by text (agent sessions resend the same messages every turn). */
const cache = new Map<string, { text: string; hits: LeakHit[] }>();
const CACHE_MAX = 400;

function redact(text: string, ctx: LeakContext): { text: string; hits: LeakHit[] } {
  if (!text) return { text, hits: [] };
  const key = `${ctx.username ?? ""}\0${ctx.home ?? ""}\0${(ctx.neverSend ?? []).join("\0")}\0${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = redactLeaks(text, ctx);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, r);
  return r;
}

/** Hides hits in every string inside a tool call's arguments. */
function redactArgs(v: unknown, ctx: LeakContext, found: LeakHit[]): unknown {
  if (typeof v === "string") {
    const r = redact(v, ctx);
    found.push(...r.hits);
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => redactArgs(x, ctx, found));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactArgs(x, ctx, found)]));
  return v;
}

/** A short English list of what was found ("2 keys or tokens, 1 email address"). */
function describe(hits: readonly LeakHit[]): string {
  return leakSummary(hits).map((s) => `${s.count} ${LEAK_LABEL[s.kind].en}`).join(", ");
}

/**
 * Checks (and hides) what a request would send to a model. Models whose service does not train get the messages as
 * they are.
 *
 * @param modelId - The model the request goes to (`<connection>/<model>`).
 * @param messages - The request's messages.
 * @param opts.unattended - No one watches the run (task inbox, self-work): a hit in a file it read stops it with a skip.
 * @returns The messages to send (new objects where something was hidden) and how many things were hidden.
 * @throws Error starting with {@link PRIVACY_ERROR} when the request must not be sent.
 */
export function guardMessages(modelId: string, messages: readonly AgentMessage[], opts: { unattended?: boolean } = {}): { messages: AgentMessage[]; hidden: number } {
  if (!trainingRiskOf(modelId)) return { messages: [...messages], hidden: 0 };
  const { mode, ctx } = privacyContext();
  const all: LeakHit[] = [];
  const inTools: LeakHit[] = [];
  const out = messages.map((m) => {
    const r = redact(m.content, ctx);
    const argHits: LeakHit[] = [];
    const toolCalls = m.toolCalls?.map((c) => ({ ...c, arguments: redactArgs(c.arguments, ctx, argHits) as Record<string, unknown> }));
    all.push(...r.hits, ...argHits);
    // A made-up key in a file the agent read (KesherAI's own tests) is hidden like any other, but need not stop the run.
    if (m.role === "tool") inTools.push(...r.hits.filter((h) => !(h.kind === "key" && looksFakeKey(m.content.slice(h.start, h.end)))));
    if (!r.hits.length && !argHits.length) return m;
    return { ...m, content: r.text, ...(toolCalls ? { toolCalls } : {}) };
  });
  if (!all.length) return { messages: out, hidden: 0 };
  const service = modelId.slice(0, modelId.indexOf("/"));
  if (mode === "block-training-providers") {
    throw new Error(`${PRIVACY_ERROR} blocked. This request holds ${describe(all)}, and ${service} may train on what it is sent, so nothing was sent. Choose a local model or one that does not train, or change Settings › Privacy.`);
  }
  // The user folder and name are hidden and need not stop the run: they come from tool output (test logs, absolute
  // paths), not from the code, so a placeholder never lands in a file (25.11: 72 folder paths moved a task off three
  // free models). Keys, passwords and the rest still stop it.
  const stopping = inTools.filter((h) => h.kind !== "path" && h.kind !== "user");
  if (opts.unattended && stopping.length) {
    throw new Error(`${PRIVACY_ERROR} skip. A file this run read holds ${describe(stopping)}; it is not sent to ${service}, which may train on it. The task goes to a model that does not train.`);
  }
  const first = out.findIndex((m) => m.role === "system");
  if (first >= 0) out[first] = { ...out[first]!, content: `${out[first]!.content}\n\n${HIDDEN_NOTE}` };
  else out.unshift({ role: "system", content: HIDDEN_NOTE });
  return { messages: out, hidden: all.length };
}

/**
 * The chat's check before sending (the "sensitive info found" dialog): what the text holds and its hidden form.
 *
 * @param modelId - The chat's model.
 * @param text - The message the user is about to send.
 * @returns The model's training risk, the mode, what was found by kind, and the hidden text.
 */
export function checkText(modelId: string, text: string): { risk: ReturnType<typeof trainingRiskOf> | null; mode: PrivacyMode; found: Array<{ kind: LeakHit["kind"]; count: number }>; hidden: string } {
  const risk = trainingRiskOf(modelId);
  const { mode, ctx } = privacyContext();
  if (!risk) return { risk: null, mode, found: [], hidden: text };
  const r = redactLeaks(text, ctx);
  return { risk, mode, found: leakSummary(r.hits), hidden: r.text };
}
