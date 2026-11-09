import { test } from "node:test";
import assert from "node:assert/strict";
import { lintUnrealSource, shortErrors } from "./unreal-lint.js";

test("the usual compile-breakers are seen when a file is written", () => {
  const bad = `#pragma once
#include "Enemy.generated.h"
#include "CoreMinimal.h"
#include "Blueprint/UserWidget.h"
UCLASS()
class GAME_API Enemy : public AActor
{
public:
  int32 Health = 3;
};
USTRUCT()
struct Stats { GENERATED_BODY() };
static int Error(int x) { return x; }
`;
  const issues = lintUnrealSource("Source/Game/Enemy.h", bad, `PublicDependencyModuleNames.AddRange(new string[] { "Core", "Engine" });`);
  const text = issues.join("\n");
  assert.match(text, /must be the LAST #include/);
  assert.match(text, /needs GENERATED_BODY/);
  assert.match(text, /Enemy derives from AActor.*start with "A"/);
  assert.match(text, /USTRUCT Stats must start with "F"/);
  assert.match(text, /Error\(\) clashes/);
  assert.match(text, /UMG module/);
  const good = `#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Enemy.generated.h"
UCLASS()
class GAME_API AEnemy : public AActor
{
  GENERATED_BODY()
};
`;
  assert.deepEqual(lintUnrealSource("Source/Game/Enemy.h", good, `"Core", "Engine"`), []);
});

test("compile errors: each once, short paths", () => {
  const log = ["C:\\P\\Source\\Game\\A.h(3): error C2061: syntax error: identifier 'X'", "C:\\P\\Source\\Game\\A.h(3): error C2061: syntax error: identifier 'X'", "C:\\P\\Source\\Game\\B.cpp(9): error C3861: 'Foo': identifier not found", "Result: Failed (OtherCompilationError)"].join("\n");
  const r = shortErrors(log);
  assert.deepEqual(r.lines, ["Source/Game\\A.h(3): error C2061: syntax error: identifier 'X'", "Source/Game\\B.cpp(9): error C3861: 'Foo': identifier not found"]);
});
