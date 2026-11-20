import { open, stat } from "node:fs/promises";
import { CLOUD_ONLY_MESSAGE, isCloudReadError, looksCloudOnly } from "./cloud-only.js";

/**
 * Unreal package header reader (RESEARCH_LOG "Gap list: engine work without the engine open", 2026-11-20, step 7):
 * what a .uasset or .umap holds, read from its header with no engine: the package summary (file and engine
 * versions, flags), the name map, the import and export tables (class, object name, outer), the asset registry tags,
 * whether it has thumbnails, and the packages it uses (hard: imported; soft: soft references).
 *
 * Read only and bounded: only the header is read (its size is in the summary), never the export data, so a
 * multi-GB level costs a few KB to a few MB. Corrupt or unknown input gives `ok: false` or a list of `problems`;
 * nothing here throws to its caller and every loop is bounded by a count cap and by the bytes it has.
 *
 * Layouts follow FPackageFileSummary / FObjectImport / FObjectExport for UE4.0 to UE5.x. Cooked packages saved
 * without versions ("unversioned") are read by trying the known file versions and keeping the first that makes
 * sense (names resolve, offsets in range). A package saved by an engine newer than this reader knows (a newer legacy
 * format or file version) is read with the newest known layout and carries a soft warning instead of failing.
 */

/** The tag every package starts with. */
const PACKAGE_TAG = 0x9e2a83c1;
/** The same tag byte-swapped (a package saved on a big-endian platform: not read here). */
const PACKAGE_TAG_SWAPPED = 0xc1832a9e;
/** Package flags. */
const PKG_CONTAINS_MAP = 0x20000;
const PKG_UNVERSIONED = 0x2000;
const PKG_FILTER_EDITOR_ONLY = 0x80000000;

/** UE4 file versions where the layout changes (EUnrealEngineObjectUE4Version). */
const UE4 = { WORLD_LEVEL_INFO: 224, CHUNKID_ARRAY: 326, ENGINE_VERSION_OBJECT: 336, LOAD_FOR_EDITOR_GAME: 365, SOFT_PACKAGE_REFS: 384, SERIALIZE_TEXT: 459, COMPATIBLE_ENGINE_VERSION: 444, COOKED_ASSETS_IN_EDITOR: 485, NAME_HASHES: 504, PRELOAD_DEPENDENCIES: 507, TEMPLATE_INDEX: 508, SEARCHABLE_NAMES: 510, EXPORT_64BIT: 511, SOFT_OBJECT_PATH: 514, LOCALIZATION_ID: 516, PACKAGE_OWNER: 518, NON_OUTER_PACKAGE_IMPORT: 520, ASSETREGISTRY_DEPENDENCYFLAGS: 521, LATEST: 522 } as const;
/** UE5 file versions where the layout changes (EUnrealEngineObjectUE5Version). */
const UE5 = { INITIAL: 1000, NAMES_FROM_EXPORT_DATA: 1001, PAYLOAD_TOC: 1002, OPTIONAL_RESOURCES: 1003, REMOVE_EXPORT_PACKAGE_GUID: 1005, EXPORT_IS_INHERITED: 1006, SOFT_OBJECT_PATH_LIST: 1008, DATA_RESOURCES: 1009, SCRIPT_SERIALIZATION_OFFSET: 1010, METADATA_OFFSET: 1014, VERSE_CELLS: 1015, PACKAGE_SAVED_HASH: 1016, IMPORT_TYPE_HIERARCHIES: 1018, LATEST: 1018 } as const;
/**
 * The newest legacy package format known here. -9 (seen in UE 5.8 packages): the SavedHash and TotalHeaderSize moved
 * up, before the custom versions (so a reader can find the header's size without knowing the custom versions).
 */
const LEGACY_LATEST = -9;
/** Legacy formats below this are not taken for packages at all (a random file whose second word is negative). */
const LEGACY_FLOOR = -32;

/** Caps, so a corrupt count cannot make a huge loop or array. */
const MAX_NAMES = 500_000;
const MAX_TABLE = 200_000;
const MAX_STRING = 1 << 20;
const MAX_TAG_OBJECTS = 2000;
const MAX_TAGS = 5000;
/** Tag values longer than this are cut (a Blueprint's search data can be hundreds of KB). */
const TAG_VALUE_CHARS = 400;

/** One imported object: something of another package this one uses. */
export interface UassetImport {
  classPackage: string;
  className: string;
  objectName: string;
  /** The import or export it sits in (FPackageIndex: <0 import, >0 export, 0 none). */
  outer: number;
}

