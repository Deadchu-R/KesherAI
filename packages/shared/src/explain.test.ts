import { test } from "node:test";
import assert from "node:assert/strict";
import { explainCommand } from "./explain.js";

test("explains each part of a command line", () => {
  const parts = explainCommand("pip install pyinstaller && pyinstaller --onefile calc.py");
  assert.equal(parts.length, 2);
  assert.match(parts[0]!.en, /Python packages: pyinstaller/);
  assert.match(parts[1]!.he, /exe/);
});

test("names the winget package and marks deletes as risky", () => {
  assert.match(explainCommand("winget install -e --id Python.Python.3.12 --silent")[0]!.en, /Python\.Python\.3\.12/);
  assert.match(explainCommand("winget install Git.Git")[0]!.en, /Git\.Git/);
  assert.equal(explainCommand("del /q build\\*")[0]!.risky, true);
  assert.equal(explainCommand("python main.py")[0]!.en, "Runs the Python script main.py");
  assert.equal(explainCommand("frobnicate --x")[0]!.en, "Runs frobnicate");
});
