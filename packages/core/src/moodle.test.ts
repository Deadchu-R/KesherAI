import { test } from "node:test";
import assert from "node:assert/strict";
import { moodleBase, parseCourseFiles, parseCourses, parseDue } from "./moodle.js";

test("a Moodle address is kept as its base", () => {
  assert.equal(moodleBase("moodle.tau.ac.il/2026/my/"), "https://moodle.tau.ac.il/2026");
  assert.equal(moodleBase("https://moodle.huji.ac.il/course/view.php?id=4"), "https://moodle.huji.ac.il");
  assert.equal(moodleBase("http://x.example"), undefined);
});

test("courses and what is due, from Moodle's own answers", () => {
  assert.deepEqual(parseCourses({ data: { courses: [{ id: 12, fullname: "פרמקולוגיה <b>קלינית</b>", viewurl: "https://m/course/view.php?id=12" }, { id: "x" }] } }), [{ id: "12", name: "פרמקולוגיה קלינית", url: "https://m/course/view.php?id=12" }]);
  const due = parseDue({ data: { events: [{ id: 2, activityname: "עבודה", timesort: 2000, course: { fullname: "סטט" } }, { id: 1, name: "תרגיל 4 is due", timesort: 1000, course: { fullname: "פרמ" } }] } });
  assert.deepEqual(due.map((d) => d.id), ["1", "2"]);
  assert.equal(due[0]!.due, 1_000_000);
});

test("a course page's files, each once, only from this Moodle", () => {
  const base = "https://moodle.u.ac.il";
  const html = `<a class="aalink" href="${base}/mod/resource/view.php?id=55"><span class="instancename">הרצאה 3 &amp; 4<span class="accesshide"> File</span></span></a>
<a href="${base}/mod/resource/view.php?id=55">again</a>
<a href="${base}/pluginfile.php/9/mod_folder/content/0/slides%201.pdf?forcedownload=1">s</a>
<a href="https://evil.example/pluginfile.php/1/x.pdf">no</a>`;
  const files = parseCourseFiles(html, base);
  assert.deepEqual(files.map((f) => [f.id, f.name]), [["r55", "הרצאה 3 & 4"], ["p9/mod_folder/content/0/slides%201.pdf", "slides 1.pdf"]]);
});