/** One exported object: something this package holds. */
export interface UassetExport {
  /** Its class's name ("Blueprint", "StaticMesh", "World", "BP_Door_C"…). */
  className: string;
  /** For a class: its parent class's name. */
  superName?: string;
  objectName: string;
  outer: number;
  /** Bytes of its data (in the .uasset or .uexp). */
  serialSize: number;
  isAsset: boolean;
}

/** One object's asset registry tags (what the Content Browser shows without loading it). */
export interface UassetTags {
  object: string;
  className: string;
  tags: Record<string, string>;
}

/** What a package header says. */
export interface UassetHeader {
  /** False when not even the summary could be read (see `error`). */
  ok: boolean;
  error?: string;
  /** Parts that could not be read (the rest is still there). */
  problems: string[];
  /** Soft notes that do not stop the read (a package saved by an engine newer than this reader knows). */
  warnings: string[];
  legacyVersion?: number;
  fileVersionUE4?: number;
  fileVersionUE5?: number;
  licenseeVersion?: number;
  /** Saved without versions (cooked); the layout was guessed. */
  unversioned: boolean;
  /** The engine that saved it ("5.3.2"), or a file-version guess ("UE5 (file 1012)"). */
  engine?: string;
  packageName?: string;
  packageFlags: number;
  /** A level (.umap). */
  isMap: boolean;
  /** Cooked for a game (editor-only data removed). */
  cooked: boolean;
  totalHeaderSize?: number;
  names: string[];
  imports: UassetImport[];
  exports: UassetExport[];
  /** Packages imported (/Script/Engine, /Game/Props/SM_Rock…). */
  hardPackages: string[];
  /** Packages referenced softly (loaded on demand). */
  softPackages: string[];
  tags: UassetTags[];
  /** How many thumbnails the package holds. */
  thumbnails: number;
  /** The file is only in OneDrive (a Files On-Demand placeholder): it was not read, so nothing was downloaded. */
  cloudOnly?: boolean;
}

/** A read past the bytes the reader has (caught inside; never reaches a caller). */
class Short extends Error {}

/** A little-endian cursor over bytes that throws {@link Short} instead of reading past the end. */
class Cursor {
  private readonly view: DataView;
  pos: number;
  constructor(readonly bytes: Uint8Array, pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }
  private need(n: number): number {
    if (n < 0 || this.pos < 0 || this.pos + n > this.bytes.length) throw new Short(`short read at ${this.pos}`);
    const at = this.pos;
    this.pos += n;
    return at;
  }
  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  i64(): number {
    const v = this.view.getBigInt64(this.need(8), true);
    return v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER) ? Number.NaN : Number(v);
  }
  skip(n: number): void {
    this.need(n);
  }
  /** An FString: length (negative: UTF-16), the characters, a trailing NUL. */
  fstring(): string {
    const len = this.i32();
    if (len === 0) return "";
    if (len > 0) {
      if (len > MAX_STRING) throw new Short("string too long");
      const at = this.need(len);
      return latin1(this.bytes.subarray(at, at + len - 1));
    }
    if (len < -MAX_STRING) throw new Short("string too long");
    const n = -len;
    const at = this.need(n * 2);
    let s = "";
    for (let i = 0; i < n - 1; i++) s += String.fromCharCode(this.view.getUint16(at + i * 2, true));
    return s;
  }
}

/** Bytes as Latin-1 text (UE's "ANSI" strings), in chunks so a long string does not overflow the call stack. */
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
  return s;
}

/** The summary's fields this reader uses. */
interface Summary {
  legacy: number;
  /** The legacy format whose layout was used (the newest known one for a newer package). */
  layout: number;
  /** The file versions written in the file (0 for an unversioned one), before any guess. */
  savedUe4: number;
  savedUe5: number;
  ue4: number;
  ue5: number;
  licensee: number;
  unversioned: boolean;
  totalHeaderSize: number;
  packageName: string;
  flags: number;
  nameCount: number;
  nameOffset: number;
  exportCount: number;
  exportOffset: number;
  importCount: number;
  importOffset: number;
  softRefCount: number;
  softRefOffset: number;
  thumbnailOffset: number;
  engine?: string;
  assetRegistryOffset: number;
  /** Where the summary ended (the name map starts at or after it). */
  end: number;
}

/** "5.3.2" from an FEngineVersion, or undefined when it is empty (licensee builds, some cooks). */
function engineVersion(c: Cursor): string | undefined {
  const major = c.u16();
  const minor = c.u16();
  const patch = c.u16();
  c.u32(); // changelist
  c.fstring(); // branch
  return major ? `${major}.${minor}.${patch}` : undefined;
}

