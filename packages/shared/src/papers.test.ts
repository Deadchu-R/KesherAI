import { test } from "node:test";
import assert from "node:assert/strict";
import { chicagoCite, chicagoRef, parseBibtex, parseRis, toBibtex, toRis, type StudySource } from "./papers.js";

const paper: StudySource = { id: "a", title: "Heart rate and exercise", authors: ["Dana Levi", "Ori Cohen"], year: 2020, venue: "Journal of Physiology", volume: "12", issue: "3", pages: "45–67", doi: "10.1000/xyz123", t: 1 };

test("BibTeX from Zotero comes in as sources, and ours goes out and back", () => {
  const zotero = `@article{levi_heart_2020,
\ttitle = {Heart rate and {Exercise}: a {Re{\\"v}iew}},
\tvolume = {12},
\tdoi = {10.1000/abc},
\tjournal = {Journal of Physiology},
\tauthor = {Levi, Dana and Cohen, Ori},
\tyear = {2020},
\tpages = {45--67},
}

@book{x,
  title = "A Book",
  author = {Avi Ben},
  publisher = {Magnes},
  year = 2019
}
`;
  const s = parseBibtex(zotero);
  assert.equal(s.length, 2);
  assert.equal(s[0]!.title, "Heart rate and Exercise: a Review");
  assert.deepEqual(s[0]!.authors, ["Dana Levi", "Ori Cohen"]);
  assert.equal(s[0]!.pages, "45–67");
  assert.equal(s[0]!.doi, "10.1000/abc");
  assert.equal(s[1]!.venue, "Magnes");
  assert.equal(s[1]!.year, 2019);
  const back = parseBibtex(toBibtex([paper]))[0]!;
  assert.equal(back.title, paper.title);
  assert.deepEqual(back.authors, paper.authors);
});

test("RIS comes in as sources, and ours goes out and back", () => {
  const back = parseRis(toRis([paper]));
  assert.equal(back.length, 1);
  assert.equal(back[0]!.title, paper.title);
  assert.equal(back[0]!.venue, "Journal of Physiology");
  assert.equal(back[0]!.pages, "45–67");
  assert.equal(back[0]!.year, 2020);
  assert.equal(parseRis("nothing here").length, 0);
});

test("Chicago author-date reference and citation", () => {
  assert.equal(chicagoRef(paper), "Levi, Dana, and Ori Cohen. 2020. “Heart rate and exercise.” Journal of Physiology 12 (3): 45–67. https://doi.org/10.1000/xyz123.");
  assert.equal(chicagoCite(paper), "(Levi and Cohen 2020)");
  assert.equal(chicagoCite({ ...paper, authors: ["A B", "C D", "E F", "G H"] }), "(B et al. 2020)");
});
