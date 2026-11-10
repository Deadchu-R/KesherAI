import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";
import type { AgentEvent } from "@kesher/shared";

/**
 * Project facts: things about one project's computer that chats keep finding
 * out by failing (`python` is not installed here but `py -3` works; `rg` is
 * missing), learned from the chats' own commands and told to every new chat
 * in that project, so a local model with a small context does not spend turns
 * rediscovering them.
 *
 * How others do it (docs/RESEARCH_LOG.md): Microsoft's TokenEconomizer learns
 * "environment facts" from repeated failures with no model calls (a fact is
 * used after 3 sessions confirm it and retired when contradicted); Cursor and
 * Windsurf keep per-project memories the user can see and delete. KesherAI
 * follows TokenEconomizer's safer half: every fact is a fixed sentence filled
 * only with the command forms seen (command output is controlled by the
 * project, so free text from it could carry instructions), shown on the code
 * page with a remove button, stored in KesherAI's folder (not the project).
 */

/** What a failing command said, in a few words. */
export type ErrorClass = "not found" | "module missing";

/** One command a chat ran, with how it went. */
export interface SeenCommand {
  command: string;
  ok: boolean;
  error?: ErrorClass;
}

/** A learned fact. */
export interface ProjectFact {
  id: string;
  family: "form_repair" | "absent_tool";
  /** form_repair: `a` fails, `b` works; absent_tool: `a` is the missing program. */
  a: string;
  b?: string;
  error: ErrorClass;
  /** Each chat's verdict, in the order they were seen: confirmed or contradicted. */
  chats: Record<string, "confirm" | "contradict">;
  state: "candidate" | "active" | "retired" | "removed";
}

/** Chats needed before a fact is used (TokenEconomizer's K_PROMOTE). */
export const CONFIRMATIONS = 3;
/** The most facts told to a chat, and their size (TokenEconomizer: 4 facts, about 150 tokens). */
export const MAX_FACTS = 4;
const MAX_CHARS = 600;

/**
 * The failure class of a command's output, when it is the environment's fault
 * (a program or module that is not there), not the code's.
 *
 * @param output - What the command printed.
 * @returns The class, or undefined.
 */