/**
 * Reads the summary with the given file versions (for unversioned packages: a guess) and, for a legacy format newer
 * than {@link LEGACY_LATEST}, the given known layout (default: the newest).
 *
 * @throws Short on a short read; Error on a layout this reader does not know.
 */
function readSummary(bytes: Uint8Array, guess?: { ue4: number; ue5: number; layout?: number }): Summary {
  const c = new Cursor(bytes);
  const tag = c.u32();
  if (tag === PACKAGE_TAG_SWAPPED) throw new Error("This package was saved byte-swapped (a console build): not read here.");
  if (tag !== PACKAGE_TAG) throw new Error("Not an Unreal package (.uasset/.umap).");
  const legacy = c.i32();
  if (legacy >= 0 || legacy < LEGACY_FLOOR) throw new Error(`Unknown package format (${legacy}).`);
  // A newer format than known: read as the newest known one (or the layout being tried).
  const layout = legacy < LEGACY_LATEST ? (guess?.layout ?? LEGACY_LATEST) : legacy;
  if (layout !== -4) c.i32(); // LegacyUE3Version
  let ue4 = c.i32();
  let ue5 = layout <= -8 ? c.i32() : 0;
  const licensee = c.i32();
  const savedUe4 = ue4;
  const savedUe5 = ue5;
  // Since -9 the SavedHash and TotalHeaderSize come before the custom versions.
  let totalHeaderSize = 0;
  if (layout <= -9) {
    c.skip(20); // SavedHash (FIoHash)
    totalHeaderSize = c.i32();
  }
  if (layout <= -2) {
    // Custom versions: Optimized (GUID + version) since -6, GUID + version + name for -3..-5, tag + version for -2.
    const n = c.i32();
    if (n < 0 || n > 10_000) throw new Error("Bad custom version count.");
    for (let i = 0; i < n; i++) {
      if (layout < -5) c.skip(20);
      else if (layout < -2) {
        c.skip(20);
        c.fstring();
      } else c.skip(8);
    }
  }
  const unversioned = ue4 === 0 && ue5 === 0 && licensee === 0;
  if (unversioned) {
    ue4 = guess?.ue4 ?? UE4.LATEST;
    ue5 = layout <= -8 ? (guess?.ue5 ?? UE5.LATEST) : 0;
  } else if (guess) {
    // A retry with other thresholds (a versioned file whose layout did not check out).
    ue4 = guess.ue4;
    ue5 = guess.ue5;
  }
  if (layout > -9) {
    if (ue5 >= UE5.PACKAGE_SAVED_HASH) c.skip(20); // SavedHash (FIoHash)
    totalHeaderSize = c.i32();
  }
  const packageName = c.fstring();
  const flags = c.u32();
  const editorOnly = (flags & PKG_FILTER_EDITOR_ONLY) === 0;
  const nameCount = c.i32();
  const nameOffset = c.i32();
  if (ue5 >= UE5.SOFT_OBJECT_PATH_LIST) c.skip(8);
  if (editorOnly && ue4 >= UE4.LOCALIZATION_ID) c.fstring();
  if (ue4 >= UE4.SERIALIZE_TEXT) c.skip(8);
  const exportCount = c.i32();
  const exportOffset = c.i32();
  const importCount = c.i32();
  const importOffset = c.i32();
  if (ue5 >= UE5.VERSE_CELLS) c.skip(16);
  if (ue5 >= UE5.METADATA_OFFSET) c.skip(4);
  c.i32(); // DependsOffset
  let softRefCount = 0;
  let softRefOffset = 0;
  if (ue4 >= UE4.SOFT_PACKAGE_REFS) {
    softRefCount = c.i32();
    softRefOffset = c.i32();
  }
  if (ue4 >= UE4.SEARCHABLE_NAMES) c.skip(4);
  const thumbnailOffset = c.i32();
  if (ue5 >= UE5.IMPORT_TYPE_HIERARCHIES) c.skip(8); // ImportTypeHierarchies count and offset
  if (ue5 < UE5.PACKAGE_SAVED_HASH) c.skip(16); // Guid
  if (editorOnly && ue4 >= UE4.PACKAGE_OWNER) {
    c.skip(16); // PersistentGuid
    if (ue4 < UE4.NON_OUTER_PACKAGE_IMPORT) c.skip(16); // OwnerPersistentGuid
  }
  const generations = c.i32();
  if (generations < 0 || generations > 100_000) throw new Error("Bad generation count.");
  c.skip(generations * 8);
  let engine: string | undefined;
  if (ue4 >= UE4.ENGINE_VERSION_OBJECT) engine = engineVersion(c);
  else c.skip(4);
  if (ue4 >= UE4.COMPATIBLE_ENGINE_VERSION) {
    const compatible = engineVersion(c);
    engine = engine ?? compatible;
  }
  c.u32(); // CompressionFlags
  const chunks = c.i32();
  if (chunks !== 0) throw new Error("This package is compressed (an old cook): not read here.");
  c.u32(); // PackageSource
  const extra = c.i32();
  if (extra < 0 || extra > 10_000) throw new Error("Bad package list.");
  for (let i = 0; i < extra; i++) c.fstring();
  if (layout > -7) c.skip(4); // NumTextureAllocations
  const assetRegistryOffset = c.i32();
  return { legacy, layout, savedUe4, savedUe5, ue4, ue5, licensee, unversioned, totalHeaderSize, packageName, flags, nameCount, nameOffset, exportCount, exportOffset, importCount, importOffset, softRefCount, softRefOffset, thumbnailOffset, ...(engine ? { engine } : {}), assetRegistryOffset, end: c.pos };
}

