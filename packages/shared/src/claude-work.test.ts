import { test } from "node:test";
import assert from "node:assert/strict";
import { commitUrl, groupClaudeSessions, parseClaudeLog, parseSessionTrailer, releaseOf, splitToday } from "./claude-work.js";

const S1 = "https://claude.ai/code/session_AAA";
const S2 = "https://claude.ai/code/session_BBB";
/** One log record in the CLAUDE_LOG_FORMAT shape. */
const rec = (sha: string, ct: number, msg: string, files: string[] = []) => `\x1e${sha}\x1f${ct}\x1f${msg}\n\x1f\n${files.join("\n")}\n`;

test("trailer: the last Claude-Session line wins, none gives undefined, other hosts and inline text are ignored", () => {
  assert.equal(parseSessionTrailer(`T\n\nbody\n\nCo-Authored-By: X\nClaude-Session: ${S1}`), S1);
  assert.equal(parseSessionTrailer(`T\n\nClaude-Session: ${S1}\nClaude-Session: ${S2}\n`), S2);
  assert.equal(parseSessionTrailer("T\n\nno trailer here"), undefined);
  assert.equal(parseSessionTrailer(`T mentions Claude-Session: ${S1} inline`), undefined);
  assert.equal(parseSessionTrailer("Claude-Session: javascript:alert(1)"), undefined);
});

test("release subjects: 0.6.504: and 0.6.504 - yes; plain text and 10.2 no", () => {
  assert.equal(releaseOf("0.6.504: Agents panel"), "0.6.504");
  assert.equal(releaseOf("0.6.9 - x"), "0.6.9");
  assert.equal(releaseOf("Fix 0.6.504 bug"), undefined);
  assert.equal(releaseOf("0.6: nothing"), undefined);
});

test("log: only commits with a trailer return; files are counted; the next release after a commit is its release", () => {
  const log = [
    rec("e".repeat(40), 5000, "0.6.505: later release"),
    rec("d".repeat(40), 4000, `Not yet released\n\nClaude-Session: ${S1}`, ["a.ts"]),
    rec("c".repeat(40), 3000, "0.6.504: release", ["package.json"]),
    rec("b".repeat(40), 2000, `Built it\n\nCo-Authored-By: C\nClaude-Session: ${S1}`, ["a.ts", "b.ts"]),
    rec("a".repeat(40), 1000, "Plain commit, no trailer", ["x"]),
  ].join("");
  const c = parseClaudeLog(log);
  assert.deepEqual(c.map((x) => [x.title, x.files, x.release]), [["Not yet released", 1, "0.6.505"], ["Built it", 2, "0.6.504"]]);
  assert.equal(c[0]!.at, 4_000_000);
  const none = parseClaudeLog(rec("d".repeat(40), 4000, `Latest\n\nClaude-Session: ${S1}`));
  assert.equal(none[0]!.release, undefined, "no release after it: not released yet");
  assert.deepEqual(parseClaudeLog("garbage \x1e\x1fx\x1f"), []);
});

test("grouping: by session url, newest first, a release commit does not title the session, the 7-day window drops old ones", () => {
  const now = 10 * 86_400_000;
  const d = (n: number) => now - n * 86_400_000;
  const mk = (sha: string, at: number, title: string, session: string) => ({ sha, at, title, files: 1, session });
  const s = groupClaudeSessions([
    mk("1", d(0.1), "0.6.9: rel", S1),
    mk("2", d(0.2), "Feature A", S1),
    mk("3", d(1), "Other work", S2),
    mk("4", d(8), "Too old", S2),
    mk("5", d(8), "Only old", "https://claude.ai/code/session_CCC"),
  ], now);
  assert.deepEqual(s.map((x) => [x.id, x.title, x.commits.length]), [["session_AAA", "Feature A", 2], ["session_BBB", "Other work", 1]]);
  assert.equal(s[0]!.commits[0]!.sha, "1");
  const edge = groupClaudeSessions([mk("6", d(7), "Edge", S1)], now);
  assert.equal(edge.length, 1, "exactly 7 days is still in");
});

test("today / this week split by the local day", () => {
  const now = new Date(2026, 10, 28, 15, 0).getTime();
  const at = (h: number, day = 28) => new Date(2026, 10, day, h).getTime();
  const sess = (id: string, t: number) => ({ url: id, id, title: id, at: t, commits: [] });
  const r = splitToday([sess("a", at(14)), sess("b", at(1)), sess("c", at(23, 27))], now);
  assert.deepEqual([r.today.map((s) => s.id), r.week.map((s) => s.id)], [["a", "b"], ["c"]]);
});

test("commit links: github https and ssh forms only, credentials and other hosts give nothing", () => {
  const sha = "a".repeat(40);
  assert.equal(commitUrl("https://github.com/o/r.git", sha), `https://github.com/o/r/commit/${sha}`);
  assert.equal(commitUrl("git@github.com:o/r.git", sha), `https://github.com/o/r/commit/${sha}`);
  assert.equal(commitUrl("https://user:tok@github.com/o/r", sha), undefined, "a password in the URL is not accepted");
  assert.equal(commitUrl("https://tok@github.com/o/r", sha), `https://github.com/o/r/commit/${sha}`, "a bare token user is dropped");
  assert.equal(commitUrl("https://evil.example/o/r", sha), undefined);
  assert.equal(commitUrl("https://github.com/o/r", "zzz"), undefined);
});
