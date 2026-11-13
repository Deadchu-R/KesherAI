/**
 * "Review code" before a push, like Claude Code's desktop: the chat's model reads the uncommitted diff and leaves
 * comments on lines (bugs, risks), which the Changes panel shows on the diff with "Fix" buttons.
 */

/** One comment on a line of the new file. */
export interface ReviewFinding {
  file: string;
  /** Line in the new version of the file (0: the file as a whole). */
  line: number;
  severity: "bug" | "risk" | "nit";
  note: string;
}

/**
 * A unified diff with each added or kept line prefixed by its line number in the new file, so the model can name
 * lines exactly ("L42 +  return x;").
 */
export function numberedDiff(diff: string): string {
  let n = 0;
  return diff
    .split("\n")
    .map((l) => {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (m) {
        n = Number(m[1]);
        return l;
      }
      if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) return l;
      if (l.startsWith("-")) return `      ${l}`;
      if (l.startsWith("+") || l.startsWith(" ")) return `L${String(n++).padEnd(5)}${l}`;
      return l;
    })
    .join("\n");
}

/** What the model is asked. */
export function reviewPrompt(diff: string): string {
  return [
    "Review this change like a careful senior engineer before it is pushed.",
    "Comment ONLY on real problems in the changed lines: bugs, crashes, wrong logic, security holes, data loss, race conditions, missing error handling that matters, broken edge cases. A few style notes only if they matter (severity nit).",
    "Do not praise, do not restate what the code does, do not comment on unchanged lines. If nothing is wrong, answer [].",
    'Lines are marked "L<number>" with their line number in the new file; use that number.',
    'Answer only a JSON array, at most 15 items: [{"file":"path/as/in/diff","line":42,"severity":"bug"|"risk"|"nit","note":"what is wrong and how to fix it, one or two sentences"}]',
    "",
    numberedDiff(diff).slice(0, 60_000),
  ].join("\n");
}

/** Reads the model's answer (tolerating a code fence or words around the JSON). */
export function parseReview(text: string, files: string[]): ReviewFinding[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    const list = JSON.parse(m[0]) as unknown[];
    return list
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        file: String(x.file ?? "").replace(/^[ab]\//, "").trim(),
        line: Math.max(0, Math.floor(Number(x.line) || 0)),
        severity: (["bug", "risk", "nit"].includes(String(x.severity)) ? String(x.severity) : "risk") as ReviewFinding["severity"],
        note: String(x.note ?? "").trim().slice(0, 600),
      }))
      .filter((f) => f.note && (files.includes(f.file) || !files.length))
      .slice(0, 15);
  } catch {
    return [];
  }
}