/** The bytes one import takes, for a version. */
function importSize(s: Summary): number {
  let n = 8 + 8 + 4 + 8;
  if (s.ue4 >= UE4.NON_OUTER_PACKAGE_IMPORT && (s.flags & PKG_FILTER_EDITOR_ONLY) === 0) n += 8;
  if (s.ue5 >= UE5.OPTIONAL_RESOURCES) n += 4;
  return n;
}

/** The bytes one export takes, for a version. */
function exportSize(s: Summary): number {
  let n = 4 + 4 + 4 + 8 + 4; // class, super, outer, name, flags
  if (s.ue4 >= UE4.TEMPLATE_INDEX) n += 4;
  n += s.ue4 >= UE4.EXPORT_64BIT ? 16 : 8;
  n += 12; // forced export, not for client, not for server
  if (s.ue5 < UE5.REMOVE_EXPORT_PACKAGE_GUID) n += 16;
  if (s.ue5 >= UE5.EXPORT_IS_INHERITED) n += 4;
  n += 4; // package flags
  if (s.ue4 >= UE4.LOAD_FOR_EDITOR_GAME) n += 4;
  if (s.ue4 >= UE4.COOKED_ASSETS_IN_EDITOR) n += 4;
  if (s.ue5 >= UE5.OPTIONAL_RESOURCES) n += 4;
  if (s.ue4 >= UE4.PRELOAD_DEPENDENCIES) n += 20;
  if (s.ue5 >= UE5.SCRIPT_SERIALIZATION_OFFSET) n += 16;
  return n;
}

/** The tables read with one layout (or the reason they make no sense with it). */
interface Tables {
  names: string[];
  imports: UassetImport[];
  exports: UassetExport[];
}

/** Whether a name looks like a real FName (printable, not empty, not huge). */
const goodName = (n: string) => n.length > 0 && n.length < 1024 && ![...n].some((ch) => ch.charCodeAt(0) < 0x20);

/**
 * Reads the name map, imports and exports with a summary's layout, checking they make sense (offsets after the
 * summary and inside the header, every name index in range).
 *
 * @throws Error when they do not (the caller tries another layout); Short when the bytes end.
 */
