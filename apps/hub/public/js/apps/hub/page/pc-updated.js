/**
 * "The PC was updated": a one-time card on the hub page (dashboard and phone) when a paired PC reports a newer
 * KesherAI version than this browser last saw. The hub page cannot read release notes (its content policy only
 * allows the hub itself), so the card names the version and says where "What's new" is. Pure functions here; the
 * page stores `seen` in localStorage under `kh-pc-seen` and draws the card.
 */
/** The numeric parts of a version, for comparing. */
const nums = (v) => v.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
/**
 * Whether version `a` is newer than `b`.
 *
 * @param a - e.g. `0.6.440`.
 * @param b - e.g. `0.6.439`.
 */
export function newerVersion(a, b) {
    const pa = nums(a);
    const pb = nums(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++)
        if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) > (pb[i] ?? 0);
    return false;
}
/**
 * Compares the PCs' versions with what this browser saw.
 *
 * @param pcs - The paired devices (only `kind: "pc"` with a version count).
 * @param seen - What this browser saw before.
 * @returns The PCs that were updated (for the card), and the map to store: a PC seen for the first time is only
 *   remembered (nothing to compare with), an updated one stays at its old version until the card is dismissed.
 */
export function reviewPcs(pcs, seen) {
    const next = { ...seen };
    const updated = [];
    for (const d of pcs) {
        if (d.kind !== "pc" || !d.version)
            continue;
        const before = seen[d.id];
        if (!before)
            next[d.id] = d.version;
        else if (newerVersion(d.version, before))
            updated.push({ id: d.id, name: d.name, version: d.version, from: before });
    }
    return { updated, seen: next };
}
/**
 * Marks a PC's version as seen (the card was dismissed).
 *
 * @param seen - What is stored.
 * @param pc - The updated PC.
 */
export function dismissPc(seen, pc) {
    return { ...seen, [pc.id]: pc.version };
}
