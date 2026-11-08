// Writes android-version.json for the app's update button: the build number,
// the APK link, and what changed in the phone app (apps/android only),
// newest first, with dates. A commit can say it in Hebrew too, with a line
// "Phone-he: …" in its message.
// Usage: node version-info.mjs <run number> <version> <owner/repo> <out file>
/* global process */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [run, version, repo, out = "android-version.json"] = process.argv.slice(2);
// Commits that changed only the version number (every computer release does) are not phone changes.
const log = execSync("git log -60 --format=%H%x1f%ct%x1f%s%x1f%b%x1e -- apps/android ':(exclude)apps/android/package.json'", { encoding: "utf8" })
  .split("\x1e")
  .map((x) => x.trim())
  .filter(Boolean);
const changes = log.map((l) => {
  const [sha, t, subject, body = ""] = l.split("\x1f");
  const he = /^Phone-he:\s*(.+)$/m.exec(body)?.[1]?.trim();
  return { sha, t: Number(t), subject: subject.replace(/^Phone( app)?:\s*/i, ""), ...(he ? { he } : {}) };
});
writeFileSync(
  out,
  JSON.stringify({
    versionCode: Number(run),
    versionName: `${version} (${run})`,
    apkUrl: `https://github.com/${repo}/releases/download/android-latest/KesherAI-android.apk`,
    changes,
  }),
);
