/**
 * Reads an export file (a zip, a JSON file or Google's HTML) in a stream, so a export of several GB is never held
 * in memory whole: JSON lists are cut into their elements as the bytes come ({@link JsonItemSplitter}) and a zip is
 * unpacked entry by entry (fflate's streaming `Unzip`). Each element goes to an {@link ExportReader} on its own.
 *
 * Nothing here talks to the network: the file stays on this computer.
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Unzip, UnzipInflate } from "fflate";
import { geminiHtmlToActivity, type ExportReader } from "./chat-import.js";

/** The biggest single element of a JSON list (one chat) read; a bigger one is skipped as broken. */
const MAX_ITEM_CHARS = 256 * 1024 * 1024;
/** The biggest HTML file read (Google's MyActivity.html is read whole: its cards are not JSON). */
const MAX_HTML_BYTES = 300 * 1024 * 1024;

/**
 * Cuts a JSON text that comes in pieces into the elements of its top-level list (or its single top-level object),
 * and parses each one on its own. Strings and escapes are followed, so a `{` inside a message does not count.
 */
export class JsonItemSplitter {
  private mode: "array" | "object" | "done" | "bad" | undefined;
  private depth = 0;
  private inStr = false;
  private esc = false;
  private collecting = false;
  private parts: string[] = [];
  private size = 0;
  /** Elements that could not be parsed (a cut-off file, or one too big). */
  broken = 0;

  /** @param onItem - Called with each parsed element. */
  constructor(private readonly onItem: (item: unknown) => void) {}

  /** Whether the text did not start like JSON at all. */
  get notJson(): boolean {
    return this.mode === "bad";
  }

  /**
   * Reads the next piece of the text.
   *
   * @param s - The piece.
   */
  push(s: string): void {
    if (this.mode === "done" || this.mode === "bad") return;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (this.collecting) {
        if (this.inStr) {
          if (this.esc) this.esc = false;
          else if (c === 92) this.esc = true; // \
          else if (c === 34) this.inStr = false; // "
          continue;
        }
        if (c === 34) this.inStr = true;
        else if (c === 123 || c === 91) this.depth++; // { [
        else if (c === 125 || c === 93) { // } ]
          if (--this.depth === 0) {
            this.parts.push(s.slice(start, i + 1));
            this.emit();
            if (this.mode === "object") {
              this.mode = "done";
              return;
            }
          }
        }
        continue;
      }
      if (this.mode === undefined) {
        if (c === 0xfeff || c === 32 || c === 9 || c === 10 || c === 13) continue;
        if (c === 91) this.mode = "array";
        else if (c === 123) {
          this.mode = "object";
          this.begin(i);
          start = i;
        } else {
          this.mode = "bad";
          return;
        }
        continue;
      }
      // Between the list's elements.
      if (c === 93) {
        this.mode = "done";
        return;
      }
      if (c === 123 || c === 91) {
        this.begin(i);
        start = i;
      }
    }
    if (this.collecting) {
      const rest = s.slice(start);
      this.size += rest.length;
      if (this.size > MAX_ITEM_CHARS) {
        // One element bigger than any real chat: skipped, and the reading stops (the rest of it can't be trusted).
        this.broken++;
        this.parts = [];
        this.mode = "bad";
        return;
      }
      this.parts.push(rest);
    }
  }

  private begin(_i: number): void {
    this.collecting = true;
    this.depth = 1;
    this.inStr = false;
    this.esc = false;
    this.parts = [];
    this.size = 0;
  }

  private emit(): void {
    const text = this.parts.join("");
    this.parts = [];
    this.collecting = false;
    let item: unknown;
    try {
      item = JSON.parse(text);
    } catch {
      this.broken++;
      return;
    }
    this.onItem(item);
  }

  /** Ends the text: an element still open (a cut-off file) counts as broken. */
  end(): void {
    if (this.collecting) this.broken++;
    this.collecting = false;
    this.parts = [];
  }
}

