/**
 * Applying a build sub-agent's diff hunk by hunk to the user's folder (chat step 9b, RESEARCH_LOG "Chat step 9: file
 * reading and hunk review"). The card sends the user's Accept / Reject for one hunk, a file or everything; accepted
 * hunks are written only where the file still matches the diff (`applyHunk`), and the file is read again just before
 * the write, so a change made in between is never overwritten.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveInWorkspace } from "@kesher/agent";
import { applyHunk, parseDiff, type HunkDecision } from "@kesher/shared";

/** What the user decided on the card. */
export interface ReviewRequest {
  /** One file (its path as in the diff); absent = every file shown on the card. */
  path?: string;
  /** Hunk indexes in that file; absent = all of them. */
  hunks?: number[];
  decision: HunkDecision;
}

/** What a review did. */
export interface ReviewOutcome {
  /** The decisions to keep on the run: per file, per hunk. */
  decisions: Record<string, Record<number, HunkDecision>>;
  /** Hunks that could not be applied (the file changed), per file: their indexes and why. */
  conflicts: Array<{ path: string; hunk: number; reason: string }>;
  /** Files written (or deleted), with their text before, for the chat's Undo. */
  written: Array<{ path: string; before: string | null }>;
  /** One short line for the lead agent. */
  summary: string;
}

/**
 * Applies or rejects hunks of a build run's diff.
 *
 * @param o.root - The repository's top folder (the diff's paths are relative to it).
 * @param o.shown - The diff the card shows (only its files and hunks can be decided).
 * @param o.full - The whole diff (the same hunks, read from here).
 * @param o.done - Decisions already made (a decided hunk is not applied twice).
 * @param o.request - The user's decision.
 * @returns What was done.
 */
export async function reviewHunks(o: { root: string; shown: string; full: string; done?: Record<string, Record<number, HunkDecision>>; request: ReviewRequest }): Promise<ReviewOutcome> {
  const shown = parseDiff(o.shown);
  const full = new Map(parseDiff(o.full).map((f) => [f.path, f]));
  const out: ReviewOutcome = { decisions: {}, conflicts: [], written: [], summary: "" };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const card of shown) {
    if (o.request.path !== undefined && card.path !== o.request.path) continue;
    const file = full.get(card.path) ?? card;
    const open = card.hunks.map((_, i) => i).filter((i) => !o.done?.[card.path]?.[i] && (!o.request.hunks || o.request.hunks.includes(i)));
    if (!open.length) continue;
    if (o.request.decision === "rejected") {
      out.decisions[card.path] = Object.fromEntries(open.map((i) => [i, "rejected"]));
      dropped.push(`${card.path} (${open.length})`);
      continue;
    }
    if (file.kind === "binary") {
      out.conflicts.push(...open.map((hunk) => ({ path: card.path, hunk, reason: "A binary file cannot be applied here." })));
      continue;
    }
    if (/(^|[\\/])\.git([\\/]|$)/.test(card.path)) throw new Error("A change inside .git is never applied.");
    const target = await resolveInWorkspace(o.root, card.path);
    const read = () => readFile(target, "utf8").then((t) => t as string | null, () => null);
    const before = await read();
    let text = before;
    const applied: number[] = [];
    for (const i of open) {
      const r = applyHunk(text, file, file.hunks[i]!);
      if (!r.ok) {
        out.conflicts.push({ path: card.path, hunk: i, reason: r.reason });
        continue;
      }
      text = r.text;
      applied.push(i);
    }
    if (!applied.length) continue;
    if (text !== before) {
      // Read again just before writing: an edit made meanwhile (an editor, the lead agent) wins, nothing is written.
      if ((await read()) !== before) {
        out.conflicts.push(...applied.map((hunk) => ({ path: card.path, hunk, reason: "The file changed while this was applied." })));
        continue;
      }
      if (text === null) await rm(target, { force: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text, "utf8");
      }
      out.written.push({ path: target, before });
    }
    out.decisions[card.path] = Object.fromEntries(applied.map((i) => [i, "accepted"]));
    kept.push(`${card.path} (${applied.length})`);
  }
  const parts = [kept.length ? `kept and applied to the user's folder: ${kept.join(", ")}` : "", dropped.length ? `rejected: ${dropped.join(", ")}` : "", out.conflicts.length ? `not applied, the file changed since: ${[...new Set(out.conflicts.map((c) => c.path))].join(", ")}` : ""].filter(Boolean);
  out.summary = parts.length ? `The user reviewed the build agent's changes (hunks in brackets): ${parts.join("; ")}.` : "";
  return out;
}
