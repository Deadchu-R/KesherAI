/**
 * `@kesher/agent` — the agent behind every KesherAI conversation: a
 * tool-calling loop ({@link AgentSession}), file and terminal tools for
 * code conversations ({@link CODE_TOOLS}), permission modes and the
 * system prompt. Read `session.ts` first.
 *
 * @packageDocumentation
 */
export { AgentSession, lineDelta, type AgentSessionOptions, type RunFiles, type UndoStore, type ExternalAgent, type ExternalIO, type ContextView, type ModelTurn, type TeamMember } from "./session.js";
export { CODE_TOOLS, ASK_USER_TOOL, askUserSpec, makeDiff, truncate, type AgentTool, type GateInfo, type GateResult, type ToolContext, type ToolOutput } from "./tools.js";
export { decide, dangerReason, type PermissionVerdict } from "./permissions.js";
export { modelReviewer, parseReview, reviewPrompt, REVIEW_SYSTEM, type Reviewer, type ReviewRequest, type ReviewVerdict } from "./reviewer.js";
export { resolveInWorkspace, displayPath, globToRegExp, IGNORED_DIRS } from "./workspace.js";
export { buildSystemPrompt, readProjectGuide, splitPrompt, CHAT_CONTEXT_MARK, type PromptOptions } from "./prompt.js";
export * from "./system-tools.js";
export * from "./search-query.js";
export * from "./answer-links.js";
export { checkBackends, lastBackendCheck, searchCooldowns, SearchFailedError, setSearchEngine, setSearchKeys, type BackendCheck, type SearchEngineChoice, type SearchKeys } from "./web-search.js";
export { REQUEST_ACCESS_TOOL, requestAccessSpec } from "./tools.js";
export { resolveForTool } from "./workspace.js";
export { buildExecutableTool } from "./build.js";
export * from "./context.js";
export { DEFAULT_TOOL_CAP, TOOL_OUTPUT_TOOL } from "./budget.js";

export { documentText, formatPages, readDocumentTool, type DocumentText } from "./documents.js";
export { csvRows, docxHtml, openZip, pptxSlides, sheetText, xlsxSheets, type Sheet } from "./office.js";
export { bare, codeMap, indexProject, listAssets, symbolsOf, symbolsWithLines, type AssetEntry, type Indexed } from "./code-intel.js";
export { AGENT_GIT_IDENTITY, runShell, spawnShell, killTree, sshArgs, sshTarget, type ShellResult, type ShellDetach } from "./shell.js";
