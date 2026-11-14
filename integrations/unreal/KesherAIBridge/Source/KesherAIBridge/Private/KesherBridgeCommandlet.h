// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "KesherBridgeCommandlet.generated.h"

/**
 * KesherAI's commands with the Unreal Editor closed (asked for: "everything works offline"):
 * UnrealEditor-Cmd <project> -run=KesherBridge, with the request file in KESHER_BRIDGE_REQUEST and the answer
 * written to KESHER_BRIDGE_RESPONSE (environment variables, so paths with spaces need no quoting).
 * The request is one command ({ "cmd", "path", ... }) or several ({ "commands": [ ... ] }); changed Blueprints are
 * saved, since nothing stays open to save them later.
 */
UCLASS()
class UKesherBridgeCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UKesherBridgeCommandlet();
	virtual int32 Main(const FString& Params) override;
};
