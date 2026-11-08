// Writes the "what's new" list for a desktop release, from the commits since the previous release.
// Each commit may carry `Desktop-he: …` lines (shown in Hebrew in the app before updating);
// commits without one show their subject. Phone-only and housekeeping commits are left out.
// Usage: node scripts/release-notes.mjs [version] > notes.md
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
const current = `v${version}`;
const tags = git("tag", "-l", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
const previous = tags.find((t) => t !== current && !/-/.test(t));
const range = previous ? `${previous}..HEAD` : "HEAD~30..HEAD";
const SEP = "\u001e";
const log = git("log", range, "--no-merges", `--format=%s%n%b${SEP}`);
const lines = [];
for (const entry of log.split(SEP)) {
  const [subject = "", ...body] = entry.trim().split("\n");
  if (!subject) continue;
  const he = body.filter((l) => /^Desktop-he:/i.test(l.trim())).map((l) => l.trim().replace(/^Desktop-he:\s*/i, ""));
  if (he.length) {
    lines.push(...he);
    continue;
  }
  // Leave out phone-only changes (they have their own notes), versions and test-only commits.
  if (body.some((l) => /^Phone-he:/i.test(l.trim())) || /^(Version |Phone|Android|Release|Journal test|Lint|Doc comment)/i.test(subject) || /\(lint\)$/.test(subject)) continue;
  lines.push(subject.replace(/^\d+\.\d+\.\d+:\s*/, ""));
}
const unique = [...new Set(lines)].slice(0, 25);
process.stdout.write(`### מה חדש · What's new\n\n${unique.length ? unique.map((l) => `- ${l}`).join("\n") : "- Fixes and improvements"}\n\n**Windows:** \`KesherAI-Setup-${version}.exe\` · **Mac:** \`.dmg\` · **Linux:** \`.AppImage\`\n\n[Code signing policy](https://github.com/Deadchu-R/KesherAI/blob/main/docs/CODE_SIGNING.md)\n`);
