/** Types of agents-status.mjs (the pure part the tests use). */
export const BRANCH: string;
export const FILE: string;
export function readAgents(text: string | undefined): Array<Record<string, unknown>>;
export function applyUpdate(agents: Array<Record<string, unknown>>, c: { cmd: "set" | "done" | "fail"; id: string; title?: string; model?: string; note?: string }, now: number): { updatedAt: number; agents: Array<Record<string, unknown>> };
export function parseArgs(argv: string[]): { cmd: "set" | "done" | "fail"; id: string; title?: string; model?: string; note?: string };
