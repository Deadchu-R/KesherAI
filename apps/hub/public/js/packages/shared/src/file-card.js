/**
 * The model of a file card: what `send_file` posts into a chat (like Claude's SendUserFile). Pure and shared: the
 * agent's tool uses it to describe the file, the interface to choose the icon and the preview, the tests to pin both.
 */
/** At most this many cards in one turn (the tool refuses the rest). */
export const MAX_FILE_CARDS_PER_TURN = 20;
/** A file over this size gets a card without a preview. */
export const FILE_CARD_PREVIEW_LIMIT = 200 * 1024 ** 2;
/** The lines of a text or code preview. */
export const FILE_CARD_PREVIEW_LINES = 40;
const BY_EXT = {
    png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image", svg: "image",
    pdf: "pdf", md: "markdown", markdown: "markdown", html: "html", htm: "html",
    txt: "text", log: "text", json: "code", yaml: "code", yml: "code", toml: "code", xml: "code", ini: "code", css: "code",
    js: "code", mjs: "code", ts: "code", tsx: "code", jsx: "code", py: "code", cs: "code", cpp: "code", h: "code", hpp: "code", c: "code",
    java: "code", kt: "code", go: "code", rs: "code", rb: "code", php: "code", sh: "code", bat: "code", ps1: "code", sql: "code", lua: "code", gd: "code", usf: "code",
    csv: "table", tsv: "table", xlsx: "table",
    zip: "archive", "7z": "archive", rar: "archive", tar: "archive", gz: "archive", tgz: "archive",
    mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", flac: "audio", opus: "audio", aac: "audio",
    mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video",
    glb: "model", gltf: "model",
    docx: "document", pptx: "document", odt: "document", odp: "document", epub: "document",
};
/**
 * What a file is, from its name.
 *
 * @param name - The file's name or path.
 * @returns Its kind (`other` for an unknown extension).
 */
export function fileCardKind(name) {
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
    return (ext && BY_EXT[ext]) || "other";
}
/** The icon of each kind. */
const ICONS = { image: "🖼", pdf: "📕", markdown: "📝", html: "🌐", code: "💻", text: "📄", table: "📊", archive: "🗜", audio: "🎵", video: "🎬", model: "🧊", document: "📃", other: "📎" };
/**
 * The icon of a file kind.
 *
 * @param kind - The file's kind.
 * @returns One emoji.
 */
export function fileCardIcon(kind) {
    return ICONS[kind];
}
/**
 * What a card shows for a file: nothing for `attach` and for a file over 200 MB or an empty one, otherwise the
 * preview that fits its kind (a picture, a PDF's first page, a rendered Markdown or a sandboxed page, the first
 * lines of text and code, a table, a player; archives and the rest have none).
 *
 * @param kind - The file's kind.
 * @param size - Its size in bytes.
 * @param display - `render` or `attach`.
 * @returns The preview to draw.
 */
export function fileCardPreview(kind, size, display) {
    if (display === "attach" || size <= 0 || size > FILE_CARD_PREVIEW_LIMIT)
        return "none";
    switch (kind) {
        case "image": return "image";
        case "pdf": return "pdf-page";
        case "markdown": return "markdown";
        case "html": return "html";
        case "code":
        case "text": return "lines";
        case "table": return "table";
        case "audio":
        case "video": return "player";
        default: return "none";
    }
}
/**
 * A size for a card ("1.4 MB").
 *
 * @param bytes - The size.
 * @returns The size with a unit.
 */
export function fileCardSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 ** 2)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3)
        return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
/**
 * The first lines of a text for a card's preview, with how many were left out.
 *
 * @param text - The file's text.
 * @param max - The lines to keep (default 40).
 * @returns The kept text and the number of lines left out.
 */
export function firstLines(text, max = FILE_CARD_PREVIEW_LINES) {
    const lines = text.split(/\r?\n/);
    return { text: lines.slice(0, max).join("\n"), more: Math.max(0, lines.length - max) };
}
/**
 * The first page of the text the preview route gives for a PDF (pages are marked "— 1 —", "— 2 —").
 *
 * @param text - The PDF's text with page markers.
 * @returns The first page's text without its marker.
 */
export function firstPdfPage(text) {
    const cut = text.search(/\n\n— 2 —\n/);
    return (cut < 0 ? text : text.slice(0, cut)).replace(/^— 1 —\n/, "");
}