export function errorClass(output: string): ErrorClass | undefined {
  if (/is not recognized as an internal or external command|is not recognized as the name of a cmdlet|command not found|: not found\b|No such file or directory.*\bexec\b/i.test(output)) return "not found";
  if (/No module named ['"]?[\w.]+|Cannot find module ['"]|ModuleNotFoundError/i.test(output)) return "module missing";
  return undefined;
}

/**
 * The commands a chat ran with run_command, in order.
 *
 * @param events - The chat's events.
 * @returns Commands with their outcome.
 */
export function commandsOf(events: readonly AgentEvent[]): SeenCommand[] {
  const calls = new Map<string, string>();
  const out: SeenCommand[] = [];
  for (const e of events) {
    if (e.type === "tool_call" && e.name === "run_command") {
      const c = (e.input as { command?: unknown } | undefined)?.command;
      if (typeof c === "string") calls.set(e.callId, c.trim());
    } else if (e.type === "tool_result" && e.name === "run_command") {
      const command = calls.get(e.callId);
      if (!command) continue;
      const exit = /Exit code (\d+)\.\s*$/.exec(e.output)?.[1];
      const ok = e.ok && exit === "0";
      const error = ok ? undefined : errorClass(e.output);
      out.push({ command, ok, ...(error ? { error } : {}) });
    }
  }
  return out;
}

/** The first command of a line (`a && b`, `a | b`: only `a`), with spaces tidied. */
function firstCommand(command: string): string {
  return command.split(/&&|\|\||;|\|/)[0]!.trim().replace(/\s+/g, " ");
}

/**
 * How a command is spelled (its form) and what it is for (its key), so
 * `python -m pytest -q`, `py -3 -m pytest -q` and `pytest -q` count as the
 * same thing done three ways.
 *
 * @param command - A command line.
 * @returns The form (the program part), the key (program or module) and the rest.
 */
export function formOf(command: string): { form: string; key: string; rest: string } {
  const c = firstCommand(command);
  // An interpreter running a module: python -m pytest, py -3 -m pip, python3.11 -m venv.
  const mod = /^((?:python[\d.]*|py)(?: -\d+(?:\.\d+)?)?(?:\.exe)? -m) ([\w.-]+)(.*)$/i.exec(c);
  if (mod) return { form: `${mod[1]} ${mod[2]}`, key: mod[2]!.toLowerCase(), rest: mod[3]!.trim() };
  // An interpreter by itself: python x.py, py -3 x.py, python3 --version.
  const interp = /^((?:python[\d.]*|py)(?: -\d+(?:\.\d+)?)?(?:\.exe)?)(?=\s|$)(.*)$/i.exec(c);
  if (interp) return { form: interp[1]!, key: "python", rest: interp[2]!.trim() };
  // A runner in front of a tool: npx tsc, pnpm exec tsc.
  const runner = /^((?:npx|pnpm exec|pnpm dlx|yarn dlx|bunx)) ([\w@./-]+)(.*)$/i.exec(c);
  if (runner) return { form: `${runner[1]} ${runner[2]}`, key: runner[2]!.toLowerCase().replace(/\.(exe|cmd)$/i, ""), rest: runner[3]!.trim() };
  const plain = /^(\S+)(.*)$/.exec(c);
  const prog = plain?.[1] ?? c;
  return { form: prog, key: prog.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "").replace(/^.*[\\/]/, ""), rest: plain?.[2]?.trim() ?? "" };
}

/** What one chat shows about each fact: its id with a verdict, and the fact's shape. */
export function verdictsOf(commands: readonly SeenCommand[]): Array<{ fact: Pick<ProjectFact, "id" | "family" | "a" | "b" | "error">; verdict: "confirm" | "contradict" }> {
  const found = new Map<string, { fact: Pick<ProjectFact, "id" | "family" | "a" | "b" | "error">; verdict: "confirm" | "contradict" }>();
  const put = (fact: Pick<ProjectFact, "id" | "family" | "a" | "b" | "error">, verdict: "confirm" | "contradict") => {
    // Within one chat a confirmation wins: it saw the failure and the repair.
    if (found.get(fact.id)?.verdict !== "confirm") found.set(fact.id, { fact, verdict });
  };
  commands.forEach((c, i) => {
    const f = formOf(c.command);
    if (!c.ok && c.error) {
      // A later command that does the same thing another way and works: a form repair.
      const fix = commands.slice(i + 1).find((d) => d.ok && formOf(d.command).key === f.key && formOf(d.command).form.toLowerCase() !== f.form.toLowerCase());
      if (fix) {
        const b = formOf(fix.command).form;
        put({ id: `form:${f.form.toLowerCase()}=>${b.toLowerCase()}`, family: "form_repair", a: f.form, b, error: c.error }, "confirm");
      } else if (c.error === "not found" && !commands.slice(i + 1).some((d) => d.ok && formOf(d.command).key === f.key)) {
        put({ id: `absent:${f.key}`, family: "absent_tool", a: f.form, error: c.error }, "confirm");
      }
    }
  });
  // A form that worked as typed contradicts "it fails here".
  for (const c of commands) {
    if (!c.ok) continue;
    const f = formOf(c.command);
    found.set(`ok:${f.form.toLowerCase()}`, { fact: { id: `ok:${f.form.toLowerCase()}`, family: "form_repair", a: f.form, error: "not found" }, verdict: "contradict" });
    found.set(`okkey:${f.key}`, { fact: { id: `okkey:${f.key}`, family: "absent_tool", a: f.form, error: "not found" }, verdict: "contradict" });
  }
  return [...found.values()];
}

/**
 * The sentence a fact is told as: fixed words, the command forms in code marks.
 *
 * @param f - The fact.
 * @returns One line.
 */
export function factText(f: Pick<ProjectFact, "family" | "a" | "b" | "error">): string {
  const said = f.error === "module missing" ? "a missing module" : "\"not recognized\" / \"not found\"";
  const code = (s: string) => `\`${s.replace(/`/g, "'").slice(0, 80)} …\``;
  return f.family === "form_repair" ? `${code(f.a)} fails here (${said}); ${code(f.b ?? "")} works.` : `${code(f.a)} is not installed here (${said}), and no other way to run it has worked.`;
}

/** Where a project's facts are kept: one JSON file for all projects, keyed by the folder. */
export class ProjectFacts {
  private data?: Record<string, Record<string, ProjectFact>>;

  /** @param file - The JSON file in KesherAI's data folder. */
  constructor(private readonly file: string) {}

  private static key(workspace: string): string {
    return createHash("sha256").update(normalize(workspace).toLowerCase()).digest("hex").slice(0, 24);
  }