function readTables(bytes: Uint8Array, s: Summary): Tables {
  const header = Math.min(s.totalHeaderSize, bytes.length);
  const inHeader = (off: number, count: number, size: number) => count === 0 || (off >= s.end && off + count * size <= s.totalHeaderSize);
  if (s.totalHeaderSize < s.end || s.nameCount < 0 || s.nameCount > MAX_NAMES || s.importCount < 0 || s.importCount > MAX_TABLE || s.exportCount < 0 || s.exportCount > MAX_TABLE) throw new Error("Bad table counts.");
  if (!inHeader(s.nameOffset, s.nameCount, 5) || !inHeader(s.importOffset, s.importCount, importSize(s)) || !inHeader(s.exportOffset, s.exportCount, exportSize(s))) throw new Error("Table outside the header.");
  if (header < s.totalHeaderSize && Math.max(s.nameOffset, s.importOffset + s.importCount * importSize(s), s.exportOffset + s.exportCount * exportSize(s)) > header) throw new Short("tables past the bytes read");

  const c = new Cursor(bytes, s.nameOffset);
  const names: string[] = [];
  for (let i = 0; i < s.nameCount; i++) {
    const n = c.fstring();
    if (!goodName(n)) throw new Error("Bad name.");
    names.push(n);
    if (s.ue4 >= UE4.NAME_HASHES) c.skip(4);
  }
  const fname = (cur: Cursor): string => {
    const i = cur.i32();
    const num = cur.i32();
    if (i < 0 || i >= names.length || num < 0) throw new Error("Name index out of range.");
    return num > 0 ? `${names[i]}_${num - 1}` : names[i]!;
  };
  const inRange = (idx: number) => (idx < 0 ? -idx - 1 < s.importCount : idx === 0 || idx - 1 < s.exportCount);

  const imports: UassetImport[] = [];
  c.pos = s.importOffset;
  for (let i = 0; i < s.importCount; i++) {
    const start = c.pos;
    const classPackage = fname(c);
    const className = fname(c);
    const outer = c.i32();
    const objectName = fname(c);
    if (!inRange(outer)) throw new Error("Import outer out of range.");
    imports.push({ classPackage, className, objectName, outer });
    c.pos = start + importSize(s);
  }

  const exports: Array<UassetExport & { classIndex: number; superIndex: number }> = [];
  c.pos = s.exportOffset;
  for (let i = 0; i < s.exportCount; i++) {
    const start = c.pos;
    const classIndex = c.i32();
    const superIndex = c.i32();
    if (s.ue4 >= UE4.TEMPLATE_INDEX) c.skip(4);
    const outer = c.i32();
    const objectName = fname(c);
    c.u32(); // object flags
    const serialSize = s.ue4 >= UE4.EXPORT_64BIT ? c.i64() : c.i32();
    if (s.ue4 >= UE4.EXPORT_64BIT) c.i64();
    else c.i32();
    c.skip(12);
    if (s.ue5 < UE5.REMOVE_EXPORT_PACKAGE_GUID) c.skip(16);
    if (s.ue5 >= UE5.EXPORT_IS_INHERITED) c.skip(4);
    c.skip(4);
    if (s.ue4 >= UE4.LOAD_FOR_EDITOR_GAME) c.skip(4);
    const isAsset = s.ue4 >= UE4.COOKED_ASSETS_IN_EDITOR ? c.i32() !== 0 : false;
    if (!inRange(classIndex) || !inRange(superIndex) || !inRange(outer) || !(serialSize >= 0)) throw new Error("Export fields out of range.");
    exports.push({ classIndex, superIndex, className: "", objectName, outer, serialSize, isAsset });
    c.pos = start + exportSize(s);
  }
  // Class and parent names: an import's object name, or another export's (a class defined in this package).
  const nameOf = (idx: number): string | undefined => (idx < 0 ? imports[-idx - 1]?.objectName : idx > 0 ? exports[idx - 1]?.objectName : undefined);
  const out = exports.map(({ classIndex, superIndex, ...e }) => {
    const superName = nameOf(superIndex);
    return { ...e, className: nameOf(classIndex) ?? "Class", ...(superName ? { superName } : {}) };
  });
  return { names, imports, exports: out };
}

/** One layout to try: file versions and, for a legacy format newer than known, the known format to read it as. */
type Guess = { ue4: number; ue5: number; layout?: number };

/** The candidate layouts for a package whose layout is unknown or did not check out, newest first. */
function guesses(legacy: number): Guess[] {
  const ue4 = [522, 518, 516, 514, 511, 510, 508, 507, 504, 459];
  const ue5 = [1018, 1017, 1016, 1015, 1014, 1012, 1010, 1009, 1008, 1006, 1005, 1004, 1003, 1002, 1001, 1000];
  const asUe5 = (layout?: number) => ue5.map((v) => ({ ue4: UE4.LATEST, ue5: v, ...(layout ? { layout } : {}) }));
  // A newer legacy format: the newest known one first, then the one before it.
  if (legacy < LEGACY_LATEST) return [...asUe5(LEGACY_LATEST), ...asUe5(-8)];
  return legacy <= -8 ? asUe5() : ue4.map((v) => ({ ue4: v, ue5: 0 }));
}

/** Soft warnings for a package saved by an engine newer than this reader knows. */
function newerWarnings(s: Summary): string[] {
  const out: string[] = [];
  if (s.legacy < LEGACY_LATEST) out.push(`Saved by a newer Unreal (package format ${s.legacy}): read as format ${s.layout}.`);
  if (s.savedUe5 > UE5.LATEST || s.savedUe4 > UE4.LATEST) out.push(`Saved by a newer Unreal (file version ${s.savedUe5 > UE5.LATEST ? s.savedUe5 : s.savedUe4}): read with the newest known layout.`);
  return out;
}