/** The zip entries that hold chats, projects or Gemini activity (everything else is only listed). */
export function isChatEntry(name: string): boolean {
  const base = name.replace(/^.*\//, "");
  return (
    /^conversations(-\d+)?\.json$/i.test(base) ||
    /^projects\.json$/i.test(base) ||
    /\.conversation\.json$/i.test(base) ||
    /^chat-export.*\.json$/i.test(base) ||
    /(^|\/)[^/]*(gemini|bard)[^/]*\/[^/]+\.(json|html?)$/i.test(name)
  );
}

/** What reading a file found. */
export interface ScanResult {
  /** The file was a zip. */
  zip: boolean;
  /** Every entry of the zip that is not a chats file (pictures and files the chats may point to). */
  entries: string[];
  /** Elements that could not be read. */
  broken: number;
  /** The file was not JSON, HTML or a zip. */
  unknown: boolean;
}

/** Options for {@link scanImportFile}. */
export interface ScanOptions {
  /** Called after each piece of the file is read: chats read so far can be saved here (the reading waits). */
  afterChunk?: () => Promise<void>;
  /** For a zip entry that is not a chats file: a sink for its bytes, or undefined to skip it (not unpacked). */
  media?: (name: string) => ((data: Uint8Array, final: boolean) => void) | undefined;
  /** Read only the media (`media`), not the chats (the second pass of an import with pictures). */
  mediaOnly?: boolean;
}

/** Feeds text of one file to the reader: JSON in a stream, HTML whole (Gemini's My Activity). */
function textSink(reader: ExportReader, fileName: string, onBroken: (n: number) => void): { push: (s: string) => void; end: () => void; notJson: () => boolean } {
  let html: string[] | undefined;
  let htmlSize = 0;
  let decided = false;
  const json = new JsonItemSplitter((item) => {
    if (Array.isArray(item)) for (const x of item) reader.item(x, fileName);
    else reader.item(item, fileName);
  });
  return {
    push: (s) => {
      if (!decided) {
        const t = s.replace(/^\uFEFF/, "").trimStart();
        if (!t) return;
        decided = true;
        if (t.startsWith("<")) html = [];
      }
      if (html) {
        htmlSize += s.length;
        if (htmlSize <= MAX_HTML_BYTES) html.push(s);
      } else json.push(s);
    },
    end: () => {
      if (html) {
        for (const a of geminiHtmlToActivity(html.join(""))) reader.item(a, fileName);
        html = undefined;
      } else {
        json.end();
        onBroken(json.broken);
      }
    },
    notJson: () => !html && json.notJson,
  };
}

/**
 * Reads an export file in a stream into `reader` (then calls `reader.end()`).
 *
 * @param path - The file on this computer (a zip, a JSON file or an HTML file).
 * @param reader - Gets each element.
 * @param opts - What to do between pieces, and which other zip entries to unpack.
 * @returns What was found.
 */
export async function scanImportFile(path: string, reader: ExportReader, opts: ScanOptions = {}): Promise<ScanResult> {
  const head = Buffer.alloc(4);
  const fh = await open(path, "r");
  try {
    await fh.read(head, 0, 4, 0);
  } finally {
    await fh.close();
  }
  const result: ScanResult = { zip: head.readUInt32LE(0) === 0x04034b50, entries: [], broken: 0, unknown: false };
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  if (!result.zip) {
    const decoder = new TextDecoder();
    const sink = textSink(reader, path, (n) => (result.broken += n));
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (!opts.mediaOnly) sink.push(decoder.decode(chunk, { stream: true }));
      if (sink.notJson()) break;
      await opts.afterChunk?.();
    }
    if (opts.mediaOnly) {
      stream.destroy();
      return result;
    }
    sink.push(decoder.decode());
    result.unknown = sink.notJson();
    sink.end();
    reader.end();
    await opts.afterChunk?.();
    return result;
  }
  let failure: Error | undefined;
  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/")) return;
    if (isChatEntry(file.name)) {
      if (opts.mediaOnly) return;
      const decoder = new TextDecoder();
      const sink = textSink(reader, file.name, (n) => (result.broken += n));
      file.ondata = (err, data, final) => {
        if (err) return void (failure ??= err);
        sink.push(decoder.decode(data, { stream: !final }));
        if (final) sink.end();
      };
      file.start();
      return;
    }
    result.entries.push(file.name);
    const media = opts.media?.(file.name);
    if (!media) return;
    file.ondata = (err, data, final) => {
      if (err) return void (failure ??= err);
      media(data, final);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    unzip.push(chunk);
    if (failure) break;
    await opts.afterChunk?.();
  }
  if (!failure) unzip.push(new Uint8Array(0), true);
  stream.destroy();
  if (failure) throw new Error(`The zip could not be read: ${failure.message}`);
  if (!opts.mediaOnly) reader.end();
  await opts.afterChunk?.();
  return result;
}
