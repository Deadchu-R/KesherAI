/**
 * Real Word files (.docx) in and out of KesherAI's documents (which are Markdown).
 *
 * Import reads the file with `mammoth` (Word to clean HTML: headings, lists, tables, links, bold, italic, pictures) and
 * turns that into Markdown; the pictures are kept as assets. Export writes a real .docx with the `docx` library:
 * headings, nested lists, tables, links, pictures and character marks, and every paragraph made of Hebrew or Arabic
 * letters is a right-to-left one (`w:bidi`, `w:rtl`). Markdown cannot carry the direction, so it is found again from the
 * letters on every export; a second import therefore gives the same Markdown (the round trip the tests check).
 * Both libraries are loaded with a dynamic `import()`: they cost nothing until a Word file is used.
 */
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { resolveInWorkspace } from "@kesher/agent";
import { replaceFile } from "./replace-file.js";

/** The biggest Word file brought in. */
export const MAX_DOCX_BYTES = 30 * 1024 * 1024;
/** MIME type of a .docx. */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const httpError = (code: number, msg: string) => Object.assign(new Error(msg), { statusCode: code });

/**
 * A path the model or a route gave, checked: it must be an absolute .docx path inside one of the allowed folders (no
 * `..`, no link leading out).
 *
 * @param path - The path.
 * @param roots - The allowed folders.
 * @returns The absolute path.
 * @throws With status 400 (not a .docx path) or 403 (outside the allowed folders).
 */
export async function guardDocxPath(path: string, roots: readonly string[]): Promise<string> {
  if (!path || path.includes("\0") || !isAbsolute(path) || extname(path).toLowerCase() !== ".docx") throw httpError(400, "Give the full path of a .docx file.");
  for (const root of roots) {
    try {
      return await resolveInWorkspace(root, path);
    } catch {
      // Not inside this folder (or it does not exist): try the next.
    }
  }
  throw httpError(403, "This file is not in a folder KesherAI may use (Documents, Desktop, Downloads...).");
}

/** Saves a picture and gives the address the document will use for it. */
export type SaveImage = (data: Uint8Array, mimeType: string) => Promise<string>;
/** Loads a picture of a document by its address (an asset link or a data: address); undefined when it is not there. */
export type LoadImage = (src: string) => Promise<{ data: Uint8Array; mimeType: string } | undefined>;

// ---------------------------------------------------------------- Word to Markdown

interface Node {
  tag: string;
  attrs: Record<string, string>;
  kids: Array<Node | string>;
}

const VOID = new Set(["br", "img", "hr"]);

/** Parses the HTML mammoth writes (clean, well-formed) into a small tree. */
function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, kids: [] };
  const stack: Node[] = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      top.kids.push(unescapeHtml(m[5]));
    } else if (m[1]) {
      const at = stack.map((n) => n.tag).lastIndexOf(m[2]!.toLowerCase());
      if (at > 0) stack.length = at;
    } else {
      const node: Node = { tag: m[2]!.toLowerCase(), attrs: {}, kids: [] };
      for (const a of (m[3] ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.attrs[a[1]!.toLowerCase()] = unescapeHtml(a[2] ?? "");
      top.kids.push(node);
      if (!VOID.has(node.tag) && !m[4]) stack.push(node);
    }
  }
  return root;
}

function unescapeHtml(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "nbsp") return " ";
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  });
}