/** A FName or FString list (soft package references), each kept only when it looks like a package path. */
function readSoftRefs(bytes: Uint8Array, s: Summary, names: string[]): string[] {
  if (!s.softRefCount || s.softRefOffset <= 0) return [];
  if (s.softRefCount < 0 || s.softRefCount > MAX_TABLE) throw new Error("Bad soft reference count.");
  const c = new Cursor(bytes, s.softRefOffset);
  const out = new Set<string>();
  for (let i = 0; i < s.softRefCount; i++) {
    let name: string;
    if (s.ue4 >= UE4.SOFT_OBJECT_PATH) {
      const idx = c.i32();
      const num = c.i32();
      if (idx < 0 || idx >= names.length) throw new Error("Soft reference out of range.");
      name = num > 0 ? `${names[idx]}_${num - 1}` : names[idx]!;
    } else name = c.fstring();
    if (name.startsWith("/")) out.add(name);
  }
  return [...out];
}

/** The asset registry tags (DependencyDataOffset first in editor packages saved since 4.26). */
function readTags(bytes: Uint8Array, s: Summary): UassetTags[] {
  if (s.assetRegistryOffset <= 0) return [];
  const c = new Cursor(bytes, s.assetRegistryOffset);
  if (s.ue4 >= UE4.ASSETREGISTRY_DEPENDENCYFLAGS && (s.flags & PKG_FILTER_EDITOR_ONLY) === 0) c.i64();
  const count = c.i32();
  if (count < 0 || count > MAX_TAG_OBJECTS) throw new Error("Bad tag object count.");
  const out: UassetTags[] = [];
  for (let i = 0; i < count; i++) {
    const object = c.fstring();
    const className = c.fstring();
    const n = c.i32();
    if (n < 0 || n > MAX_TAGS) throw new Error("Bad tag count.");
    const tags: Record<string, string> = {};
    for (let j = 0; j < n; j++) {
      const k = c.fstring();
      const v = c.fstring();
      if (k && !(k in tags)) tags[k] = v.length > TAG_VALUE_CHARS ? `${v.slice(0, TAG_VALUE_CHARS)}…` : v;
    }
    out.push({ object, className, tags });
  }
  return out;
}

/** How many thumbnails the table at ThumbnailTableOffset lists. */
function readThumbnails(bytes: Uint8Array, s: Summary): number {
  if (s.thumbnailOffset <= 0) return 0;
  const n = new Cursor(bytes, s.thumbnailOffset).i32();
  return n > 0 && n < 100_000 ? n : 0;
}

/**
 * Reads a package header from its first bytes. Never throws: a file that is not a package, or is cut or corrupt,
 * gives `ok: false` with `error`, or what could be read with the rest named in `problems`.
 *
 * @param bytes - The file's first bytes (best: at least the summary's TotalHeaderSize; see {@link headerBytesNeeded}).
 * @returns The header.
 */
export function parseUassetHeader(bytes: Uint8Array): UassetHeader {
  const empty: UassetHeader = { ok: false, problems: [], warnings: [], unversioned: false, packageFlags: 0, isMap: false, cooked: false, names: [], imports: [], exports: [], hardPackages: [], softPackages: [], tags: [], thumbnails: 0 };
  let s: Summary | undefined;
  let firstError: Error | undefined;
  try {
    s = readSummary(bytes);
  } catch (err) {
    // An unversioned package's summary may only read with an older layout: those are tried below.
    firstError = err instanceof Short ? new Error("The file is cut short: not a whole Unreal package header.") : (err as Error);
  }
  // The tables with the file's own layout; when they (or the summary) do not check out (unversioned, or a version
  // this reader knows the thresholds of only roughly), the known layouts newest first.
  const legacy = s?.legacy ?? (bytes.length >= 8 ? new DataView(bytes.buffer, bytes.byteOffset, 8).getInt32(4, true) : 0);
  let tables: Tables | undefined;
  let short = false;
  const tries: Array<Guess | undefined> = !s || s.unversioned ? guesses(legacy) : [undefined, ...guesses(legacy)];
  for (const g of tries) {
    try {
      const sum = g ? readSummary(bytes, g) : s!;
      tables = readTables(bytes, sum);
      s = sum;
      break;
    } catch (err) {
      // The bytes end before the tables with the file's own layout: other layouts would not help.
      if (err instanceof Short) {
        short = true;
        if (!g) break;
      }
    }
  }
  if (!s) return { ...empty, error: firstError?.message ?? "Not an Unreal package (.uasset/.umap)." };
  const engine = s.engine ?? (s.unversioned ? undefined : s.ue5 ? `UE5 (file ${s.ue5})` : `UE4 (file ${s.ue4})`);
  const head: UassetHeader = {
    ...empty,
    ok: true,
    legacyVersion: s.legacy,
    fileVersionUE4: s.unversioned ? 0 : s.ue4,
    ...(s.legacy <= -8 ? { fileVersionUE5: s.unversioned ? 0 : s.ue5 } : {}),
    licenseeVersion: s.licensee,
    unversioned: s.unversioned || (s.flags & PKG_UNVERSIONED) !== 0,
    ...(engine ? { engine } : {}),
    ...(s.packageName && s.packageName !== "None" ? { packageName: s.packageName } : {}),
    packageFlags: s.flags,
    isMap: (s.flags & PKG_CONTAINS_MAP) !== 0,
    cooked: (s.flags & PKG_FILTER_EDITOR_ONLY) !== 0,
    totalHeaderSize: s.totalHeaderSize,
    warnings: newerWarnings(s),
  };
  if (!tables) {
    head.problems.push(short ? "The header is longer than the bytes read." : "The name, import and export tables could not be read.");
    return head;
  }
  head.names = tables.names;
  head.imports = tables.imports;
  head.exports = tables.exports;
  head.hardPackages = [...new Set(tables.imports.filter((i) => i.outer === 0 && i.className === "Package" && i.objectName.startsWith("/")).map((i) => i.objectName))];
  const part = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      head.problems.push(what);
      return fallback;
    }
  };
  head.softPackages = part("soft references", () => readSoftRefs(bytes, s, tables.names), []);
  head.tags = part("asset registry tags", () => readTags(bytes, s), []);
  head.thumbnails = part("thumbnails", () => readThumbnails(bytes, s), 0);
  return head;
}

