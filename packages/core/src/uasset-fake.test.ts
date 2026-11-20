import assert from "node:assert/strict";

/**
 * Small package headers built in code (no Epic content): the summary, name map, imports, exports, soft references,
 * thumbnails and asset registry tags, laid out as FPackageFileSummary & co. for a UE4 or UE5 file version.
 */

/** Little-endian byte writer. */
export class W {
  private parts: number[] = [];
  get length() {
    return this.parts.length;
  }
  u8(...b: number[]) {
    this.parts.push(...b);
    return this;
  }
  i32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v | 0);
    return this.u8(...b);
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return this.u8(...b);
  }
  u16(v: number) {
    return this.u8(v & 0xff, (v >> 8) & 0xff);
  }
  i64(v: number) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    return this.u8(...b);
  }
  zeros(n: number) {
    return this.u8(...new Array<number>(n).fill(0));
  }
  str(s: string) {
    if (!s) return this.i32(0);
    if ([...s].every((ch) => ch.charCodeAt(0) < 0x100)) return this.i32(s.length + 1).u8(...[...s].map((c) => c.charCodeAt(0)), 0);
    this.i32(-(s.length + 1));
    for (const ch of s) this.u16(ch.charCodeAt(0));
    return this.u16(0);
  }
  bytes() {
    return Uint8Array.from(this.parts);
  }
}

export interface Spec {
  legacy: number;
  ue4: number;
  ue5?: number;
  /** Write zero versions (cooked, unversioned) but lay the tables out as ue4/ue5. */
  unversioned?: boolean;
  flags?: number;
  engine?: [number, number, number];
  names: string[];
  /** [classPackage, className, outer, objectName] as name indexes. */
  imports: Array<[number, number, number, number]>;
  /** [classIndex, superIndex, outer, objectName (name index), isAsset]. */
  exports: Array<[number, number, number, number, boolean]>;
  /** Name indexes. */
  soft?: number[];
  thumbnails?: number;
  tags?: Array<{ object: string; cls: string; tags: Array<[string, string]> }>;
}

export const EDITOR_ONLY = 0x80000000;

