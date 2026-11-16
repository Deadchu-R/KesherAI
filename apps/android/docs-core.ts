/**
 * Reading a lecture's file on the phone itself, with no computer: PowerPoint, Word, PDF and plain text. Bundled into
 * www/vendor/docs-core.js by scripts/vendor.mjs. Office files are zips of XML (unpacked with the browser's own
 * DecompressionStream, with the same limits as the computer's reader against "zip bombs"); PDFs use unpdf (pdf.js),
 * the same package the computer uses. Scanned PDFs and photos have no text: those still go to the computer.
 */

/** The most a file may unpack to, in total. */
const MAX_TOTAL = 64 * 1024 * 1024;
/** The most entries read. */
const MAX_ENTRIES = 4000;

interface Entry {
  method: number;
  size: number;
  packed: number;
  local: number;
}

/** Unpacks deflate data, stopping at `limit` bytes. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("too big");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The files inside a zip, read on demand.
 *
 * @param data - The zip's bytes.
 * @returns `names`, and `read(name)` as text (undefined when missing or too big).
 * @throws Error when it is not a zip.
 */
export function openZip(data: Uint8Array): { names: string[]; read(name: string): Promise<string | undefined> } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = Math.min(v.getUint16(eocd + 10, true), MAX_ENTRIES);
  let p = v.getUint32(eocd + 16, true);
  const entries = new Map<string, Entry>();
  const utf8 = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= data.length; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = v.getUint16(p + 28, true);
    const name = utf8.decode(data.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method: v.getUint16(p + 10, true), packed: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true), local: v.getUint32(p + 42, true) });
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  let used = 0;
  return {
    names: [...entries.keys()],
    async read(name) {
      const e = entries.get(name);
      if (!e || e.local + 30 > data.length || v.getUint32(e.local, true) !== 0x04034b50) return undefined;
      if (used + e.size > MAX_TOTAL) return undefined;
      const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
      const packed = data.subarray(start, start + e.packed);
      let out: Uint8Array;
      if (e.method === 0) out = packed;
      else if (e.method === 8) {
        try {
          // Never more than the entry says (nor the total left): a lying header stops here.
          out = await inflate(packed, Math.max(1, Math.min(e.size, MAX_TOTAL - used)));
        } catch {
          return undefined;
        }
      } else return undefined;
      used += out.length;
      return utf8.decode(out);
    },
  };
}

const unescape = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

/** The text of every `<x:t>` in each paragraph (`<x:p>`), one line per paragraph. */
function paragraphs(xml: string, ns: "a" | "w"): string {
  return [...xml.matchAll(new RegExp(`<${ns}:p[ >][\\s\\S]*?</${ns}:p>`, "g"))]
    .map((p) => [...p[0].matchAll(new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>`, "g"))].map((m) => unescape(m[1]!)).join(""))
    .filter((l) => l.trim())
    .join("\n");
}

/**
 * A lecture file's text, on the phone.
 *
 * @param data - The file's bytes.
 * @param name - Its name (the extension picks the reader).
 * @returns The text ("" when the file has none, like a scanned PDF), or undefined for a kind the phone cannot read.
 */
export async function phoneDocumentText(data: Uint8Array, name: string): Promise<string | undefined> {
  const ext = /\.[^.]+$/.exec(name.toLowerCase())?.[0] ?? "";
  if (ext === ".pptx") {
    const zip = openZip(data);
    const slides = zip.names
      .map((n) => ({ n, i: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1] ?? NaN) }))
      .filter((x) => Number.isFinite(x.i))
      .sort((a, b) => a.i - b.i);
    const out: string[] = [];
    for (const { n, i } of slides) {
      const t = paragraphs((await zip.read(n)) ?? "", "a");
      if (t) out.push(`Slide ${i}\n${t}`);
    }
    return out.join("\n\n");
  }
  if (ext === ".docx") return paragraphs((await openZip(data).read("word/document.xml")) ?? "", "w");
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // No eval of font code from the file (pdf.js 6 is past the 2024 font bug; this is a second lock).
    const pdf = await getDocumentProxy(new Uint8Array(data), { isEvalSupported: false });
    const { text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((p) => p.replace(/[ \t]+\n/g, "\n").trim()).filter(Boolean).join("\n\n");
  }
  if ([".txt", ".md", ".csv", ".srt", ".vtt"].includes(ext)) return new TextDecoder().decode(data);
  return undefined;
}
