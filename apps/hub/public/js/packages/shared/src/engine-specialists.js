/**
 * Engine specialists (WORK_LIST "Specialised engine agents: materials, Niagara and VFX, level design";
 * docs/RESEARCH_LOG.md, "Specialised engine agents"): three sub-agent roles the lead chat can hand game-engine work
 * to, and that the user can pick in "who does it". Each has its own instructions and a curated set of engine tools
 * (packages/core/src/engine-specialists.ts); every change it makes in the engine waits for the user's approval on a
 * card that names it (with the scene diff), and files it writes go into the chat's checkpoint.
 *
 * This file holds what every client needs (the PC app, the phone, the hub page): the ids, names, icons and the
 * output checklist each role reports against, and the parser for that checklist. Pure.
 */
/** The specialist roles, in the order they are shown. */
export const SPECIALIST_IDS = ["materials", "vfx", "level"];
/** The three roles. */
export const SPECIALISTS = {
    materials: {
        id: "materials",
        icon: "🎨",
        he: "חומרים",
        en: "Materials",
        noteHe: "PBR, טקסטורות, החלה על הבחירה",
        noteEn: "PBR, textures, apply to selection",
        checklist: [
            { key: "textures", he: "מפות הטקסטורה נוצרו או נמצאו", en: "Texture maps made or found" },
            { key: "import", he: "הגדרות ייבוא נכונות (Normal, sRGB, דחיסה)", en: "Import settings right (normal, sRGB, compression)" },
            { key: "material", he: "חומר או מופע חומר נוצר", en: "Material or instance made" },
            { key: "applied", he: "הוחל על האובייקטים שנבחרו", en: "Applied to the chosen objects" },
            { key: "checked", he: "נבדק בתמונה מהמנוע", en: "Checked in a picture from the engine" },
        ],
    },
    vfx: {
        id: "vfx",
        icon: "✨",
        he: "אפקטים",
        en: "VFX",
        noteHe: "חלקיקים ו-Niagara מתיאור",
        noteEn: "Particles and Niagara from words",
        checklist: [
            { key: "spec", he: "מפרט האפקט נכתב (קצב, משך, צבע, גודל)", en: "Effect spec written (rate, lifetime, color, size)" },
            { key: "created", he: "האפקט נוצר במנוע, או נכנס לתור", en: "Effect made in the engine, or queued" },
            { key: "placed", he: "מוקם בסצנה או צורף לאובייקט", en: "Placed in the scene or attached" },
            { key: "tuned", he: "כוונן אחרי צפייה", en: "Tuned after a look" },
            { key: "budget", he: "בתוך תקציב החלקיקים לטלפון", en: "Within the phone particle budget" },
        ],
    },
    level: {
        id: "level",
        icon: "🧱",
        he: "עיצוב שלבים",
        en: "Level design",
        noteHe: "בלוק-אאוט, תאורה, NavMesh",
        noteEn: "Block-out, lighting, navmesh",
        checklist: [
            { key: "layout", he: "תוכנית על רשת (חדרים, מעברים, גבהים)", en: "Grid layout planned (rooms, paths, heights)" },
            { key: "blockout", he: "צורות או פריפאבים הוצבו", en: "Shapes or prefabs placed" },
            { key: "lighting", he: "מעבר תאורה", en: "Lighting pass" },
            { key: "navmesh", he: "NavMesh נבנה או הוגדר", en: "Navmesh built or set up" },
            { key: "checkpoint", he: "נקודת שחזור ותמונה לבדיקה", en: "Checkpoint and a picture to check" },
        ],
    },
};
/**
 * Whether a value is a specialist id.
 *
 * @param x - Untrusted input.
 * @returns True for "materials", "vfx" or "level".
 */
export function isSpecialist(x) {
    return typeof x === "string" && SPECIALIST_IDS.includes(x);
}
/**
 * The checklist at the end of a specialist's report: lines like `- [x] material: M_Brick made` or `- [ ] navmesh: no
 * AI Navigation package`. Lines for keys the role does not have are left out; a key that is missing counts as not
 * done, so the card never shows more than the report says.
 *
 * @param id - The role.
 * @param report - The specialist's final report.
 * @returns One mark per checklist line of the role, in its order.
 */
export function parseChecklist(id, report) {
    const found = new Map();
    for (const m of report.matchAll(/^\s*[-*]\s*\[([ xX✓-])\]\s*([a-z]+)\s*[:：-]?\s*(.*)$/gm)) {
        const key = m[2].toLowerCase();
        if (!found.has(key))
            found.set(key, { key, done: /[xX✓]/.test(m[1]), ...(m[3].trim() ? { note: m[3].trim().slice(0, 140) } : {}) });
    }
    return SPECIALISTS[id].checklist.map((c) => found.get(c.key) ?? { key: c.key, done: false });
}
/**
 * The checklist block a specialist's instructions ask for (English, the model's language for tools).
 *
 * @param id - The role.
 * @returns Lines like `- [ ] material: Material or instance made`.
 */
export function checklistTemplate(id) {
    return SPECIALISTS[id].checklist.map((c) => `- [ ] ${c.key}: ${c.en}`).join("\n");
}
