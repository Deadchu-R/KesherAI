/**
 * Models a provider lists but refuses to run ("This model models/gemini-2.5-flash is no longer available to new
 * users", HTTP 404). Measured on the PC (28.11): Auto routed a web question to such a model and the turn ended with
 * the error. Once a model answers like that it is remembered as gone for a while, so Auto stops picking it, and the
 * turn retries once on another model.
 */

/** How long a gone model stays out of Auto's choice (ms): providers also bring models back, so not for ever. */
export const GONE_TTL_MS = 6 * 60 * 60 * 1000;

const gone = new Map<string, number>();

/**
 * Whether an error says the model itself is retired or unknown to this key (not a busy server or a bad request).
 *
 * @param msg - The provider's error text.
 */
export function isModelGone(msg: string): boolean {
  return /no longer available|has been (?:retired|deprecated|shut ?down)|is (?:deprecated|retired)|\b404\b.*(?:model|not found)|model.*\b404\b|models\/[\w.-]+ is not found|model_not_found|model .{0,60} (?:does not exist|not found)/i.test(msg);
}

/**
 * Remembers a model as gone.
 *
 * @param modelId - Its global id.
 * @param now - The time (tests).
 */
export function markModelGone(modelId: string, now = Date.now()): void {
  gone.set(modelId, now + GONE_TTL_MS);
}

/**
 * Whether a model was marked gone and not yet forgiven.
 *
 * @param modelId - Its global id.
 * @param now - The time (tests).
 */
export function isMarkedGone(modelId: string, now = Date.now()): boolean {
  const until = gone.get(modelId);
  if (until === undefined) return false;
  if (until <= now) gone.delete(modelId);
  return until > now;
}

/** Forgets every mark (tests). */
export function clearModelGone(): void {
  gone.clear();
}
