import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pipelines: saved multi-step jobs that chain models and tools, with
 * conditions and loops. For example: transcribe a recording → summarize →
 * for each action item write an email; or write → review → rewrite until
 * the reviewer approves.
 *
 * A pipeline is JSON: inputs the user fills in, and steps. Text fields are
 * templates: `{{name}}` is an input or an earlier step's output, `{{item}}`
 * and `{{index}}` inside a loop.
 */

/** One step. Steps that make something name the variable they put it in (`output`). */
export type Step =
  | { id: string; type: "ask"; prompt: string; system?: string; model?: string; persona?: string; output: string }
  | { id: string; type: "knowledge"; query: string; base?: string; output: string }
  | { id: string; type: "image"; prompt: string; width?: number; height?: number; output: string }
  | { id: string; type: "transcribe"; path: string; output: string }
  | { id: string; type: "set"; value: string; output: string }
  | { id: string; type: "save"; file: string; content: string }
  | { id: string; type: "notify"; message: string }
  | { id: string; type: "if"; test: Test; then: Step[]; else?: Step[] }
  | { id: string; type: "loop"; mode: "times" | "lines" | "until"; count?: number; over?: string; until?: Test; max?: number; steps: Step[] }
  | { id: string; type: "break" };

/** A condition: on text (contains, equals, a regular expression), or a model's yes/no. */
export interface Test {
  kind: "contains" | "equals" | "regex" | "ask" | "empty";
  /** The text tested (a template), e.g. `{{review}}`. */
  text: string;
  /** What to look for (contains/equals/regex), or the yes/no question (ask). */
  value?: string;
  /** True: the test passes when it does NOT match. */
  not?: boolean;
}

/** A saved pipeline. */
export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  inputs: Array<{ name: string; label?: string; long?: boolean }>;
  steps: Step[];
  updatedAt: string;
}

/** A line in a run's log. */
export interface RunLine {
  at: string;
  step: string;
  type: Step["type"] | "start" | "done" | "error";
  text: string;
}

/** One run. */
export interface Run {
  id: string;
  pipelineId: string;
  name: string;
  status: "running" | "done" | "error" | "stopped";
  startedAt: string;
  endedAt?: string;
  inputs: Record<string, string>;
  vars: Record<string, string>;
  log: RunLine[];
  /** Files the run saved, relative to its folder. */
  files: string[];
  error?: string;
}

/** What steps run on. */
export interface PipelineDeps {
  ask(req: { prompt: string; system?: string; model?: string; persona?: string }, signal: AbortSignal): Promise<string>;
  knowledge(query: string, base?: string): Promise<string>;
  image(req: { prompt: string; width?: number; height?: number }, signal: AbortSignal): Promise<Array<{ data: Uint8Array; mimeType: string }>>;
  transcribe(path: string): Promise<string>;
  notify(title: string, body: string): Promise<void>;
}

const MAX_STEPS = 2000;

/**
 * Fills a template.
 *
 * @param t - Text with `{{name}}` places.
 * @param vars - Values.
 * @returns The text.
 */
export function fill(t: string, vars: Record<string, string>): string {
  return t.replace(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu, (_m, k: string) => vars[k] ?? "");
}

class Break {}

/** Checks a pipeline before it is saved, with a readable message. */
export function validate(p: Pick<Pipeline, "name" | "steps" | "inputs">): void {
  if (!p.name?.trim()) throw new Error("Give the pipeline a name.");
  const walk = (steps: Step[], inLoop: boolean, depth: number) => {
    if (depth > 8) throw new Error("Too many steps inside each other (8 at most).");
    if (!Array.isArray(steps)) throw new Error("steps must be a list.");
    for (const s of steps) {
      if (!s || typeof s !== "object" || !s.type) throw new Error("Every step needs a type.");
      if ("output" in s && !/^[\p{L}\p{N}_-]+$/u.test(s.output ?? "")) throw new Error(`Step "${s.id}": name its output with letters, digits or _ (it is used as {{name}}).`);
      if (s.type === "break" && !inLoop) throw new Error("A break step only works inside a loop.");
      if (s.type === "if") {
        walk(s.then ?? [], inLoop, depth + 1);
        walk(s.else ?? [], inLoop, depth + 1);
      }
      if (s.type === "loop") {
        if (s.mode === "until" && !s.until) throw new Error(`Loop "${s.id}": say when it stops (until).`);
        walk(s.steps ?? [], true, depth + 1);
      }
    }
  };
  walk(p.steps, false, 0);
}

