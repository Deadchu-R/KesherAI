/**
 * Reviewing a build sub-agent's diff hunk by hunk (chat step 9b, RESEARCH_LOG "Chat step 9: file reading and hunk
 * review"; as Cursor's Accept / Reject per change and Copilot's Keep / Undo): the diff split into files and hunks for
 * the card, and one hunk applied to the file as it is now. A hunk is applied only where its old lines are still found
 * exactly, so a file that changed meanwhile gives a conflict instead of a blind write.
 *
 * Pure (no file access): the server reads and writes the files, the page renders the same parse.
 */

/** One hunk of a unified diff. */
export interface DiffHunk {
  /** The "@@ -a,b +c,d @@ …" line. */
  header: string;
  /** Where the old lines start (1-based; 0 for a new file). */
  oldStart: number;
  /** The hunk's lines with their " ", "-", "+" or "\" mark. */
  lines: string[];
}

/** One file of a diff. */
export interface DiffFile {
  /** The path after the change (before it, for a deleted file), "/" separated, relative to the repository. */
  path: string;
  kind: "modify" | "add" | "delete" | "binary";
  hunks: DiffHunk[];
  /** The diff was cut inside this file: its last hunk is incomplete and left out. */
  cut?: boolean;
}

/** A decision on one hunk. */
export type HunkDecision = "accepted" | "rejected";

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const unquote = (p: string) => p.replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, "");

/**
 * Splits a `git diff` into files and hunks. Renames are shown as the new path; a hunk whose line counts do not add up
 * (the diff was cut short) is dropped and its file marked `cut`.
 *
 * @param diff - The diff text.
 * @returns The files, in order.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: (DiffHunk & { oldLeft: number; newLeft: number }) | undefined;
  const close = () => {
    if (!file || !hunk) return;
    if (hunk.oldLeft > 0 || hunk.newLeft > 0) file.cut = true;
    else file.hunks.push({ header: hunk.header, oldStart: hunk.oldStart, lines: hunk.lines });
    hunk = undefined;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      close();
      const m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      file = { path: m ? unquote(m[2]!) : line.slice(11), kind: "modify", hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      const mark = line[0];
      if (mark === " " || mark === "-" || mark === "+" || mark === "\\" || line === "") {
        // An empty line inside a hunk is a context line whose space was trimmed.
        const l = line === "" ? " " : line;
        hunk.lines.push(l);
        if (mark !== "+" && mark !== "\\") hunk.oldLeft--;
        if (mark !== "-" && mark !== "\\") hunk.newLeft--;
        continue;
      }
    }
    if (hunk && line.startsWith("\\")) {
      hunk.lines.push(line);
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      close();
      hunk = { header: line, oldStart: Number(h[1]), lines: [], oldLeft: h[2] === undefined ? 1 : Number(h[2]), newLeft: h[4] === undefined ? 1 : Number(h[4]) };
      continue;
    }
    if (line.startsWith("new file mode")) file.kind = "add";
    else if (line.startsWith("deleted file mode")) file.kind = "delete";
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.kind = "binary";
    else if (line.startsWith("--- ") && file.kind === "delete") file.path = unquote(line.slice(4));
  }
  close();
  return files;
}

/** What applying a hunk gave. */
export type HunkResult =
  | { ok: true; text: string | null; already?: boolean }
  | { ok: false; reason: string };

/**
 * Applies one hunk to a file's text as it is now. The hunk's old lines (context and removed) must be found exactly,
 * at their line or the nearest place to it (other hunks of the file may have moved it); if only its new lines are
 * found, it was applied before (`already`).
 *
 * @param now - The file's text now (`null` when it does not exist).
 * @param file - The hunk's file (its kind decides creating and deleting).
 * @param hunk - The hunk.
 * @returns The new text (`null` = delete the file), or why it could not be applied.
 */
export function applyHunk(now: string | null, file: Pick<DiffFile, "kind">, hunk: DiffHunk): HunkResult {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let oldEol = true;
  let newEol = true;
  let last = "";
  for (const l of hunk.lines) {
    if (l.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line before it.
      if (last === "-" || last === " ") oldEol = false;
      if (last === "+" || last === " ") newEol = false;
      continue;
    }
    last = l[0]!;
    if (last !== "+") oldLines.push(l.slice(1));
    if (last !== "-") newLines.push(l.slice(1));
  }
  const join = (lines: string[], eol: boolean) => (lines.length ? lines.join("\n") + (eol ? "\n" : "") : "");
  if (file.kind === "add") {
    const made = join(newLines, newEol);
    if (now === null) return { ok: true, text: made };
    return now === made ? { ok: true, text: now, already: true } : { ok: false, reason: "The file already exists with other content." };
  }
  if (now === null) return file.kind === "delete" ? { ok: true, text: null, already: true } : { ok: false, reason: "The file is not there any more." };
  if (file.kind === "delete") {
    return now === join(oldLines, oldEol) ? { ok: true, text: null } : { ok: false, reason: "The file changed since the agent read it." };
  }
  const had = now.endsWith("\n");
  const lines = now.split("\n");
  if (had) lines.pop();
  const at = findBlock(lines, oldLines, Math.max(0, hunk.oldStart - 1));
  if (at < 0) {
    const done = newLines.length ? findBlock(lines, newLines, Math.max(0, hunk.oldStart - 1)) : -1;
    return done >= 0 ? { ok: true, text: now, already: true } : { ok: false, reason: "This part of the file changed since the agent read it." };
  }
  const touchesEnd = at + oldLines.length === lines.length;
  const out = [...lines.slice(0, at), ...newLines, ...lines.slice(at + oldLines.length)];
  // The file's last newline follows the hunk when the hunk reaches the end, and stays as it was otherwise.
  const eol = touchesEnd ? newEol : had;
  return { ok: true, text: out.length ? out.join("\n") + (eol ? "\n" : "") : "" };
}

/** @returns Where `block` is found in `lines`, the nearest to `near` first; -1 when it is not. */
function findBlock(lines: string[], block: string[], near: number): number {
  if (!block.length) return Math.min(near, lines.length);
  const fits = (at: number) => at >= 0 && at + block.length <= lines.length && block.every((b, i) => lines[at + i] === b);
  for (let d = 0; d <= lines.length; d++) {
    if (fits(near - d)) return near - d;
    if (d && fits(near + d)) return near + d;
  }
  return -1;
}
