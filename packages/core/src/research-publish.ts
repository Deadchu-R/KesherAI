/**
 * Research reports merge themselves into main (Roee 2026-11-22: research by itself, code through pull requests).
 *
 * The only push to main KesherAI makes: one commit that adds or updates `docs/research/<id>.md` and its line in
 * `docs/research/INDEX.md`, rebased on origin/main and pushed as a fast-forward (never forced). Any other path in
 * the commit refuses the push.
 */

type Git = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** The paths a research merge may touch. */
export function researchPathAllowed(path: string): boolean {
  return /^docs\/research\/[A-Za-z0-9][\w.-]{0,80}\.md$/.test(path) && !path.includes("..");
}

/**
 * INDEX.md with the report's line: replaced when its id is already listed, else added as the first table row.
 *
 * @param index - The index as it is on main.
 * @param id - The report's id (its file name without .md).
 * @param title - One line for the topic column.
 */
export function indexWithLine(index: string, id: string, title: string): string {
  const topic = title.replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  const row = `| ${id} | ${topic} | [${id}.md](${id}.md) |`;
  const lines = index.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  if (at >= 0) {
    lines[at] = row;
    return lines.join("\n");
  }
  const sep = lines.findIndex((l) => /^\|\s*-+\s*\|/.test(l));
  if (sep < 0) return `${index.replace(/\s*$/, "")}\n\n| Id | Topic | File |\n|---|---|---|\n${row}\n`;
  lines.splice(sep + 1, 0, row);
  return lines.join("\n");
}

/**
 * Commits the report and its index line on top of origin/main in its own worktree and pushes it to main. Retries the
 * rebase three times when main moved meanwhile. Refuses (throws) if the commit would touch any other path.
 *
 * @param git - Runs git.
 * @param wt - A worktree used only for this (detached HEAD).
 * @param report - `{ id, title, text }`; text is already redacted.
 * @param author - Git `-c user.name=… -c user.email=…` arguments.
 * @param write - Writes a file in the worktree (path relative to it).
 * @param read - Reads a file in the worktree, "" when missing.
 * @returns The pushed commit.
 */
export async function publishResearch(
  git: Git,
  wt: string,
  report: { id: string; title: string; text: string },
  author: string[],
  write: (path: string, text: string) => Promise<void>,
  read: (path: string) => Promise<string>,
): Promise<string> {
  const file = `docs/research/${report.id}.md`;
  if (!researchPathAllowed(file)) throw new Error("Not a research report path.");
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await git(wt, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], 60_000);
    if (f.code !== 0) throw new Error(`git fetch: ${f.out.slice(0, 200)}`);
    await git(wt, ["checkout", "--quiet", "--detach", "refs/remotes/origin/main"]);
    await git(wt, ["reset", "--quiet", "--hard", "refs/remotes/origin/main"]);
    await write(file, report.text.endsWith("\n") ? report.text : `${report.text}\n`);
    await write("docs/research/INDEX.md", indexWithLine(await read("docs/research/INDEX.md"), report.id, report.title));
    await git(wt, ["add", "--", file, "docs/research/INDEX.md"]);
    const c = await git(wt, [...author, "commit", "--quiet", "--no-verify", "-m", `Research ${report.id}: ${report.title.slice(0, 100)}\n\nDesktop-he: אין שינוי.\nPhone-he: אין שינוי.`]);
    if (c.code !== 0) {
      if (/nothing to commit|no changes added/i.test(c.out)) return (await git(wt, ["rev-parse", "HEAD"])).out.trim();
      throw new Error(c.out.slice(0, 300));
    }
    const names = await git(wt, ["diff", "--name-only", "refs/remotes/origin/main", "HEAD"]);
    const bad = names.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((p) => !researchPathAllowed(p));
    if (names.code !== 0 || bad.length) throw new Error(`A research merge may change only docs/research; refused: ${bad.join(", ").slice(0, 200)}`);
    const p = await git(wt, ["push", "--no-verify", "origin", "HEAD:refs/heads/main"], 60_000);
    if (p.code === 0) return (await git(wt, ["rev-parse", "HEAD"])).out.trim();
    last = p.out;
    if (!/rejected|non-fast-forward|fetch first/i.test(p.out)) break;
  }
  throw new Error(`git push to main failed: ${last.slice(0, 300)}`);
}
