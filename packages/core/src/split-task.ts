import type { ModelTurn } from "@kesher/agent";

/**
 * Splitting a big task across the user's computers ("My devices"): the
 * chat's model breaks the task into independent parts, each part runs on
 * a computer's own model at the same time (one part at a time per
 * computer, so no computer is overloaded), and the answers come back
 * together for the chat's model to join into one result.
 *
 * Only text goes to the other computers: the part's instructions and the
 * shared context the chat's model chose to give. No files, no tools, no
 * keys. A part that fails on one computer is tried once on another.
 */

/** One computer that can take parts: its name and its model. */
export interface SplitWorker {
  name: string;
  modelId: string;
  turn: ModelTurn;
}

/** One part of the task. */
export interface SplitPart {
  title: string;
  task: string;
}

/** What one part came back with. */
export interface SplitResult {
  title: string;
  computer: string;
  modelId: string;
  ok: boolean;
  text: string;
  ms: number;
}

const WORKER_PROMPT =
  "You are one of several computers working on parts of one bigger task at the same time. Do ONLY the part you are given, completely and carefully, using the shared context. Do not do the other parts, do not ask questions, and do not add an introduction: reply with the result of your part only. Reply in the language of the task.";

/**
 * Runs the parts across the computers: each computer takes the next part
 * waiting, so faster computers do more.
 *
 * @param parts - The parts (in order; results keep that order).
 * @param workers - The computers (at least one).
 * @param opts.context - Shared context every part gets.
 * @param opts.perPartMs - Time limit for one part.
 * @param opts.onProgress - Called when a part finishes.
 */
export async function runSplit(
  parts: SplitPart[],
  workers: SplitWorker[],
  opts: { context?: string; signal: AbortSignal; perPartMs?: number; onProgress?: (done: number, total: number) => void },
): Promise<SplitResult[]> {
  if (!workers.length) throw new Error("No computer is available.");
  const results: SplitResult[] = new Array(parts.length);
  const waiting = parts.map((_, i) => i);
  // Which computers already failed a part (it is not given to them again), and its last error.
  const failedBy = new Map<number, Set<string>>();
  const lastError = new Map<number, SplitResult>();
  let done = 0;
  const one = async (w: SplitWorker, i: number): Promise<SplitResult> => {
    const p = parts[i]!;
    const started = Date.now();
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.perPartMs ?? 15 * 60_000)]);
    try {
      const r = await w.turn(
        {
          messages: [
            { role: "system", content: WORKER_PROMPT },
            { role: "user", content: `${opts.context ? `Shared context:\n${opts.context}\n\n` : ""}Your part: ${p.title}\n${p.task}` },
          ] as Parameters<ModelTurn>[0]["messages"],
          tools: [],
        },
        signal,
        () => undefined,
      );
      return { title: p.title, computer: w.name, modelId: w.modelId, ok: !!r.text.trim(), text: r.text.trim(), ms: Date.now() - started };
    } catch (err) {
      return { title: p.title, computer: w.name, modelId: w.modelId, ok: false, text: (err as Error).message, ms: Date.now() - started };
    }
  };
  await Promise.all(
    workers.map(async (w) => {
      for (;;) {
        if (opts.signal.aborted) return;
        const at = waiting.findIndex((i) => !failedBy.get(i)?.has(w.name));
        if (at < 0) return;
        const i = waiting.splice(at, 1)[0]!;
        const r = await one(w, i);
        // A failed part goes back for another computer, once per computer.
        if (!r.ok) {
          const by = failedBy.get(i) ?? new Set<string>();
          by.add(w.name);
          failedBy.set(i, by);
          lastError.set(i, r);
          if (by.size < workers.length) {
            waiting.push(i);
            continue;
          }
        }
        results[i] = r;
        opts.onProgress?.(++done, parts.length);
      }
    }),
  );
  return results.map((r, i) => r ?? lastError.get(i) ?? { title: parts[i]!.title, computer: "", modelId: "", ok: false, text: "Stopped.", ms: 0 });
}