/**
 * How many bytes from the start hold the whole header, read from its first bytes (the summary's TotalHeaderSize).
 *
 * @param first - The file's first bytes (a few KB hold the summary).
 * @returns The header's size, or undefined when the summary cannot be read from these bytes.
 */
export function headerBytesNeeded(first: Uint8Array): number | undefined {
  try {
    const s = readSummary(first);
    return s.totalHeaderSize > 0 ? s.totalHeaderSize : undefined;
  } catch {
    return undefined;
  }
}

/** Bytes read first: enough for the summary and, for most assets, the whole header. */
const FIRST_READ = 16 * 1024;

/**
 * Reads a .uasset/.umap file's header: its first bytes, then (when the header is longer) up to the header's end,
 * never more than `maxBytes`. Never throws. A file only in OneDrive (a placeholder, seen from its stat or its read
 * error) gives `ok: false` with `cloudOnly` and is not read, so no download starts.
 *
 * @param abs - The file.
 * @param opts.maxBytes - The most bytes read (default 16 MB; a header bigger than this is read in part).
 * @returns The header, with the file's size.
 */
export async function readUassetFile(abs: string, opts: { maxBytes?: number } = {}): Promise<UassetHeader & { size: number }> {
  const max = Math.max(FIRST_READ, opts.maxBytes ?? 16 * 1024 * 1024);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  let size = 0;
  const cloudOnly = () => ({ ...parseUassetHeader(new Uint8Array()), error: CLOUD_ONLY_MESSAGE, cloudOnly: true, size });
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error("Not a file.");
    size = st.size;
    if (looksCloudOnly(st)) return cloudOnly();
    fh = await open(abs, "r");
    const first = Buffer.alloc(Math.min(FIRST_READ, st.size));
    const { bytesRead } = await fh.read(first, 0, first.length, 0);
    let bytes: Uint8Array = first.subarray(0, bytesRead);
    const want = Math.min(headerBytesNeeded(bytes) ?? 0, st.size, max);
    if (want > bytes.length) {
      const all = Buffer.alloc(want);
      all.set(bytes);
      const more = await fh.read(all, bytes.length, want - bytes.length, bytes.length);
      bytes = all.subarray(0, bytes.length + more.bytesRead);
    }
    const head = parseUassetHeader(bytes);
    if (head.ok && head.totalHeaderSize && head.totalHeaderSize > max) head.problems.push(`Only the first ${Math.round(max / 1048576)} MB of the header were read.`);
    return { ...head, size: st.size };
  } catch (err) {
    if (isCloudReadError(err, size)) return cloudOnly();
    return { ...parseUassetHeader(new Uint8Array()), error: (err as Error).message, size: 0 };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Unreal classes as the kind words the project index uses (game-index.ts groups them). */
const CLASS_KIND: Record<string, string> = {
  Blueprint: "Blueprint", BlueprintGeneratedClass: "Blueprint", WidgetBlueprint: "widget", EditorUtilityWidgetBlueprint: "widget", AnimBlueprint: "anim Blueprint",
  World: "level", StaticMesh: "static mesh", SkeletalMesh: "skeletal mesh", Skeleton: "skeleton", PhysicsAsset: "physics asset",
  Material: "material", MaterialInstanceConstant: "material instance", MaterialFunction: "material function", MaterialParameterCollection: "material parameters",
  Texture2D: "texture", TextureCube: "texture", TextureRenderTarget2D: "texture", SoundWave: "sound", SoundCue: "sound", MetaSoundSource: "sound",
  NiagaraSystem: "Niagara", NiagaraEmitter: "Niagara", ParticleSystem: "particles", AnimSequence: "animation", AnimMontage: "animation", BlendSpace: "animation", BlendSpace1D: "animation",
  DataTable: "data table", CurveTable: "data table", DataAsset: "data asset", PrimaryDataAsset: "data asset", UserDefinedEnum: "enum", UserDefinedStruct: "struct",
  InputAction: "input", InputMappingContext: "input", LevelSequence: "sequence", BehaviorTree: "behavior tree", BlackboardData: "blackboard", Font: "font", FontFace: "font",
};

/** The main asset of a package, its class, and (Blueprints) its parent class. */
export interface UassetSummary {
  /** The asset's name (BP_Door, L_Main…). */
  name?: string;
  /** Its class (Blueprint, StaticMesh, World…). */
  className?: string;
  /** A kind word for the index ("Blueprint", "static mesh", "level"…); undefined for an unknown class. */
  kind?: string;
  /** Blueprints: the class it extends ("Character", "BP_Enemy"). */
  parent?: string;
}

/** The last part of a class path from a tag ("/Script/CoreUObject.Class'/Script/Engine.Actor'" → "Actor"). */
function classFromTag(v: string | undefined): string | undefined {
  const m = v && /([A-Za-z0-9_]+)'?"?\s*$/.exec(v.replace(/'+$/, ""));
  return m?.[1]?.replace(/_C$/, "");
}

