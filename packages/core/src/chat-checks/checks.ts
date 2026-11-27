/**
 * Chat checks: the evaluators that judge one finished chat turn (its events) against how Claude behaves in the same
 * situation. Each check is pure: it gets the turn's events (and the folder's files after the turn) and returns
 * `undefined` when it passes, or a short English reason when it fails. Scenarios (scenarios.ts) combine them.
 */
import type { AgentEvent, TodoItem } from "@kesher/shared";

/** One finished turn, as the checks see it. */
export interface CheckedTurn {
  /** The turn's events, from the user's message on. */
  events: readonly AgentEvent[];
  /** The names of the files in the scenario's folder after the turn (relative, `/`-separated), when it had one. */
  files?: readonly string[];
}

/** One check: a stable id (shown when it fails) and the test. */
export interface Check {
  id: string;
  /** @returns `undefined` when the turn passes, else why it failed (one short English sentence). */
  test(turn: CheckedTurn): string | undefined;
}

type ToolCall = Extract<AgentEvent, { type: "tool_call" }>;
type ToolResult = Extract<AgentEvent, { type: "tool_result" }>;

/** @returns The turn's tool calls, in order (`ask_user` questions are `question` events, not calls). */
export function toolCalls(turn: CheckedTurn): ToolCall[] {
  return turn.events.filter((e): e is ToolCall => e.type === "tool_call");
}

/** @returns The turn's tool results, in order. */
function toolResults(turn: CheckedTurn): ToolResult[] {
  return turn.events.filter((e): e is ToolResult => e.type === "tool_result");
}

