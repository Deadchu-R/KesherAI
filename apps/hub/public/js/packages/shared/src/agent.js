/**
 * Types for agent sessions — the engine behind every conversation.
 *
 * A plain chat is an agent session whose only tools are the media tools of
 * the active models (generate an image, …). A code session adds file and
 * terminal tools inside a workspace folder. Both stream the same
 * {@link AgentEvent}s, so one UI renders both.
 *
 * @packageDocumentation
 */
export {};