/** Keeps pipelines and runs them. */
export class Pipelines {
  private runs = new Map<string, { run: Run; abort: AbortController }>();

  /**
   * @param dir - pipelines folder in KesherAI's data.
   * @param outputs - Where runs save their files (one folder per run).
   * @param deps - Models and tools.
   */
  constructor(
    private readonly dir: string,
    private readonly outputs: string,
    private readonly deps: PipelineDeps,
  ) {}

  private file(id: string) {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9-]/g, "")}.json`);
  }

  /** @returns All pipelines, by name. */
  async list(): Promise<Pipeline[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readFile(join(this.dir, n), "utf8").then((t) => JSON.parse(t) as Pipeline, () => undefined)));
    return all.filter((p): p is Pipeline => !!p?.id).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @returns One pipeline. */
  async get(id: string): Promise<Pipeline | undefined> {
    return readFile(this.file(id), "utf8").then((t) => JSON.parse(t) as Pipeline, () => undefined);
  }

  /**
   * Saves a pipeline (new when it has no id).
   *
   * @param p - The pipeline.
   * @returns It, saved.
   */
  async save(p: Partial<Pipeline> & { name: string; steps: Step[] }): Promise<Pipeline> {
    const inputs = (p.inputs ?? []).filter((i) => i?.name?.trim()).map((i) => ({ name: i.name.trim(), ...(i.label ? { label: i.label } : {}), ...(i.long ? { long: true } : {}) }));
    validate({ name: p.name, steps: p.steps, inputs });
    let n = 0;
    const ids = (steps: Step[]): Step[] =>
      steps.map((s) => {
        const id = s.id?.trim() || `s${++n}`;
        if (s.type === "if") return { ...s, id, then: ids(s.then ?? []), ...(s.else ? { else: ids(s.else) } : {}) };
        if (s.type === "loop") return { ...s, id, steps: ids(s.steps ?? []) };
        return { ...s, id } as Step;
      });
    const saved: Pipeline = { id: p.id ?? randomUUID(), name: p.name.trim().slice(0, 80), ...(p.description ? { description: p.description.slice(0, 500) } : {}), inputs, steps: ids(p.steps), updatedAt: new Date().toISOString() };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(saved.id), JSON.stringify(saved, null, 2));
    return saved;
  }

  /** Deletes a pipeline. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /** @returns A run (live or finished in this session). */
  run(id: string): Run | undefined {
    return this.runs.get(id)?.run;
  }

  /** @returns Recent runs, newest first. */
  recent(): Run[] {
    return [...this.runs.values()].map((r) => r.run).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }

  /** Stops a run. */
  stop(id: string): void {
    this.runs.get(id)?.abort.abort();
  }

  /**
   * Starts a pipeline; it runs in the background.
   *
   * @param pipelineId - The pipeline.
   * @param inputs - Values for its inputs.
   * @returns The run (follow it with {@link run}).
   */
  async start(pipelineId: string, inputs: Record<string, string>): Promise<Run> {
    const p = await this.get(pipelineId);
    if (!p) throw new Error("No such pipeline.");
    const run: Run = { id: randomUUID(), pipelineId, name: p.name, status: "running", startedAt: new Date().toISOString(), inputs, vars: { ...inputs }, log: [], files: [] };
    const abort = new AbortController();
    this.runs.set(run.id, { run, abort });
    const finished = this.exec(p, run, abort.signal);
    finished.catch(() => undefined);
    (run as Run & { done?: Promise<void> }).done = finished;
    return run;
  }

  /**
   * Runs a pipeline to the end (for tests and the API's `wait`).
   *
   * @param runId - A started run.
   */
  async wait(runId: string): Promise<Run | undefined> {
    const r = this.runs.get(runId)?.run as (Run & { done?: Promise<void> }) | undefined;
    await r?.done;
    return r;
  }

  private async exec(p: Pipeline, run: Run, signal: AbortSignal): Promise<void> {
    let count = 0;
    const folder = join(this.outputs, run.id);
    const log = (step: string, type: RunLine["type"], text: string) => {
      run.log.push({ at: new Date().toISOString(), step, type, text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text });
      if (run.log.length > 1000) run.log.splice(0, run.log.length - 1000);
    };
    const test = async (t: Test, vars: Record<string, string>): Promise<boolean> => {
      const text = fill(t.text, vars);
      const value = fill(t.value ?? "", vars);
      let ok: boolean;
      if (t.kind === "contains") ok = text.toLowerCase().includes(value.toLowerCase());
      else if (t.kind === "equals") ok = text.trim().toLowerCase() === value.trim().toLowerCase();
      else if (t.kind === "regex") ok = new RegExp(value, "i").test(text);
      else if (t.kind === "empty") ok = !text.trim();
      else {
        const a = await this.deps.ask({ prompt: `${value}\n\n---\n${text}\n---\n\nAnswer only YES or NO.`, system: "You answer yes/no questions about a text. Reply with exactly one word: YES or NO." }, signal);
        ok = /^\W*(yes|כן)\b/i.test(a.trim());
      }
      return t.not ? !ok : ok;
    };
    const steps = async (list: Step[], vars: Record<string, string>): Promise<void> => {
      for (const s of list) {
        if (signal.aborted) throw new Error("stopped");
        if (++count > MAX_STEPS) throw new Error(`The pipeline ran more than ${MAX_STEPS} steps; stopped (check the loops).`);
        await step(s, vars);
      }
    };
    const step = async (s: Step, vars: Record<string, string>): Promise<void> => {
      switch (s.type) {
        case "ask": {
          log(s.id, s.type, `Asking${s.model ? ` ${s.model}` : ""}…`);
          const out = await this.deps.ask({ prompt: fill(s.prompt, vars), ...(s.system ? { system: fill(s.system, vars) } : {}), ...(s.model ? { model: s.model } : {}), ...(s.persona ? { persona: s.persona } : {}) }, signal);
          vars[s.output] = out;
          log(s.id, s.type, `${s.output} = ${out}`);
          return;
        }
        case "knowledge":
          vars[s.output] = await this.deps.knowledge(fill(s.query, vars), s.base);
          log(s.id, s.type, `${s.output} = ${vars[s.output]}`);
          return;
        case "image": {
          const prompt = fill(s.prompt, vars);
          log(s.id, s.type, `Making an image: ${prompt}`);
          const files = await this.deps.image({ prompt, ...(s.width ? { width: s.width } : {}), ...(s.height ? { height: s.height } : {}) }, signal);
          await mkdir(folder, { recursive: true });
          const names: string[] = [];
          for (const f of files) {
            const name = `${s.output}-${run.files.length + 1}.${f.mimeType.split("/")[1] ?? "png"}`;
            await writeFile(join(folder, name), f.data);
            run.files.push(name);
            names.push(name);
          }
          vars[s.output] = names.join(", ");
          log(s.id, s.type, `Saved ${vars[s.output]}`);
          return;
        }
        case "transcribe": {
          const path = fill(s.path, vars).trim().replace(/^"|"$/g, "");
          log(s.id, s.type, `Transcribing ${path}…`);
          vars[s.output] = await this.deps.transcribe(path);
          log(s.id, s.type, `${s.output} = ${vars[s.output]}`);
          return;
        }
        case "set":
          vars[s.output] = fill(s.value, vars);
          log(s.id, s.type, `${s.output} = ${vars[s.output]}`);
          return;
        case "save": {
          const name = fill(s.file, vars).replace(/[\\/:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 120) || "result.txt";
          await mkdir(folder, { recursive: true });
          await writeFile(join(folder, name), fill(s.content, vars));
          if (!run.files.includes(name)) run.files.push(name);
          log(s.id, s.type, `Saved ${name}`);
          return;
        }
        case "notify":
          await this.deps.notify(p.name, fill(s.message, vars)).catch(() => undefined);
          log(s.id, s.type, fill(s.message, vars));
          return;
        case "if": {
          const ok = await test(s.test, vars);
          log(s.id, s.type, ok ? "Yes → then" : "No → else");
          await steps(ok ? s.then : s.else ?? [], vars);
          return;
        }
        case "loop": {
          const max = Math.min(500, Math.max(1, s.max ?? (s.mode === "until" ? 10 : 100)));
          const items = s.mode === "lines" ? fill(s.over ?? "", vars).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, max) : [];
          const n = s.mode === "times" ? Math.min(max, Math.max(0, Math.round(s.count ?? 1))) : s.mode === "lines" ? items.length : max;
          log(s.id, s.type, s.mode === "lines" ? `${items.length} items` : s.mode === "times" ? `${n} times` : `until the test passes (at most ${max})`);
          for (let i = 0; i < n; i++) {
            vars.index = String(i + 1);
            if (s.mode === "lines") vars.item = items[i]!;
            try {
              await steps(s.steps, vars);
            } catch (e) {
              if (e instanceof Break) break;
              throw e;
            }
            if (s.mode === "until" && s.until && (await test(s.until, vars))) {
              log(s.id, s.type, `Done after ${i + 1} round(s).`);
              break;
            }
          }
          return;
        }
        case "break":
          log(s.id, s.type, "Leaving the loop.");
          throw new Break();
      }
    };
    log("-", "start", `Started ${p.name}`);
    try {
      await steps(p.steps, run.vars);
      run.status = "done";
      log("-", "done", "Finished.");
    } catch (e) {
      run.status = signal.aborted ? "stopped" : "error";
      if (!signal.aborted) run.error = (e as Error).message;
      log("-", signal.aborted ? "done" : "error", signal.aborted ? "Stopped." : (e as Error).message);
    } finally {
      run.endedAt = new Date().toISOString();
    }
  }
}

/** Ready-made pipelines to start from. */
export const PIPELINE_TEMPLATES: Array<Omit<Pipeline, "id" | "updatedAt">> = [
  {
    name: "Write, review, improve",
    description: "A model writes, a reviewer checks it, and it is rewritten until the reviewer approves (up to 4 rounds).",
    inputs: [{ name: "task", label: "What to write", long: true }],
    steps: [
      { id: "draft", type: "ask", prompt: "{{task}}", output: "draft" },
      {
        id: "rounds",
        type: "loop",
        mode: "until",
        max: 4,
        until: { kind: "contains", text: "{{review}}", value: "APPROVED" },
        steps: [
          { id: "check", type: "ask", system: "You are a demanding reviewer.", prompt: "Task: {{task}}\n\nDraft:\n{{draft}}\n\nIf the draft fully does the task well, answer only APPROVED. Otherwise list the problems to fix.", output: "review" },
          { id: "fix", type: "if", test: { kind: "contains", text: "{{review}}", value: "APPROVED", not: true }, then: [{ id: "rewrite", type: "ask", prompt: "Task: {{task}}\n\nDraft:\n{{draft}}\n\nFix these problems and give the full new version only:\n{{review}}", output: "draft" }] },
        ],
      },
      { id: "keep", type: "save", file: "result.md", content: "{{draft}}" },
    ],
  },
  {
    name: "Meeting recording → notes and emails",
    description: "Transcribe a recording, write notes, then a short email for each action item.",
    inputs: [{ name: "recording", label: "Full path of the recording" }],
    steps: [
      { id: "text", type: "transcribe", path: "{{recording}}", output: "transcript" },
      { id: "notes", type: "ask", prompt: "Write meeting notes from this transcript: summary, decisions, action items.\n\n{{transcript}}", output: "notes" },
      { id: "items", type: "ask", prompt: "List only the action items from these notes, one per line, as 'owner: task':\n\n{{notes}}", output: "actions" },
      { id: "each", type: "loop", mode: "lines", over: "{{actions}}", steps: [{ id: "mail", type: "ask", prompt: "Write a short friendly email asking about this action item from our meeting:\n{{item}}", output: "email" }, { id: "keepmail", type: "save", file: "email-{{index}}.txt", content: "{{email}}" }] },
      { id: "keepnotes", type: "save", file: "notes.md", content: "{{notes}}" },
      { id: "tell", type: "notify", message: "Meeting notes and emails are ready." },
    ],
  },
  {
    name: "Translate line by line",
    description: "Translate every line of a text separately (good for subtitles and UI strings).",
    inputs: [{ name: "text", label: "Lines to translate", long: true }, { name: "language", label: "Into which language" }],
    steps: [
      { id: "start", type: "set", value: "", output: "all" },
      { id: "each", type: "loop", mode: "lines", over: "{{text}}", steps: [{ id: "tr", type: "ask", prompt: "Translate into {{language}}. Only the translation:\n{{item}}", output: "line" }, { id: "add", type: "set", value: "{{all}}{{line}}\n", output: "all" }] },
      { id: "keep", type: "save", file: "translation.txt", content: "{{all}}" },
    ],
  },
  {
    name: "Ideas → pictures",
    description: "Brainstorm image ideas on a theme, then make a picture of each.",
    inputs: [{ name: "theme", label: "Theme" }],
    steps: [
      { id: "ideas", type: "ask", prompt: "Give 4 short, vivid image prompts on the theme: {{theme}}. One per line, nothing else.", output: "ideas" },
      { id: "each", type: "loop", mode: "lines", over: "{{ideas}}", max: 4, steps: [{ id: "pic", type: "image", prompt: "{{item}}", output: "picture" }] },
    ],
  },
];
