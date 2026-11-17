/**
 * Her course's sources library (design Papers, RESEARCH_LOG "Students, part 28" #6 and part 18 #6, like Semantic
 * Scholar, Consensus and Zotero): real papers found on OpenAlex (open, free, no key) or added by DOI, kept with the
 * course, an APA 7 reference written by code from the paper's own fields, and BibTeX/RIS files for Zotero, Mendeley
 * or EndNote.
 */

/** A paper or book in her course's sources. */
export interface StudySource {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  /** The journal or book it is in. */
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  /** Its page, and a free PDF when there is one. */
  url?: string;
  pdf?: string;
  abstract?: string;
  /** How many papers cite it (OpenAlex), when found by search. */
  cited?: number;
  /** When it was saved. */
  t: number;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const https = (v: unknown) => {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href.slice(0, 600) : "";
  } catch {
    return "";
  }
};
/** A DOI alone (10.x/…), from a bare DOI or a doi.org link. */
export function cleanDoi(v: unknown): string {
  const m = /(10\.\d{4,9}\/[^\s"<>]+)/i.exec(String(v ?? ""));
  return m ? m[1]!.replace(/[.,;)\]]+$/, "").slice(0, 200) : "";
}

/** Her sources, checked (at most 500). */
export function cleanSources(raw: unknown): StudySource[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 500).flatMap((r, i): StudySource[] => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const title = str(x.title, 500);
    if (!title) return [];
    const year = Number(x.year);
    const cited = Number(x.cited);
    const o: StudySource = { id: typeof x.id === "string" && /^[\w-]{1,60}$/.test(x.id) ? x.id : `s${i}${Date.now().toString(36)}`, title, authors: (Array.isArray(x.authors) ? x.authors : []).map((a) => str(a, 120)).filter(Boolean).slice(0, 50), t: Number(x.t) || Date.now() };
    if (Number.isInteger(year) && year > 1000 && year < 3000) o.year = year;
    for (const k of ["venue", "volume", "issue", "pages"] as const) { const v = str(x[k], k === "venue" ? 300 : 40); if (v) o[k] = v; }
    const doi = cleanDoi(x.doi);
    if (doi) o.doi = doi;
    for (const k of ["url", "pdf"] as const) { const v = https(x[k]); if (v) o[k] = v; }
    const abstract = str(x.abstract, 3000);
    if (abstract) o.abstract = abstract;
    if (Number.isInteger(cited) && cited >= 0) o.cited = cited;
    return [o];
  });
}

/** OpenAlex's abstract (an inverted index: word → its places) as text. */
export function openAlexAbstract(inv: unknown): string {
  if (!inv || typeof inv !== "object") return "";
  const words: string[] = [];
  for (const [w, at] of Object.entries(inv as Record<string, unknown>)) if (Array.isArray(at)) for (const i of at) if (Number.isInteger(i) && i >= 0 && i < 5000) words[i as number] = w;
  return words.filter(Boolean).join(" ").slice(0, 3000);
}

/** A field deep in OpenAlex's JSON, or undefined. */
const pick = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

/** OpenAlex works (its /works answer, or one work) as sources (not saved yet). */
export function parseOpenAlex(json: unknown): StudySource[] {
  const list = pick(json, "results");
  const results = Array.isArray(list) ? list : pick(json, "id") ? [json] : [];
  return cleanSources(results.map((x) => {
    const first = pick(x, "biblio", "first_page");
    const last = pick(x, "biblio", "last_page");
    const authorships = pick(x, "authorships");
    return {
      id: `oa-${String(pick(x, "id") ?? "").split("/").pop()}`,
      title: pick(x, "title") ?? pick(x, "display_name"),
      authors: Array.isArray(authorships) ? authorships.map((a) => pick(a, "author", "display_name")) : [],
      year: pick(x, "publication_year"),
      venue: pick(x, "primary_location", "source", "display_name"),
      volume: pick(x, "biblio", "volume"),
      issue: pick(x, "biblio", "issue"),
      pages: first ? (last && last !== first ? `${String(first)}–${String(last)}` : String(first)) : undefined,
      doi: pick(x, "doi"),
      url: pick(x, "doi") || pick(x, "primary_location", "landing_page_url"),
      pdf: pick(x, "open_access", "oa_url") || pick(x, "best_oa_location", "pdf_url"),
      abstract: openAlexAbstract(pick(x, "abstract_inverted_index")),
      cited: pick(x, "cited_by_count"),
      t: 0,
    };
  }));
}

/** "Levi, D." from "Dana Levi" (APA: surname, initials). */
function apaName(full: string): string {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return full;
  const last = parts.pop()!;
  return `${last}, ${parts.map((p) => `${[...p][0]!.toUpperCase()}.`).join(" ")}`;
}

