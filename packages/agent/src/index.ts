/**
 * `@kesher/agent` — the agent behind every KesherAI conversation: a
 * tool-calling loop ({@link AgentSession}), file and terminal tools for
 * code conversations ({@link CODE_TOOLS}), permission modes and the
 * system prompt. Read `session.ts` first.
 *
 * @packageDocumentation
 */
export { AgentSession, type AgentSessionOptions, type ContextView, type ModelTurn, type TeamMember } from "./session.js";
export { CODE_TOOLS, ASK_USER_TOOL, askUserSpec, makeDiff, truncate, type AgentTool, type ToolContext, type ToolOutput } from "./tools.js";
export { decide, dangerReason, type PermissionVerdict } from "./permissions.js";
export { resolveInWorkspace, displayPath, globToRegExp, IGNORED_DIRS } from "./workspace.js";
export { buildSystemPrompt, readProjectGuide, type PromptOptions } from "./prompt.js";
export * from "./system-tools.js";
export { REQUEST_ACCESS_TOOL, requestAccessSpec } from "./tools.js";
export { resolveForTool } from "./workspace.js";
export { buildExecutableTool } from "./build.js";
export * from "./context.js";

export { documentText, formatPages, readDocumentTool, type DocumentText } from "./documents.js";
export { codeMap, symbolsOf } from "./code-intel.js";