/** A package header for a spec. */
export function build(spec: Spec): Uint8Array {
  const ue4 = spec.ue4;
  const ue5 = spec.ue5 ?? 0;
  const flags = spec.flags ?? 0;
  const editor = (flags & EDITOR_ONLY) === 0;
  const summary = (o: Record<string, number>) => {
    const w = new W().u32(0x9e2a83c1).i32(spec.legacy);
    if (spec.legacy !== -4) w.i32(864);
    w.i32(spec.unversioned ? 0 : ue4);
    if (spec.legacy <= -8) w.i32(spec.unversioned ? 0 : ue5);
    w.i32(0).i32(spec.unversioned ? 0 : 1);
    if (!spec.unversioned) w.zeros(16).i32(3); // one custom version
    if (ue5 >= 1016) w.zeros(20);
    w.i32(o.total!).str("None").u32(flags).i32(spec.names.length).i32(o.names!);
    if (ue5 >= 1008) w.i32(0).i32(0);
    if (editor && ue4 >= 516) w.str("");
    if (ue4 >= 459) w.i32(0).i32(0);
    w.i32(spec.exports.length).i32(o.exports!).i32(spec.imports.length).i32(o.imports!);
    if (ue5 >= 1015) w.zeros(16);
    if (ue5 >= 1014) w.i32(0);
    w.i32(0); // depends
    if (ue4 >= 384) w.i32(spec.soft?.length ?? 0).i32(o.soft!);
    if (ue4 >= 510) w.i32(0);
    w.i32(o.thumbs!);
    if (ue5 < 1016) w.zeros(16);
    if (editor && ue4 >= 518) w.zeros(16);
    w.i32(1).i32(spec.exports.length).i32(spec.names.length); // one generation
    const [ma, mi, pa] = spec.engine ?? [0, 0, 0];
    w.u16(ma).u16(mi).u16(pa).u32(123).str("++UE+Release");
    w.u16(ma).u16(mi).u16(pa).u32(123).str("++UE+Release");
    w.u32(0).i32(0).u32(0).i32(0);
    if (spec.legacy > -7) w.i32(0);
    w.i32(o.registry!).i64(o.total!).i32(0).i32(0).i32(0).i32(0);
    if (ue5 >= 1001) w.i32(0);
    if (ue5 >= 1002) w.i64(0);
    if (ue5 >= 1009) w.i32(-1);
    return w;
  };
  const head = summary({ total: 0, names: 0, exports: 0, imports: 0, soft: 0, thumbs: 0, registry: 0 }).length;
  const body = new W();
  const at = () => head + body.length;
  const o: Record<string, number> = {};
  o.names = at();
  for (const n of spec.names) {
    body.str(n);
    if (ue4 >= 504) body.u16(0).u16(0);
  }
  const fname = (i: number) => body.i32(i).i32(0);
  o.imports = at();
  for (const [cp, cn, outer, name] of spec.imports) {
    fname(cp);
    fname(cn);
    body.i32(outer);
    fname(name);
    if (ue4 >= 520 && editor) fname(0);
    if (ue5 >= 1003) body.i32(0);
  }
  o.exports = at();
  for (const [cls, sup, outer, name, isAsset] of spec.exports) {
    body.i32(cls).i32(sup);
    if (ue4 >= 508) body.i32(0);
    body.i32(outer);
    fname(name);
    body.u32(0);
    if (ue4 >= 511) body.i64(100).i64(0);
    else body.i32(100).i32(0);
    body.i32(0).i32(0).i32(0);
    if (ue5 < 1005) body.zeros(16);
    if (ue5 >= 1006) body.i32(0);
    body.u32(0);
    if (ue4 >= 365) body.i32(0);
    if (ue4 >= 485) body.i32(isAsset ? 1 : 0);
    if (ue5 >= 1003) body.i32(0);
    if (ue4 >= 507) body.zeros(20);
    if (ue5 >= 1010) body.zeros(16);
  }
  o.soft = spec.soft?.length ? at() : 0;
  for (const s of spec.soft ?? []) fname(s);
  o.thumbs = spec.thumbnails ? at() : 0;
  if (spec.thumbnails) {
    body.i32(spec.thumbnails);
    for (let i = 0; i < spec.thumbnails; i++) body.str("Blueprint").str("BP_Door").i32(0);
  }
  o.registry = spec.tags ? at() : 0;
  if (spec.tags) {
    if (ue4 >= 521 && editor) body.i64(0);
    body.i32(spec.tags.length);
    for (const t of spec.tags) {
      body.str(t.object).str(t.cls).i32(t.tags.length);
      for (const [k, v] of t.tags) body.str(k).str(v);
    }
  }
  o.total = at();
  const sum = summary(o).bytes();
  assert.equal(sum.length, head);
  const out = new Uint8Array(head + body.length);
  out.set(sum);
  out.set(body.bytes(), head);
  return out;
}

/** A Blueprint BP_Door extending Actor, using a static mesh and (softly) a sound. */
export function doorSpec(legacy: number, ue4: number, ue5: number, more: Partial<Spec> = {}): Spec {
  const names = ["/Script/CoreUObject", "/Script/Engine", "Class", "Package", "Blueprint", "BlueprintGeneratedClass", "Actor", "BP_Door", "BP_Door_C", "/Game/Props/SM_Door", "StaticMesh", "SM_Door", "/Game/Audio/S_Creak", "Default__BP_Door_C"];
  return {
    legacy,
    ue4,
    ue5,
    engine: ue5 ? [5, 3, 2] : [4, 27, 2],
    names,
    imports: [
      [0, 3, 0, 1], // -1 Package /Script/Engine
      [0, 2, -1, 4], // -2 Class Blueprint
      [0, 2, -1, 5], // -3 Class BlueprintGeneratedClass
      [0, 2, -1, 6], // -4 Class Actor
      [0, 3, 0, 9], // -5 Package /Game/Props/SM_Door
      [1, 10, -5, 11], // -6 StaticMesh SM_Door
    ],
    exports: [
      [-2, 0, 0, 7, true], // BP_Door (Blueprint)
      [-3, -4, 0, 8, false], // BP_Door_C extends Actor
      [2, 0, 0, 13, false], // Default__BP_Door_C
    ],
    soft: [12],
    thumbnails: 1,
    tags: [{ object: "/Game/BP/BP_Door.BP_Door", cls: "/Script/Engine.Blueprint", tags: [["ParentClass", "/Script/CoreUObject.Class'/Script/Engine.Actor'"], ["BlueprintType", "BPTYPE_Normal"]] }],
    ...more,
  };
}
