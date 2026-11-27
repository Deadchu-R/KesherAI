import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolateRuns, textDir } from "./bidi.js";

describe("chat/bidi isolateRuns", () => {
  it("Hebrew line with English product name and version number", () => {
    const runs = isolateRuns("התקן את KesherAI גרסה 0.6.12 בבקשה");
    // Hebrew parts are not isolated; Latin+number run is isolated
    const isoRuns = runs.filter((r) => r.iso);
    assert.ok(isoRuns.length >= 1, "expected at least one isolated run");
    assert.ok(
      isoRuns.some((r) => /KesherAI/.test(r.text)),
      "product name should be in an isolated run",
    );
  });

  it("English line with a Hebrew word", () => {
    const runs = isolateRuns("Please install שלום now");
    const isoRuns = runs.filter((r) => r.iso);
    assert.ok(isoRuns.length >= 1, "expected at least one isolated RTL run");
    assert.ok(
      isoRuns.some((r) => /שלום/.test(r.text)),
      "Hebrew word should be isolated inside English",
    );
  });

  it("URL inside Hebrew stays in one piece", () => {
    const runs = isolateRuns("בקרו ב-https://example.com/path לקבלת מידע");
    // The URL and surrounding Latin/punctuation should be isolated as LTR
    const isoText = runs
      .filter((r) => r.iso)
      .map((r) => r.text)
      .join("");
    assert.ok(
      isoText.includes("https://example.com/path"),
      "URL should appear inside isolated run(s)",
    );
  });

  it("code span is never split or isolated", () => {
    const runs = isolateRuns("השתמש ב-`npm install` להתקנה");
    // Code span content should appear in a non-isolated run
    const codeRun = runs.find((r) => r.text.includes("`npm install`"));
    assert.ok(codeRun, "code span should be present");
    assert.equal(codeRun.iso, false, "code span must not be isolated");
  });

  it("inline math is never split or isolated", () => {
    const runs = isolateRuns("הנוסחה $x^2 + y^2$ היא פשוטה");
    const mathRun = runs.find((r) => r.text.includes("$x^2 + y^2$"));
    assert.ok(mathRun, "inline math should be present");
    assert.equal(mathRun.iso, false, "inline math must not be isolated");
  });

  it("empty string returns empty array", () => {
    assert.deepEqual(isolateRuns(""), []);
  });
});

describe("chat/bidi textDir", () => {
  it("Hebrew-first text returns rtl", () => {
    assert.equal(textDir("שלום world"), "rtl");
  });

  it("Latin-first text returns ltr", () => {
    assert.equal(textDir("Hello עולם"), "ltr");
  });

  it("numbers only returns auto", () => {
    assert.equal(textDir("123 456"), "auto");
  });

  it("ignores code spans when detecting direction", () => {
    assert.equal(textDir("`code` שלום"), "rtl");
  });
});