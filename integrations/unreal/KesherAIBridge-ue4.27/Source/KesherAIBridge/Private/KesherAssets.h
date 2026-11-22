// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Assets for KesherAI's editors ("Open from project", 0.1.33): an asset exported to a file KesherAI can open with
 * Unreal closed, and an edited file imported back over it. Runs in the open editor, or in the KesherBridge commandlet
 * when the editor is closed. Files are read and written only under the project's Saved/KesherAI/ folder.
 *
 * - Export: a static or skeletal mesh as FBX, a 2D texture as PNG, a sound wave as WAV (Unreal's own exporters).
 * - Import: a file imported over an asset (or as a new one next to it), replacing it and saving the package. A mesh
 *   keeps its kind (static or skeletal) and its materials (FBX: no materials or textures are imported).
 */
namespace KesherAssets
{
	TSharedRef<FJsonObject> Export(const FString& Path, const FString& File);
	TSharedRef<FJsonObject> Import(const FString& Path, const FString& File, const FString& Name);
}
