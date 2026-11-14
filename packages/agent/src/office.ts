/**
 * Excel and PowerPoint files as text, for the model (and the chat's preview), with no extra package: an .xlsx or .pptx
 * is a zip of XML. A small zip reader on Node's zlib, with limits so a crafted file (a "zip bomb") cannot fill memory.
 */
import { inflateRawSync } from "node:zlib";

/** The most a file may unpack to, in total. */
const MAX_TOTAL = 64 * 1024 * 1024;
/** The most entries read. */
const MAX_ENTRIES = 4000;

/**
 * The files inside a zip, by name, read on demand.
 *
 * @param data - The zip's bytes.
 * @returns A reader: `names` and `read(name)` (undefined when missing or too big).
 * @throws Error when it is not a zip.
 */
export function openZip(data: Uint8Array): { names: string[]; read(name: string): Buffer | undefined } {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-directory record is in the last 64 KB (after an optional comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a valid Office file (no zip directory).");
  const count = Math.min(buf.readUInt16LE(eocd + 10), MAX_ENTRIES);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; size: number; packed: number; local: number }>();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.set(name, { method, size, packed, local });
    p += 46 + nameLen + extra + comment;
  }
  let used = 0;
  return {
    names: [...entries.keys()],
    read(name: string): Buffer | undefined {
      const e = entries.get(name);
      if (!e || e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) return undefined;
      if (used + e.size > MAX_TOTAL) return undefined;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const packed = buf.subarray(start, start + e.packed);
      let out: Buffer;
      if (e.method === 0) out = Buffer.from(packed);
      else if (e.method === 8) {
        try {
          // Never more than the entry says (nor the total left): a lying header stops here.
          out = inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(e.size, MAX_TOTAL - used)) });
        } catch {
          return undefined;
        }
      } else return undefined;
      used += out.length;
      return out;
    },
  };
}

const unescape = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

/** The text inside every `<tag>…</tag>` (any prefix), joined. */
const textsOf = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`, "g"))].map((m) => unescape(m[1]!));

/** A column's letters to its number (A → 0, AA → 26). */
const colOf = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** One sheet as rows of cell text. */
export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows left out (over the limit). */
  more: number;
}

/**
 * An Excel workbook's sheets as rows of text (shared strings, inline strings, numbers, booleans; formulas as their
 * last value).
 *
 * @param data - The .xlsx bytes.
 * @param maxRows - Rows per sheet at most.
 */
export function xlsxSheets(data: Uint8Array, maxRows = 500): Sheet[] {
  const zip = openZip(data);
  const shared = (() => {
    const xml = zip.read("xl/sharedStrings.xml")?.toString("utf8") ?? "";
    // Each <si> is one string, maybe in several runs (<r><t>…</t></r>).
    return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textsOf(m[1]!, "t").join(""));
  })();
  const book = zip.read("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.read("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1]!, m[2]!.replace(/^\/?(xl\/)?/, "xl/")]));
  const sheets: Sheet[] = [];
  for (const m of book.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)) {
    const xml = zip.read(target.get(m[2]!) ?? "")?.toString("utf8");
    if (xml === undefined) continue;
    const rows: string[][] = [];
    let more = 0;
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) {
        more++;
        continue;
      }
      const row: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const body = c[2] ?? "";
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const value =
          type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? textsOf(body, "t").join("") : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : unescape(v ?? "");
        const col = ref ? colOf(ref) : row.length;
        while (row.length < col) row.push("");
        row[col] = value;
      }
      rows.push(row);
    }
    sheets.push({ name: unescape(m[1]!), rows, more });
  }
  return sheets;
}

/**
 * A PowerPoint deck's slides as text, in order (each paragraph on its own line).
 *
 * @param data - The .pptx bytes.
 */
export function pptxSlides(data: Uint8Array): string[] {
  const zip = openZip(data);
  const slides = zip.names
    .map((n) => ({ n, i: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.i))
    .sort((a, b) => a.i - b.i);
  return slides.map(({ n }) => {
    const xml = zip.read(n)?.toString("utf8") ?? "";
    return [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => textsOf(p[1]!, "t").join(""))
      .filter((l) => l.trim())
      .join("\n");
  });
}

/**
 * A sheet as tab-separated lines (what the model reads).
 *
 * @param s - The sheet.
 */
export function sheetText(s: Sheet): string {
  const lines = s.rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, " ")).join("\t").replace(/\t+$/, ""));
  return `Sheet "${s.name}"\n${lines.join("\n")}${s.more ? `\n… ${s.more} more rows` : ""}`;
}