/** Text that is safe inside Markdown inline text (the marks a Word paragraph could contain by accident). */
function escMd(s: string): string {
  return s.replace(/([\\`*_[\]])/g, "\\$1").replace(/^(#{1,6}\s|>\s?|[-+]\s|\d+[.)]\s)/, "\\$1");
}

/** One inline run of text and marks as Markdown. */
function inlineMd(kids: Array<Node | string>): string {
  let out = "";
  for (const k of kids) {
    if (typeof k === "string") {
      out += escMd(k);
      continue;
    }
    const inner = () => inlineMd(k.kids);
    // A mark wraps the text without its edge spaces (`** a **` is not bold in Markdown).
    const wrap = (mark: string) => {
      const t = inner();
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
      return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : t;
    };
    if (k.tag === "strong" || k.tag === "b") out += wrap("**");
    else if (k.tag === "em" || k.tag === "i") out += wrap("*");
    else if (k.tag === "s" || k.tag === "del" || k.tag === "strike") out += wrap("~~");
    else if (k.tag === "br") out += "  \n";
    else if (k.tag === "a") {
      const text = inner();
      const href = k.attrs.href ?? "";
      out += href && !href.startsWith("#") && text.trim() ? `[${text}](${href.replace(/\)/g, "%29").replace(/\s/g, "%20")})` : text;
    } else if (k.tag === "img") out += `![${escMd(k.attrs.alt ?? "")}](${k.attrs.src ?? ""})`;
    else out += inner();
  }
  return out;
}

const plain = (n: Node): string => n.kids.map((k) => (typeof k === "string" ? k : plain(k))).join("");

/** A list (nested lists indent two spaces per level) as Markdown lines. */
function listMd(list: Node, depth: number, out: string[]): void {
  let n = 0;
  for (const li of list.kids) {
    if (typeof li === "string" || li.tag !== "li") continue;
    const text: Array<Node | string> = li.kids.filter((k) => typeof k === "string" || (k.tag !== "ul" && k.tag !== "ol"));
    n++;
    const bullet = list.tag === "ol" ? `${n}.` : "-";
    out.push(`${"  ".repeat(depth)}${bullet} ${inlineMd(flattenPara(text)).trim()}`);
    for (const sub of li.kids) if (typeof sub !== "string" && (sub.tag === "ul" || sub.tag === "ol")) listMd(sub, depth + 1, out);
  }
}

/** A paragraph inside a list item or a cell is just its content. */
function flattenPara(kids: Array<Node | string>): Array<Node | string> {
  return kids.flatMap((k) => (typeof k !== "string" && k.tag === "p" ? [...flattenPara(k.kids), " "] : [k]));
}

/** A table as a Markdown pipe table (its first row is the header). */
function tableMd(table: Node): string {
  const rows: string[][] = [];
  const walk = (n: Node) => {
    for (const k of n.kids) {
      if (typeof k === "string") continue;
      if (k.tag === "tr") rows.push(k.kids.filter((c): c is Node => typeof c !== "string" && (c.tag === "td" || c.tag === "th")).map((c) => inlineMd(flattenPara(c.kids)).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()));
      else walk(k);
    }
  };
  walk(table);
  // The header row is shown bold by the Word file (and by our export), so its own bold is not kept as text.
  rows[0] = rows[0]?.map((c) => c.replace(/^\*\*([\s\S]*)\*\*$/, "$1")) ?? [];
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (!cols) return "";
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]!), line(Array(cols).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/** The blocks of a node's children as Markdown. */
function blocksMd(kids: Array<Node | string>): string[] {
  const out: string[] = [];
  let loose: Array<Node | string> = [];
  const flush = () => {
    const t = inlineMd(loose).trim();
    if (t) out.push(t);
    loose = [];
  };
  for (const k of kids) {
    if (typeof k === "string" || !/^(p|h[1-6]|ul|ol|table|blockquote|pre|hr|div)$/.test(k.tag)) {
      loose.push(k);
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(k.tag)) {
      const t = inlineMd(k.kids).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
      if (t) out.push(`${"#".repeat(Number(k.tag[1]))} ${t}`);
    } else if (k.tag === "p") {
      const t = inlineMd(k.kids).trim();
      if (t) out.push(t);
    } else if (k.tag === "ul" || k.tag === "ol") {
      const lines: string[] = [];
      listMd(k, 0, lines);
      if (lines.length) out.push(lines.join("\n"));
    } else if (k.tag === "table") {
      const t = tableMd(k);
      if (t) out.push(t);
    } else if (k.tag === "blockquote") out.push(blocksMd(k.kids).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n"));
    else if (k.tag === "pre") out.push("```\n" + plain(k).replace(/\n+$/, "") + "\n```");
    else if (k.tag === "hr") out.push("---");
    else out.push(...blocksMd(k.kids));
  }
  flush();
  return out;
}

/**
   * A Word file as Markdown, with warnings about potential lossy conversion.
   *
   * @param data - The .docx bytes.
   * @param saveImage - Keeps a picture and says the address to use in the Markdown.
   * @returns The Markdown and an array of warning messages from mammoth.
   * @throws With status 400 when the bytes are not a Word file.
   */
  export async function docxToMarkdown(data: Uint8Array, saveImage: SaveImage): Promise<{ markdown: string; warnings: string[] }> {
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) throw httpError(400, "This is not a Word (.docx) file.");
    if (data.length > MAX_DOCX_BYTES) throw httpError(400, "The file is larger than 30 MB.");
    const mammoth = await import("mammoth");
    let html: string;
    let messages: Array<{ type: string; message: string }>;
    try {
      const result = await mammoth.convertToHtml(
        { buffer: Buffer.from(data) },
        { convertImage: mammoth.images.imgElement(async (img) => ({ src: await saveImage(new Uint8Array(await img.readAsBuffer()), img.contentType) })) },
      );
      html = result.value;
      messages = result.messages ?? [];
    } catch {
      throw httpError(400, "This Word file could not be read.");
    }
    const markdown = blocksMd(parseHtml(html).kids).join("\n\n");
    const warnings = messages.filter((m) => m.type === "warning").map((m) => m.message);
    return { markdown, warnings };
  }

// ---------------------------------------------------------------- Markdown to Word

const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LETTER = /\p{L}/u;

/**
 * Whether a text is right to left: most of its letters are Hebrew or Arabic.
 *
 * @param text - A paragraph's text.
 */
export function isRtlText(text: string): boolean {
  let rtl = 0;
  let all = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    all++;
    if (RTL_LETTER.test(ch)) rtl++;
  }
  return all > 0 && rtl * 2 > all;
}

/** Width and height of a PNG, JPEG or GIF (from its header), or undefined. */
export function imageInfo(d: Uint8Array): { type: "png" | "jpg" | "gif"; width: number; height: number } | undefined {
  if (d.length > 24 && d[0] === 0x89 && d[1] === 0x50) {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { type: "png", width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (d.length > 10 && d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) return { type: "gif", width: d[6]! | (d[7]! << 8), height: d[8]! | (d[9]! << 8) };
  if (d.length > 4 && d[0] === 0xff && d[1] === 0xd8) {
    for (let i = 2; i + 9 < d.length; ) {
      if (d[i] !== 0xff) return undefined;
      const m = d[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "jpg", height: (d[i + 5]! << 8) | d[i + 6]!, width: (d[i + 7]! << 8) | d[i + 8]! };
      i += 2 + ((d[i + 2]! << 8) | d[i + 3]!);
    }
  }
  return undefined;
}

type Docx = typeof import("docx");
type Inline = import("docx").ParagraphChild;

interface Marks {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

/** Builds the inline children of a paragraph from Markdown text. */
async function inlineDocx(D: Docx, text: string, rtl: boolean, load: LoadImage, marks: Marks = {}): Promise<Inline[]> {
  const out: Inline[] = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|`([^`]+)`|(?<![*\w\\])\*([^*\s](?:[^*]*[^*\s])?)\*|~~(.+?)~~|\\([\\`*_[\]#>+.\-)(!~|])/g;
  /** The text as Word runs: a line break inside it ("\n", from "  \n" in Markdown) is a break before the next run. */
  const run = (t: string, m: Marks) =>
    t.split("\n").map(
      (part, i) =>
        new D.TextRun({
          text: part,
          ...(i ? { break: 1 } : {}),
          ...(m.bold ? { bold: true } : {}),
          ...(m.italics ? { italics: true } : {}),
          ...(m.strike ? { strike: true } : {}),
          ...(m.code ? { font: "Consolas" } : {}),
          ...(m.link ? { color: "0563C1", underline: {} } : {}),
          ...(rtl ? { rightToLeft: true, ...(m.bold ? { boldComplexScript: true } : {}), ...(m.italics ? { italicsComplexScript: true } : {}) } : {}),
        }),
    );
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push(...run(text.slice(at, m.index), marks));
    at = m.index + m[0].length;
    if (m[2] !== undefined) {
      const img = await load(m[2]);
      const info = img && imageInfo(img.data);
      if (img && info) {
        const k = Math.min(1, 560 / Math.max(1, info.width));
        out.push(new D.ImageRun({ type: info.type, data: img.data, transformation: { width: Math.max(1, Math.round(info.width * k)), height: Math.max(1, Math.round(info.height * k)) }, altText: { name: m[1] || "image", description: m[1] || "image", title: m[1] || "image" } }));
      } else out.push(...run(m[1] ? `[${m[1]}]` : "[image]", marks));
    } else if (m[4] !== undefined) {
      const kids = (await inlineDocx(D, m[3]!, rtl, load, { ...marks, link: true })) as import("docx").ParagraphChild[];
      out.push(...(/^(https?:|mailto:)/i.test(m[4]) ? [new D.ExternalHyperlink({ link: m[4], children: kids as never })] : run(m[3]!, marks)));
    } else if (m[5] !== undefined) out.push(...(await inlineDocx(D, m[5], rtl, load, { ...marks, bold: true, italics: true })));
    else if (m[6] !== undefined) out.push(...(await inlineDocx(D, m[6], rtl, load, { ...marks, bold: true })));
    else if (m[7] !== undefined) out.push(...run(m[7], { ...marks, code: true }));
    else if (m[8] !== undefined) out.push(...(await inlineDocx(D, m[8], rtl, load, { ...marks, italics: true })));
    else if (m[9] !== undefined) out.push(...(await inlineDocx(D, m[9], rtl, load, { ...marks, strike: true })));
    else if (m[10] !== undefined) out.push(...run(m[10], marks));
  }
  if (at < text.length) out.push(...run(text.slice(at), marks));
  return out;
}

const plainText = (md: string): string => md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`~\\]/g, "");

/**
 * Markdown as the bytes of a real Word file.
 *
 * @param title - The document's title (kept in the file's properties, not as a first line, so a second import is the same text).
 * @param md - The Markdown.
 * @param load - Reads the pictures the Markdown points to.
 * @returns The .docx bytes.
 */
export async function markdownToDocx(title: string, md: string, load: LoadImage): Promise<Uint8Array> {
  const D = await import("docx");
  const body: Array<import("docx").Paragraph | import("docx").Table> = [];
  const lines = md.replace(/\r/g, "").split("\n");
  const HEADINGS = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];
  const para = async (text: string, o: { heading?: number; bullet?: number; ordered?: number; quote?: boolean; code?: boolean; rtl?: boolean } = {}) => {
    const rtl = o.rtl || isRtlText(plainText(text));
    const children = o.code ? [new D.TextRun({ text, font: "Consolas", ...(rtl ? { rightToLeft: true } : {}) })] : await inlineDocx(D, text, rtl, load);
    return new D.Paragraph({
      children,
      ...(o.heading ? { heading: HEADINGS[o.heading - 1]! } : {}),
      ...(o.bullet !== undefined ? { bullet: { level: Math.min(8, o.bullet) } } : {}),
      ...(o.ordered !== undefined ? { numbering: { reference: "kesher-ordered", level: Math.min(8, o.ordered) } } : {}),
      ...(o.quote ? { indent: { left: 567 }, border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: "AAAAAA", space: 8 } } } : {}),
      ...(rtl ? { bidirectional: true } : {}),
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      for (const c of code.length ? code : [""]) body.push(await para(c, { code: true }));
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) body.push(await para(m[2]!.trim(), { heading: m[1]!.length }));
    else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
      const rows = [cells(line)];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      i--;
      const cols = Math.max(...rows.map((r) => r.length));
      const rtlTable = isRtlText(plainText(rows.flat().join(" ")));
      const trs = await Promise.all(
        rows.map(
          async (r, ri) =>
            new D.TableRow({ tableHeader: ri === 0, children: await Promise.all(Array.from({ length: cols }, async (_, c) => new D.TableCell({ width: { size: Math.floor(100 / cols), type: D.WidthType.PERCENTAGE }, children: [await para(ri === 0 && r[c] ? `**${r[c]}**` : (r[c] ?? ""), rtlTable ? { rtl: true } : {})] }))) }),
        ),
      );
      body.push(new D.Table({ rows: trs, width: { size: 100, type: D.WidthType.PERCENTAGE }, ...(rtlTable ? { visuallyRightToLeft: true } : {}) }));
      body.push(new D.Paragraph({}));
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const level = Math.floor(m[1]!.replace(/\t/g, "  ").length / 2);
      body.push(await para(m[3]!, /\d/.test(m[2]!) ? { ordered: level } : { bullet: level }));
    } else if ((m = /^>\s?(.*)$/.exec(line))) body.push(await para(m[1]!, { quote: true }));
    else if (/^\s*([-*_])\1\1+\s*$/.test(line)) body.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } } }));
    else {
      // A paragraph: its lines up to a blank line or the next block, joined by spaces.
      // A line that ends with two spaces (or a backslash) is a hard line break.
      let text = line.trim();
      while (i + 1 < lines.length && lines[i + 1]!.trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*\|)/.test(lines[i + 1]!)) {
        text += `${/( {2,}|\\)$/.test(lines[i]!) ? "\n" : " "}${lines[++i]!.trim()}`;
      }
      body.push(await para(text));
    }
  }
  if (!body.length) body.push(new D.Paragraph({}));
  const doc = new D.Document({
    title: title.slice(0, 160),
    creator: "KesherAI",
    numbering: {
      config: [
        {
          reference: "kesher-ordered",
          levels: Array.from({ length: 9 }, (_, level) => ({ level, format: D.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })),
        },
      ],
    },
    sections: [{ children: body }],
  });
  return new Uint8Array(await D.Packer.toBuffer(doc));
}