/** Its APA 7 reference (journal article form; a book when it has no journal), from its own fields only. */
export function apaRef(s: StudySource): string {
  const a = s.authors.map(apaName);
  const who = !a.length ? "" : a.length === 1 ? a[0]! : a.length <= 20 ? `${a.slice(0, -1).join(", ")}, & ${a.at(-1)}` : `${a.slice(0, 19).join(", ")}, … ${a.at(-1)}`;
  const year = `(${s.year ?? "n.d."}).`;
  const vol = s.volume ? `, ${s.volume}${s.issue ? `(${s.issue})` : ""}` : "";
  const venue = s.venue ? ` ${s.venue}${vol}${s.pages ? `, ${s.pages}` : ""}.` : "";
  const link = s.doi ? ` https://doi.org/${s.doi}` : s.url ? ` ${s.url}` : "";
  return `${who ? `${who} ` : ""}${year} ${s.title.replace(/\.$/, "")}.${venue}${link}`.replace(/\s+/g, " ").trim();
}

/** Its in-text citation: (Levi, 2020), (Levi & Cohen, 2020), (Levi et al., 2020). */
export function apaCite(s: StudySource): string {
  const last = (n: string) => n.split(/\s+/).filter(Boolean).pop() ?? n;
  const a = s.authors.map(last);
  const who = !a.length ? s.title.split(/\s+/).slice(0, 3).join(" ") : a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} & ${a[1]}` : `${a[0]} et al.`;
  return `(${who}, ${s.year ?? "n.d."})`;
}

const bibEsc = (v: string) => v.replace(/[\\{}]/g, "").replace(/[%&$#_]/g, (c) => `\\${c}`);

/** A BibTeX file of these sources (Zotero, Mendeley, LaTeX). */
export function toBibtex(list: StudySource[]): string {
  const keys = new Set<string>();
  return list.map((s) => {
    const base = `${(s.authors[0] ?? "anon").split(/\s+/).pop()!.replace(/[^A-Za-z0-9]/g, "") || "ref"}${s.year ?? ""}`;
    let key = base;
    for (let n = 2; keys.has(key); n++) key = `${base}${String.fromCharCode(95 + n)}`;
    keys.add(key);
    const f: Array<[string, string | undefined]> = [["title", s.title], ["author", s.authors.join(" and ")], ["year", s.year?.toString()], [s.venue ? "journal" : "publisher", s.venue], ["volume", s.volume], ["number", s.issue], ["pages", s.pages?.replace("–", "--")], ["doi", s.doi], ["url", s.doi ? undefined : s.url]];
    return `@${s.venue ? "article" : "misc"}{${key},\n${f.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${bibEsc(v!)}}`).join(",\n")}\n}`;
  }).join("\n\n") + "\n";
}

/** An RIS file of these sources (EndNote, Zotero, Mendeley). */
export function toRis(list: StudySource[]): string {
  const line = (k: string, v?: string) => (v ? `${k}  - ${v.replace(/[\r\n]+/g, " ")}\r\n` : "");
  return list.map((s) => {
    const [sp, ep] = (s.pages ?? "").split(/[–-]/);
    return `${line("TY", s.venue ? "JOUR" : "GEN")}${line("TI", s.title)}${s.authors.map((a) => line("AU", apaName(a))).join("")}${line("PY", s.year?.toString())}${line("JO", s.venue)}${line("VL", s.volume)}${line("IS", s.issue)}${line("SP", sp)}${line("EP", ep)}${line("DO", s.doi)}${line("UR", s.doi ? `https://doi.org/${s.doi}` : s.url)}${line("AB", s.abstract)}ER  - \r\n`;
  }).join("\r\n");
}

/** A name as "First Last" (BibTeX and RIS keep "Last, First"). */
const firstLast = (n: string) => (n.includes(",") ? `${n.split(",").slice(1).join(" ").trim()} ${n.split(",")[0]!.trim()}` : n).replace(/\s+/g, " ").trim();

/**
 * Sources from a BibTeX file (Zotero, Mendeley, Google Scholar, LaTeX), checked as any source (FUTURE_FEATURES
 * "Zotero import"). Braces and simple LaTeX accents are dropped.
 */