/**
 * The main asset of a read header: the export marked as the asset, else the top-level export named as the package,
 * else the first top-level one; for a Blueprint also its parent class (from its generated class, else its tags).
 *
 * @param h - A read header.
 * @param fileName - The file's name without extension (the asset's usual name).
 * @returns What the package is; empty when nothing could be read.
 */
export function uassetSummary(h: UassetHeader, fileName?: string): UassetSummary {
  const top = h.exports.filter((e) => e.outer === 0);
  const main = h.exports.find((e) => e.isAsset) ?? top.find((e) => e.objectName === fileName) ?? (h.isMap ? top.find((e) => e.className === "World") : undefined) ?? top[0];
  const fromTags = h.tags.find((t) => !main || t.object.endsWith(`.${main.objectName}`) || t.object === main.objectName) ?? h.tags[0];
  const className = main?.className ?? (fromTags?.className.split(/[./]/).pop() || undefined);
  if (!className) return {};
  const name = main?.objectName ?? fromTags?.object.split(".").pop();
  let parent: string | undefined;
  if (/Blueprint$/.test(className)) {
    const gen = h.exports.find((e) => e.objectName === `${name}_C`);
    parent = gen?.superName?.replace(/_C$/, "") ?? classFromTag(fromTags?.tags.ParentClass ?? fromTags?.tags.NativeParentClass);
  }
  const kind = CLASS_KIND[className] ?? (h.isMap ? "level" : undefined);
  return { ...(name ? { name } : {}), className, ...(kind ? { kind } : {}), ...(parent ? { parent } : {}) };
}

/**
 * A package's name from its file in the project (Content/Props/SM_Rock.uasset → /Game/Props/SM_Rock).
 *
 * @param rel - The path relative to the project, with /.
 * @returns The package name, or undefined for a file outside Content/.
 */
export function packageNameOf(rel: string): string | undefined {
  const m = /^Content\/(.+)\.(uasset|umap)$/i.exec(rel.replace(/\\/g, "/"));
  return m ? `/Game/${m[1]}` : undefined;
}

/**
 * The file of a /Game package in the project (/Game/Props/SM_Rock → Content/Props/SM_Rock, without extension).
 *
 * @param pkg - A package name.
 * @returns The path without its extension, or undefined for a package outside /Game.
 */
export function packageFileOf(pkg: string): string | undefined {
  const m = /^\/Game\/([^.:]+)$/.exec(pkg);
  return m && !m[1]!.split("/").includes("..") ? `Content/${m[1]}` : undefined;
}