  private async load(): Promise<Record<string, Record<string, ProjectFact>>> {
    this.data ??= await readFile(this.file, "utf8").then((t) => JSON.parse(t) as Record<string, Record<string, ProjectFact>>, () => ({}));
    return this.data;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data ?? {}, null, 1));
  }

  /**
   * Folds one chat into its project's facts. Safe to call again for the same
   * chat: its verdict is replaced, not added twice.
   *
   * @param workspace - The project folder.
   * @param chatId - The chat.
   * @param events - Its events.
   * @returns Whether anything changed.
   */
  async learn(workspace: string, chatId: string, events: readonly AgentEvent[]): Promise<boolean> {
    const all = await this.load();
    const facts = (all[ProjectFacts.key(workspace)] ??= {});
    const verdicts = verdictsOf(commandsOf(events));
    let changed = false;
    for (const { fact, verdict } of verdicts) {
      if (verdict === "confirm") {
        const f = (facts[fact.id] ??= { ...fact, chats: {}, state: "candidate" });
        if (f.state === "removed" || f.chats[chatId] === "confirm") continue;
        f.chats[chatId] = "confirm";
        changed = true;
      } else {
        // A working form contradicts the facts that say it fails: form repairs whose `a` it is, absent tools whose key it is.
        const ok = fact.id.startsWith("ok:") ? fact.id.slice(3) : undefined;
        const okKey = fact.id.startsWith("okkey:") ? fact.id.slice(6) : undefined;
        for (const f of Object.values(facts)) {
          if (f.state === "removed" || f.chats[chatId] === "confirm") continue;
          const hit = (ok && f.family === "form_repair" && f.a.toLowerCase() === ok) || (okKey && f.family === "absent_tool" && f.id === `absent:${okKey}`);
          if (hit && f.chats[chatId] !== "contradict") {
            f.chats[chatId] = "contradict";
            changed = true;
          }
        }
      }
    }
    for (const f of Object.values(facts)) {
      if (f.state === "removed") continue;
      const verdictsInOrder = Object.values(f.chats);
      const confirms = verdictsInOrder.filter((v) => v === "confirm").length;
      // Retired by its last two chats contradicting it (one is enough for "not installed": it ran).
      const last2 = verdictsInOrder.slice(-2);
      const retired = f.family === "absent_tool" ? verdictsInOrder.at(-1) === "contradict" : last2.length === 2 && last2.every((v) => v === "contradict");
      const state = retired ? "retired" : confirms >= CONFIRMATIONS ? "active" : "candidate";
      if (state !== f.state) {
        f.state = state;
        changed = true;
      }
    }
    if (changed) await this.save();
    return changed;
  }

  /**
   * A project's facts, newest evidence first.
   *
   * @param workspace - The project folder.
   * @returns Every fact the user may see (removed ones left out).
   */
  async list(workspace: string): Promise<Array<ProjectFact & { text: string; confirmations: number }>> {
    const facts = (await this.load())[ProjectFacts.key(workspace)] ?? {};
    return Object.values(facts)
      .filter((f) => f.state !== "removed")
      .map((f) => ({ ...f, text: factText(f), confirmations: Object.values(f.chats).filter((v) => v === "confirm").length }));
  }

  /**
   * The note told to a new chat in this project, or nothing.
   *
   * @param workspace - The project folder.
   * @returns One note, at most {@link MAX_FACTS} facts and about 150 tokens.
   */
  async note(workspace: string): Promise<string | undefined> {
    const active = (await this.list(workspace)).filter((f) => f.state === "active").sort((a, b) => b.confirmations - a.confirmations);
    const lines: string[] = [];
    for (const f of active.slice(0, MAX_FACTS)) {
      if ([...lines, f.text].join("\n").length > MAX_CHARS) break;
      lines.push(`- ${f.text}`);
    }
    return lines.length ? `Learned in this project from earlier chats (KesherAI saw each one at least ${CONFIRMATIONS} times; the user can remove them on the code page):\n${lines.join("\n")}` : undefined;
  }

  /**
   * Removes a fact for good (it is not learned again).
   *
   * @param workspace - The project folder.
   * @param id - The fact.
   * @returns Whether it was there.
   */
  async remove(workspace: string, id: string): Promise<boolean> {
    const f = (await this.load())[ProjectFacts.key(workspace)]?.[id];
    if (!f) return false;
    f.state = "removed";
    await this.save();
    return true;
  }
}