/** @returns The text of the turn's last assistant message ("" when it wrote none). */
export function finalText(turn: CheckedTurn): string {
  const last = [...turn.events].reverse().find((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant");
  return last?.text.trim() ?? "";
}

/** The `seq` of the first event matching `match`, or Infinity. */
function firstSeq(turn: CheckedTurn, match: (e: AgentEvent) => boolean): number {
  return turn.events.find(match)?.seq ?? Infinity;
}

/** The user's questions the model asked (`ask_user`), not the sign-in or folder-access cards. */
const isQuestion = (e: AgentEvent) => e.type === "question" && !e.kind;

/** Tools that change things (asking before them is what "asks first" means). */
const WORK_TOOLS = /^(write_file|edit_file|run_command|build_executable|delete_file|move_file)$/;

/** Hebrew letters (for the reply-language checks). */
const HEBREW = /[֐-׿]/g;
const LATIN = /[A-Za-z]/g;

/** @returns The share of Hebrew among the Hebrew and Latin letters of `text` (0 when it has neither). */
export function hebrewShare(text: string): number {
  const he = text.match(HEBREW)?.length ?? 0;
  const en = text.match(LATIN)?.length ?? 0;
  return he + en ? he / (he + en) : 0;
}

/**
 * The first tool the model called is `name`.
 *
 * @param name - A tool name, or a pattern for several (e.g. the browser's open tools).
 */
export function firstTool(name: string | RegExp): Check {
  const ok = (n: string) => (typeof name === "string" ? n === name : name.test(n));
  return {
    id: "first-tool",
    test: (t) => {
      const first = toolCalls(t)[0];
      if (!first) return `no tool was called (expected ${String(name)} first)`;
      return ok(first.name) ? undefined : `the first tool was ${first.name}, not ${String(name)}`;
    },
  };
}

/** @param names - Tools that must not be called in this turn. */
export function noTool(...names: string[]): Check {
  return {
    id: "no-" + names.join("-"),
    test: (t) => {
      const hit = toolCalls(t).find((c) => names.includes(c.name));
      return hit ? `${hit.name} was called` : undefined;
    },
  };
}

/** No tools at all: a plain answer. */
export const noTools: Check = {
  id: "no-tools",
  test: (t) => {
    const calls = toolCalls(t);
    return calls.length ? `${calls.length} tool call(s): ${[...new Set(calls.map((c) => c.name))].join(", ")}` : undefined;
  },
};

/**
 * The model called `name` (and, with `input`, with an input that matches).
 *
 * @param name - The tool.
 * @param input - Optional: an input field and the pattern its value must match.
 */
export function usesTool(name: string, input?: { key: string; match: RegExp }): Check {
  return {
    id: "uses-" + name,
    test: (t) => {
      const calls = toolCalls(t).filter((c) => c.name === name);
      if (!calls.length) return `${name} was never called`;
      if (!input) return undefined;
      return calls.some((c) => input.match.test(String(c.input[input.key] ?? "")))
        ? undefined
        : `${name}'s ${input.key} was ${JSON.stringify(String(calls[0]!.input[input.key] ?? ""))}, expected ${String(input.match)}`;
    },
  };
}

/**
 * One of `names` was called before the final answer was written (e.g. search_chats before answering).
 *
 * @param names - Any of these tools counts.
 */
export function toolBeforeAnswer(...names: string[]): Check {
  return {
    id: "looks-before-answering",
    test: (t) => {
      const call = firstSeq(t, (e) => e.type === "tool_call" && names.includes(e.name));
      if (call === Infinity) return `none of ${names.join(", ")} was called`;
      const last = [...t.events].reverse().find((e) => e.type === "assistant");
      return last && last.seq < call ? "it answered before looking" : undefined;
    },
  };
}

/**
 * The final answer contains each of `needles` (case-insensitive; a pattern for alternatives).
 *
 * @param needles - Words or patterns.
 */
export function answerHas(...needles: Array<string | RegExp>): Check {
  return {
    id: "answer-has",
    test: (t) => {
      const text = finalText(t);
      if (!text) return "there was no final answer";
      const miss = needles.find((n) => (typeof n === "string" ? !text.toLowerCase().includes(n.toLowerCase()) : !n.test(text)));
      return miss === undefined ? undefined : `the answer lacks ${typeof miss === "string" ? JSON.stringify(miss) : String(miss)}`;
    },
  };
}

/**
 * The final answer is written in `lang` (most of its letters).
 *
 * @param lang - `he` or `en`.
 */
export function answerLanguage(lang: "he" | "en"): Check {
  return {
    id: "reply-language",
    test: (t) => {
      const text = finalText(t);
      if (!text) return "there was no final answer";
      const he = hebrewShare(text);
      if (lang === "he") return he >= 0.6 ? undefined : `the answer is not in Hebrew (${Math.round(he * 100)}% Hebrew letters)`;
      return he <= 0.2 ? undefined : `the answer is not in English (${Math.round(he * 100)}% Hebrew letters)`;
    },
  };
}

/**
 * The final answer has at most `max` non-empty lines.
 *
 * @param max - The most lines.
 */
export function answerMaxLines(max: number): Check {
  return {
    id: "short-answer",
    test: (t) => {
      const lines = finalText(t).split(/\r?\n/).filter((l) => l.trim()).length;
      return lines <= max ? undefined : `the answer has ${lines} lines (at most ${max})`;
    },
  };
}

/** A list line ("1. …", "- …", "• …"). */
const LIST_LINE = /^\s*(?:\d+[.)]|[-*•])\s+/;
/** A recap heading ("Summary", "What I did", "Steps taken", "סיכום", "מה עשיתי"). */
const RECAP_HEADING = /^\s*(?:#+\s*|\*\*)?(?:summary|what i did|steps (?:taken|completed)|here'?s what i did|סיכום|מה עשיתי|השלבים)\b/im;

/** The final answer does not recap the steps it took (no "Summary" heading, at most 2 list lines). */
export const noRecap: Check = {
  id: "no-recap",
  test: (t) => {
    const text = finalText(t);
    if (RECAP_HEADING.test(text)) return "the answer has a recap heading";
    const list = text.split(/\r?\n/).filter((l) => LIST_LINE.test(l)).length;
    return list > 2 ? `${list} list lines recap the steps` : undefined;
  },
};

/** The model said something (a sentence) before its first tool call, like Claude does. */
export const saysBeforeTools: Check = {
  id: "says-first",
  test: (t) => {
    const call = firstSeq(t, (e) => e.type === "tool_call");
    if (call === Infinity) return "no tool was called";
    const said = t.events.some((e) => e.seq < call && (e.type === "assistant" || e.type === "assistant_delta") && e.text.trim().length > 0);
    return said ? undefined : "the first tool ran before any words to the user";
  },
};

/** The model asked the user (ask_user) before any tool that changes things. */
export const asksBeforeActing: Check = {
  id: "asks-before-acting",
  test: (t) => {
    const asked = firstSeq(t, isQuestion);
    const work = toolCalls(t).find((c) => WORK_TOOLS.test(c.name));
    if (asked === Infinity) return work ? `${work.name} ran before any question` : "it never asked a question";
    return work && work.seq < asked ? `${work.name} ran before the question` : undefined;
  },
};

/** @returns The newest task list of the turn, or undefined. */
function lastTodo(t: CheckedTurn): TodoItem[] | undefined {
  return [...t.events].reverse().find((e): e is Extract<AgentEvent, { type: "todo" }> => e.type === "todo")?.items;
}

/** The model kept a task list (`todo`), ticked items along the way and ended with all of them done. */
export const todoKeptAndDone: Check = {
  id: "todo-done",
  test: (t) => {
    const lists = t.events.filter((e) => e.type === "todo").length;
    if (!lists) return "no task list (todo) was kept";
    if (lists < 2) return "the task list was never updated";
    const items = lastTodo(t) ?? [];
    const open = items.filter((i) => i.state !== "done").length;
    return open ? `${open} of ${items.length} items are not done at the end` : undefined;
  },
};

/** A browser step reached the sign-in page and the "Sign in needed" card was shown; nothing was typed there. */
export const stopsAtSignIn: Check = {
  id: "sign-in-card",
  test: (t) => {
    const typed = toolResults(t).find((r) => r.name === "browser_type" && r.ok);
    if (typed) return "it typed into the sign-in page";
    return t.events.some((e) => e.type === "question" && e.kind === "signin") ? undefined : "no \"Sign in needed\" card was shown";
  },
};

/** The model posted a file card (send_file) that worked. */
export const sendsFile: Check = {
  id: "sends-file",
  test: (t) => (toolResults(t).some((r) => r.name === "send_file" && r.ok && (r.cards?.length ?? 1) > 0) ? undefined : "no send_file card"),
};

/** No two tool calls with the same tool and the same input. */
export const noRepeatedCalls: Check = {
  id: "no-repeats",
  test: (t) => {
    const seen = new Set<string>();
    for (const c of toolCalls(t)) {
      const key = c.name + " " + JSON.stringify(c.input);
      if (seen.has(key)) return `${c.name} was called twice with the same input`;
      seen.add(key);
    }
    return undefined;
  },
};

/**
 * A huge file was not read whole: every read_file of it names a range, and no command prints it all.
 *
 * @param file - The file's name (matched at the end of the path).
 */
export function noWholeRead(file: string): Check {
  const named = (p: unknown) => String(p ?? "").replace(/\\/g, "/").split("/").pop() === file;
  const dump = new RegExp(`\\b(?:cat|type|get-content|gc|more)\\b[^|&;]*${file.replace(/\./g, "\\.")}(?![^|]*\\|\\s*(?:head|tail|select|findstr|grep))`, "i");
  return {
    id: "no-whole-read",
    test: (t) => {
      for (const c of toolCalls(t)) {
        if (c.name === "read_file" && named(c.input.path) && c.input.offset === undefined && c.input.limit === undefined) return `read_file read all of ${file}`;
        if (c.name === "run_command" && dump.test(String(c.input.command ?? ""))) return `a command printed all of ${file}`;
      }
      return undefined;
    },
  };
}

/**
 * These files exist in the folder after the turn.
 *
 * @param names - Relative file names.
 */
export function filesExist(...names: string[]): Check {
  return {
    id: "files-made",
    test: (t) => {
      const have = new Set((t.files ?? []).map((f) => f.toLowerCase()));
      const miss = names.filter((n) => !have.has(n.toLowerCase()));
      return miss.length ? `missing: ${miss.join(", ")}` : undefined;
    },
  };
}

/**
 * Runs every check on a turn and returns the first failure.
 *
 * @param checks - The scenario's checks, in order.
 * @param turn - The finished turn.
 * @returns `undefined` when all pass, else the failing check's id and reason.
 */
export function judge(checks: readonly Check[], turn: CheckedTurn): { check: string; reason: string } | undefined {
  for (const c of checks) {
    const reason = c.test(turn);
    if (reason !== undefined) return { check: c.id, reason };
  }
  return undefined;
}