// ---------------------------------------------------------------- files

/** An image's data: address as bytes, or undefined. */
export function dataUrlImage(src: string): { data: Uint8Array; mimeType: string } | undefined {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(src);
  return m ? { data: new Uint8Array(Buffer.from(m[2]!, "base64")), mimeType: m[1]! } : undefined;
}

/**
 * Reads a .docx from an allowed folder.
 *
 * @param path - Its full path.
 * @param roots - The allowed folders.
 * @returns The path (checked), the bytes and the title (the file name).
 */
export async function readDocxFile(path: string, roots: readonly string[]): Promise<{ path: string; data: Uint8Array; title: string }> {
  const abs = await guardDocxPath(path, roots);
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile()) throw httpError(404, "No such file.");
  if (st.size > MAX_DOCX_BYTES) throw httpError(400, "The file is larger than 30 MB.");
  return { path: abs, data: new Uint8Array(await readFile(abs)), title: basename(abs, extname(abs)).slice(0, 160) || "Document" };
}

/**
 * Writes a Word file over the original: the first time, the old file is kept beside it as `<name>.docx.bak` (one
 * copy, never overwritten again), and the new one is written whole before it takes the old one's place.
 *
 * @param path - The .docx path (checked against the allowed folders).
 * @param roots - The allowed folders.
 * @param data - The new bytes.
 * @returns The path and whether a .bak was made now.
 */
export async function writeDocxFile(path: string, roots: readonly string[], data: Uint8Array): Promise<{ path: string; bak: boolean }> {
  const abs = await guardDocxPath(path, roots);
  let bak = false;
  const exists = await stat(abs).then((s) => s.isFile(), () => false);
  if (exists) {
    const has = await stat(`${abs}.bak`).then(() => true, () => false);
    if (!has) {
      await copyFile(abs, `${abs}.bak`);
      bak = true;
    }
  }
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await replaceFile(tmp, abs);
  return { path: abs, bak };
}