export function parseBibtex(text: string): StudySource[] {
  const out: Array<Record<string, unknown>> = [];
  for (const m of String(text).slice(0, 2_000_000).matchAll(/@(\w+)\s*\{\s*[^,]*,([\s\S]*?)\n\s*\}\s*(?=@|$)/g)) {
    if (/^(comment|string|preamble)$/i.test(m[1]!)) continue;
    const f: Record<string, string> = {};
    for (const g of m[2]!.matchAll(/(\w+)\s*=\s*(\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}|"([^"]*)"|(\d+))/g)) f[g[1]!.toLowerCase()] = (g[3] ?? g[4] ?? g[5] ?? "").replace(/\\["'`^~]?\{?(\w)\}?/g, "$1").replace(/[{}]/g, "").replace(/\\([%&$#_])/g, "$1");
    out.push({ title: f.title, authors: (f.author ?? "").split(/\s+and\s+/i).map(firstLast).filter(Boolean), year: Number(/\d{4}/.exec(f.year ?? f.date ?? "")?.[0]), venue: f.journal ?? f.journaltitle ?? f.booktitle ?? f.publisher, volume: f.volume, issue: f.number ?? f.issue, pages: f.pages?.replace(/--/g, "–"), doi: f.doi, url: f.url });
  }
  return cleanSources(out);
}

/** Sources from an RIS file (EndNote, Zotero, Mendeley, many library sites). */
export function parseRis(text: string): StudySource[] {
  const out: Array<Record<string, unknown>> = [];
  let cur: Record<string, string[]> = {};
  for (const raw of String(text).slice(0, 2_000_000).split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9]) {2}- ?(.*)$/.exec(raw);
    if (!m) continue;
    const [, k, v] = m as unknown as [string, string, string];
    if (k === "ER") {
      const g = (...keys: string[]) => keys.map((x) => cur[x]?.[0]).find(Boolean);
      const sp = g("SP");
      const ep = g("EP");
      out.push({ title: g("TI", "T1", "CT", "BT"), authors: [...(cur.AU ?? []), ...(cur.A1 ?? [])].map(firstLast), year: Number(/\d{4}/.exec(g("PY", "Y1", "DA") ?? "")?.[0]), venue: g("JO", "JF", "T2", "JA", "PB"), volume: g("VL"), issue: g("IS"), pages: sp ? (ep ? `${sp}–${ep}` : sp) : undefined, doi: g("DO"), url: g("UR"), abstract: g("AB", "N2") });
      cur = {};
    } else (cur[k] ??= []).push(v.trim());
  }
  return cleanSources(out);
}

/** Its Chicago reference (author-date, 17th ed.): Levi, Dana, and Ori Cohen. 2020. "Title." Journal 12 (3): 45–67. */
export function chicagoRef(s: StudySource): string {
  const a = s.authors;
  const inv = (n: string) => { const p = n.split(/\s+/).filter(Boolean); return p.length < 2 ? n : `${p.at(-1)}, ${p.slice(0, -1).join(" ")}`; };
  const who = !a.length ? "" : a.length === 1 ? inv(a[0]!) : a.length <= 10 ? `${inv(a[0]!)}, ${a.slice(1, -1).map((x) => `${x}, `).join("")}and ${a.at(-1)}` : `${inv(a[0]!)}, ${a.slice(1, 7).join(", ")}, et al`;
  const vol = s.volume ? ` ${s.volume}${s.issue ? ` (${s.issue})` : ""}` : "";
  const venue = s.venue ? ` ${s.venue}${vol}${s.pages ? `: ${s.pages}` : ""}.` : "";
  const link = s.doi ? ` https://doi.org/${s.doi}.` : s.url ? ` ${s.url}.` : "";
  return `${who ? `${who.replace(/\.$/, "")}. ` : ""}${s.year ?? "n.d."}. “${s.title.replace(/\.$/, "")}.”${venue}${link}`.replace(/\s+/g, " ").trim();
}

/** Its Chicago author-date in-text citation: (Levi 2020), (Levi and Cohen 2020), (Levi et al. 2020). */
export function chicagoCite(s: StudySource): string {
  const last = (n: string) => n.split(/\s+/).filter(Boolean).pop() ?? n;
  const a = s.authors.map(last);
  const who = !a.length ? s.title.split(/\s+/).slice(0, 3).join(" ") : a.length === 1 ? a[0] : a.length <= 3 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : `${a[0]} et al.`;
  return `(${who} ${s.year ?? "n.d."})`;
}

/** Asking "what do the studies say" from these papers' abstracts only, each claim with its [n]. */
export const PAPERS_PROMPT = "You answer a student's research question only from the numbered paper abstracts given. Write a short answer (4-8 sentences): what most studies find, where they disagree, and how strong the evidence looks (study kinds, sizes, when said). After each claim put the paper's number in brackets, e.g. [2]. If the abstracts do not answer the question, say so plainly. Never invent papers, numbers or findings. Answer in the language of the question.";
