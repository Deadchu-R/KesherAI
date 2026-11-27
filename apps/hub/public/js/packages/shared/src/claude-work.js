/**
 * "Agents' work": what Claude's helper agents did, read from the commits on main alone (the one channel both the
 * agents and KesherAI reach, so it costs no tokens). A commit counts when its message ends with a
 * `Claude-Session: <url>` trailer; the commits of one session URL are one group. A commit is "in a release" when a
 * release commit (`0.6.NNN: ...`) came at or after it on main. Pure, so it is tested in Node and the phone page shares it.
 * Layout: the design doc's HubAgentsWork board.
 */
/** How far back the list goes. */
export const CLAUDE_WORK_DAYS = 7;
/** The git log format {@link parseClaudeLog} reads: `\x1e` starts a commit, `\x1f` separates sha, time, message and file names. */
export const CLAUDE_LOG_FORMAT = "%x1e%H%x1f%ct%x1f%B%x1f";
/** A commit message's `Claude-Session:` trailer: the last `https://` URL on such a line, or undefined. */
export function parseSessionTrailer(message) {
    let url;
    for (const m of message.matchAll(/^Claude-Session:[ \t]*(https:\/\/[^\s<>"']{1,200})[ \t]*$/gim))
        url = m[1];
    return url;
}
/** The version a release commit's first line starts with (`0.6.504: ...` gives `0.6.504`), or undefined. */
export function releaseOf(subject) {
    return /^(\d+\.\d+\.\d+)(?:\s*[:\-–]|\s|$)/.exec(subject.trim())?.[1];
}
/**
 * Reads `git log origin/main --format={@link CLAUDE_LOG_FORMAT} --name-only` (newest first) into commits with their
 * session and release. Every commit is read (releases carry no trailer but mark the ones before them); only those
 * with a session trailer are returned.
 *
 * @param log - The git output.
 * @returns The session commits, newest first.
 */
export function parseClaudeLog(log) {
    const raw = [];
    for (const rec of log.split("\x1e")) {
        const [sha, ct, message = "", names = ""] = rec.split("\x1f");
        if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha.trim()) || !/^\d+$/.test((ct ?? "").trim()))
            continue;
        const title = message.trim().split("\n")[0]?.trim().slice(0, 200) ?? "";
        const session = parseSessionTrailer(message);
        const version = releaseOf(title);
        raw.push({ sha: sha.trim(), at: Number(ct) * 1000, title, files: names.split("\n").filter((n) => n.trim()).length, ...(session ? { session } : {}), ...(version ? { version } : {}) });
    }
    // The log is newest first, so the nearest release at or after a commit is the last one seen before it in the list.
    const out = [];
    let next;
    for (const c of raw) {
        if (c.version)
            next = c.version;
        if (c.session)
            out.push({ sha: c.sha, at: c.at, title: c.title, files: c.files, session: c.session, ...(next ? { release: next } : {}) });
    }
    return out;
}
/**
 * Groups session commits by session URL, drops the ones older than the window and sorts the sessions newest first.
 *
 * @param commits - From {@link parseClaudeLog}.
 * @param now - The time now (ms).
 * @param days - The window in days.
 */
export function groupClaudeSessions(commits, now, days = CLAUDE_WORK_DAYS) {
    const from = now - days * 86_400_000;
    const by = new Map();
    for (const c of commits) {
        if (c.at < from)
            continue;
        const list = by.get(c.session);
        if (list)
            list.push(c);
        else
            by.set(c.session, [c]);
    }
    const sessions = [];
    for (const [url, list] of by) {
        list.sort((a, b) => b.at - a.at);
        const lead = list.find((c) => !releaseOf(c.title)) ?? list[0];
        sessions.push({ url, id: url.replace(/\/+$/, "").split("/").pop() ?? url, title: lead.title, at: list[0].at, commits: list });
    }
    return sessions.sort((a, b) => b.at - a.at);
}
/**
 * Splits sessions into those whose newest commit is from the local day of `now` and the rest of the week.
 *
 * @param sessions - From {@link groupClaudeSessions}.
 * @param now - The time now (ms).
 */
export function splitToday(sessions, now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const start = d.getTime();
    return { today: sessions.filter((s) => s.at >= start), week: sessions.filter((s) => s.at < start) };
}
/**
 * The commit's page on GitHub, from the repository's remote URL; undefined unless it is a github.com project (no
 * credentials or other host ever end up in a link).
 *
 * @param remote - The `origin` URL (https or ssh form).
 * @param sha - The commit.
 */
export function commitUrl(remote, sha) {
    const m = /^(?:https:\/\/(?:[^/@:]+@)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
    return m && /^[0-9a-f]{7,64}$/i.test(sha) ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : undefined;
}
