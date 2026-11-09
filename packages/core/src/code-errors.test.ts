import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCodeAnswer, codeEditPrompt, codeFromAnswer, parseCodeErrors } from "./code-errors.js";

test("compiler errors from Unity (plain and inside JSON) and from MSVC, each once, relative paths", () => {
  const unity = 'Assets/Scripts/Player.cs(12,5): error CS1002: ; expected\nAssets/Scripts/Player.cs(12,5): error CS1002: ; expected\n{"messages":["Assets/Enemy.cs(3,10): warning CS0414: The field \'Enemy.x\' is assigned but its value is never used"]}';
  const u = parseCodeErrors(unity);
  assert.deepEqual(u.map((e) => [e.file, e.line, e.column, e.code, e.severity]), [["Assets/Scripts/Player.cs", 12, 5, "CS1002", "error"], ["Assets/Enemy.cs", 3, 10, "CS0414", "warning"]]);
  const msvc = "C:\\Users\\r\\Unreal Projects\\AutoShooter\\Source\\AutoShooter\\Gun.cpp(41): error C2065: 'Ammo': undeclared identifier\n  D:\\x\\Gun.h(9,3): fatal error C1083: Cannot open include file";
  const m = parseCodeErrors(msvc, "C:\\Users\\r\\Unreal Projects\\AutoShooter");
  assert.equal(m[0]!.file, "Source/AutoShooter/Gun.cpp");
  assert.equal(m[0]!.line, 41);
  assert.equal(m[0]!.code, "C2065");
  assert.equal(m[1]!.code, "C1083");
});

test("the model's answer: the code block only; the prompt carries the file, the errors and the request", () => {
  assert.equal(codeFromAnswer("<think>x</think>Here:\n```csharp\nclass A {}\n```\nAdded A."), "class A {}\n");
  assert.equal(codeFromAnswer("class B {}"), "class B {}\n");
  const p = codeEditPrompt({ language: "csharp", engine: "unity", path: "Assets/A.cs", text: "class A {}", request: "add jump", errors: [{ file: "Assets/A.cs", line: 1, column: 1, code: "CS1002", message: "; expected", severity: "error" }] });
  assert.match(p, /Unity C# script/);
  assert.match(p, /CS1002/);
  assert.match(p, /The request: add jump/);
});

test("change blocks: exact, re-indented, added at the end, and a block that does not match", () => {
  const file = "class A {\n    int score;\n    void Spawn() {\n        x = 1;\n    }\n}\n";
  const answer = "<<<<<<< SEARCH\n    int score;\n=======\n    int score;\n    public int highScore;\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nx = 1;\n=======\nx = 1;\nif (score > highScore) highScore = score;\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nnot there\n=======\nzzz\n>>>>>>> REPLACE\nAdded highScore.";
  const r = applyCodeAnswer(file, answer);
  assert.equal(r.blocks, 3);
  assert.equal(r.missed, 1);
  assert.match(r.code, / {4}int score;\n {4}public int highScore;/);
  assert.match(r.code, / {8}x = 1;\n {8}if \(score > highScore\) highScore = score;/);
  assert.equal(applyCodeAnswer("a\n", "```\nb\n```").code, "b\n");
  assert.match(codeEditPrompt({ language: "csharp", engine: "unity", path: "A.cs", text: "x".repeat(5000), request: "r" }), /SEARCH/);
});
