import { test } from "node:test";
import assert from "node:assert/strict";
import { unrealCppProblems } from "./unreal-cpp-check.js";

test("Unreal C++ rules catch the mistakes models make", () => {
  const files = {
    "HealthComponent.h": `#pragma once
#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "UHealthComponent.generated.h"
DECLARE_DYNAMIC_DELEGATE(FDeathDelegate);
UCLASS()
class AUTOSHOOTER_API UHealthComponent : public UActorComponent
{
	GENERATED_BODY()
public:
	UPROPERTY(BlueprintAssignable)
	FDeathDelegate OnDeath;
};`,
    "HealthPickup.cpp": `#include "HealthPickup.h"
#include "UHealthComponent.h"
void AHealthPickup::Hit(AActor* A) { if (A && !A->IsPendingKill()) {} OnDeath.Broadcast(); }`,
    "HealthPickup.h": `#pragma once
#include "CoreMinimal.h"
#include "HealthPickup.generated.h"
UCLASS()
class AUTOSHOOTER_API HealthPickup : public AActor
{
	GENERATED_BODY()
};`,
  };
  const out = unrealCppProblems(files, new Set(["healthcomponent.h", "healthpickup.h"])).join("\n");
  assert.match(out, /HealthComponent\.h:4: error: #include "UHealthComponent\.generated\.h" must be "HealthComponent\.generated\.h"/);
  assert.match(out, /FDeathDelegate is used with BlueprintAssignable/);
  assert.match(out, /HealthPickup\.cpp:2: error: #include "UHealthComponent\.h" — no such file/);
  assert.match(out, /IsPendingKill\(\) was removed/);
  assert.match(out, /HealthPickup derives from AActor, so its name must start with A/);
  const good = unrealCppProblems({ "Door.h": `#pragma once\n#include "CoreMinimal.h"\n#include "GameFramework/Actor.h"\n#include "Door.generated.h"\nDECLARE_DYNAMIC_MULTICAST_DELEGATE(FOpened);\nUCLASS()\nclass GAME_API ADoor : public AActor\n{\n\tGENERATED_BODY()\npublic:\n\tUPROPERTY(BlueprintAssignable)\n\tFOpened OnOpened;\n};` }, new Set(["door.h"]));
  assert.deepEqual(good, []);
});
