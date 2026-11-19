/**
 * The Claude path: starts the owner's Claude Code scheduled task through its API trigger (research entry, section 1). This
 * runs under the owner's Claude subscription; it is not the Claude API, and the hub holds no model credential, only the
 * per-task fire token (a Worker secret). The token can only start that one task, and deleting it at claude.ai stops
 * this path at once.
 */

/** The scheduled task's trigger id and per-task token (Worker secrets). */
export interface ClaudeTrigger {
  triggerId: string;
  token: string;
}

/** What a fire returned. */
export type FireResult = { ok: true; sessionUrl?: string; sessionId?: string } | { ok: false; error: string };

/** The beta header the trigger endpoint asks for (research preview; the docs say older versions keep working). */
export const ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

/** Longest text sent to the task (the spec cap plus a title). */
const MAX_TEXT = 8500;

/**
 * Whether the trigger is set up (both values present and the id well formed).
 *
 * @param t - The values from the Worker's secrets.
 * @returns The trigger, or undefined.
 */
export function claudeTrigger(t: { triggerId?: string; token?: string }): ClaudeTrigger | undefined {
  if (!t.triggerId || !t.token || !/^[\w-]{1,128}$/.test(t.triggerId)) return undefined;
  return { triggerId: t.triggerId, token: t.token };
}

/**
 * The text the scheduled task receives. Claude Code wraps it as untrusted data, and the task's saved prompt says what
 * to do with it, so it carries only the task itself.
 *
 * @param title - The task's title.
 * @param spec - The task's spec.
 * @returns The text.
 */
export function fireText(title: string, spec: string): string {
  return `Task: ${title}\n\n${spec}`.slice(0, MAX_TEXT);
}

/**
 * Fires the scheduled task once.
 *
 * @param text - What to send (see {@link fireText}).
 * @param trigger - Trigger id and token.
 * @param fetchImpl - `fetch` (tests pass a fake).
 * @returns The session link to open in the Claude app, or a short error (never containing the token).
 */
export async function fireClaudeTask(text: string, trigger: ClaudeTrigger, fetchImpl: typeof fetch = fetch): Promise<FireResult> {
  let r: Response;
  try {
    r = await fetchImpl(`https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(trigger.triggerId)}/fire`, {
      method: "POST",
      headers: { authorization: `Bearer ${trigger.token}`, "anthropic-beta": ROUTINE_BETA, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, MAX_TEXT) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: "Claude's cloud did not answer." };
  }
  if (r.status === 429) return { ok: false, error: "The Claude cloud limit was reached; try again later." };
  if (r.status === 401 || r.status === 403) return { ok: false, error: "The scheduled task's token was refused (deleted or regenerated?)." };
  if (!r.ok) return { ok: false, error: `Claude's cloud answered ${r.status}.` };
  const body = (await r.json().catch(() => ({}))) as { claude_code_session_url?: unknown; claude_code_session_id?: unknown };
  const url = typeof body.claude_code_session_url === "string" ? body.claude_code_session_url : "";
  let sessionUrl: string | undefined;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "claude.ai" || u.hostname.endsWith(".claude.ai"))) sessionUrl = u.toString();
  } catch {
    // No link: the task still started; the phone says "started" without a button.
  }
  const sessionId = typeof body.claude_code_session_id === "string" && /^[\w-]{1,128}$/.test(body.claude_code_session_id) ? body.claude_code_session_id : undefined;
  return { ok: true, ...(sessionUrl ? { sessionUrl } : {}), ...(sessionId ? { sessionId } : {}) };
}
