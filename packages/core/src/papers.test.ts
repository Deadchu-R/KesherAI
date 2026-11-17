import { test } from "node:test";
import assert from "node:assert/strict";
import { apaCite, apaRef, cleanDoi, cleanSources, mergeCourseData, parseOpenAlex, toBibtex, toRis, type StudyCourseData } from "@kesher/shared";

const work = { id: "https://openalex.org/W123", doi: "https://doi.org/10.1000/xyz.5", title: "Beta blockers & heart rate", publication_year: 2020, authorships: [{ author: { display_name: "Dana Levi" } }, { author: { display_name: "Omer Ben David" } }], primary_location: { source: { display_name: "Journal of Hearts" } }, biblio: { volume: "12", issue: "3", first_page: "45", last_page: "60" }, open_access: { oa_url: "https://example.org/p.pdf" }, abstract_inverted_index: { Beta: [0], blockers: [1], slow: [2], the: [3], heart: [4] }, cited_by_count: 40 };

test("papers from OpenAlex, APA 7 and BibTeX/RIS exports", () => {
  const [p] = parseOpenAlex({ results: [work] });
  assert.ok(p);
  assert.equal(p.abstract, "Beta blockers slow the heart");
  assert.equal(p.doi, "10.1000/xyz.5");
  assert.equal(p.pages, "45–60");
  assert.equal(apaRef(p), "Levi, D., & David, O. B. (2020). Beta blockers & heart rate. Journal of Hearts, 12(3), 45–60. https://doi.org/10.1000/xyz.5");
  assert.equal(apaCite(p), "(Levi & David, 2020)");
  assert.equal(parseOpenAlex(work).length, 1);
  const bib = toBibtex([p, p]);
  assert.match(bib, /@article\{Levi2020,/);
  assert.match(bib, /@article\{Levi2020a,/);
  assert.match(bib, /title = \{Beta blockers \\& heart rate\}/);
  assert.match(bib, /pages = \{45--60\}/);
  const ris = toRis([p]);
  assert.match(ris, /^TY {2}- JOUR\r\n/);
  assert.match(ris, /AU {2}- Levi, D\.\r\n/);
  assert.match(ris, /SP {2}- 45\r\nEP {2}- 60/);
  assert.equal(cleanDoi("see https://doi.org/10.5555/ABC-1)."), "10.5555/ABC-1");
  assert.deepEqual(cleanSources([{ title: "" }, { title: "x", url: "javascript:1", year: 99999 }]).map((s) => [s.title, s.url, s.year]), [["x", undefined, undefined]]);
});

test("sources come through a sync", () => {
  const base: StudyCourseData = { course: { id: "c", name: "c", createdAt: 1 }, lectures: [], cards: [], reviews: [], quizzes: [] };
  const m = mergeCourseData({ ...base, sources: [{ id: "a", title: "A", authors: [], t: 1 }] }, { ...base, sources: [{ id: "b", title: "B", authors: [], t: 2 }] });
  assert.deepEqual(m.sources?.map((s) => s.id).sort(), ["a", "b"]);
});
