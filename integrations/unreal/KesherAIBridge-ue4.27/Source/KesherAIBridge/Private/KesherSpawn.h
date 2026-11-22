// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * The engine specialists' Unreal commands (packages/core/src/engine-build-tools.ts). Run in the open editor, or in the
 * KesherBridge commandlet when the editor is closed (then the level or asset is saved, as KesherLevel does).
 *
 * - Spawn (`level_spawn`, the Level design specialist's block-out): actors placed in a level as one undo step. Each
 *   actor is a static mesh actor with a mesh (`mesh`, e.g. /Engine/BasicShapes/Cube.Cube), a Blueprint or static mesh
 *   by path (`asset`), or a class by path (`class`: lights, NavMeshBoundsVolume); location (cm), rotation (pitch, yaw,
 *   roll) and scale; lights also take `intensity` and `color`. All go into the outliner folder `folder`. Only paths
 *   under /Game, /Engine or /Script are loaded.
 * - CreateVfx (`vfx_create`, the VFX specialist): a Niagara system copied from a template (an asset path, or a
 *   template's name found under /Niagara in the asset registry) to `path` (/Game/KesherVFX/NS_…), and, with `level`,
 *   placed there as a NiagaraActor at `location`. Generic engine calls only (AssetTools and reflection), so the module
 *   needs no Niagara dependency; tuning the numbers is left to Unreal's MCP Niagara toolset or the Niagara editor.
 */
namespace KesherSpawn
{
	TSharedRef<FJsonObject> Spawn(const FString& Level, const TArray<TSharedPtr<FJsonValue>>& Actors, bool bSave);
	TSharedRef<FJsonObject> CreateVfx(const TSharedPtr<FJsonObject>& In, bool bSave);
}
