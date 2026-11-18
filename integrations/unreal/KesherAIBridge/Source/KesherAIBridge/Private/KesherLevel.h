// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * A level for KesherAI's stand-in (the 3D editor shows the scene without Unreal open: docs/RESEARCH_LOG.md "A game
 * scene edited in KesherAI without its engine"). Runs in the open editor, or in the KesherBridge commandlet when the
 * editor is closed.
 *
 * - Levels: every map under /Game.
 * - Read: a level's actors (name, label, class, parent, relative transform in Unreal's units, the static mesh shown).
 * - Mesh: one static mesh's triangles (its lowest LOD, at most 30 000 triangles), for the stand-in to show its shape.
 * - Move: actors moved in KesherAI, as one undo step; one that moved in Unreal meanwhile is left and named. With the
 *   editor closed, the level is saved; with it open, it is left changed for her to save.
 */
namespace KesherLevel
{
	TSharedRef<FJsonObject> Levels();
	TSharedRef<FJsonObject> Read(const FString& Path);
	TSharedRef<FJsonObject> Mesh(const FString& Path);
	TSharedRef<FJsonObject> Move(const FString& Path, const TArray<TSharedPtr<FJsonValue>>& Moves, bool bSave);
}
