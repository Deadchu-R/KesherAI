/**
 * Parses the JSON arguments of a tool call. Models sometimes send invalid
 * JSON; instead of failing the whole turn, the raw text is kept under
 * `_invalidJson` so the agent can tell the model what went wrong.
 *
 * @param raw - JSON text from the model (may be empty).
 * @returns The parsed object.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  } catch {
    return { _invalidJson: raw };
  }
}
