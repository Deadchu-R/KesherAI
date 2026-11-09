// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Widget Blueprints (UMG) for KesherAI's Designer view, as JSON in and out.
 *
 * - Read: the widget tree (each widget's name, class, a few readable
 *   properties, its slot in the parent: canvas position/size/anchors or box
 *   padding/alignment) so the page can draw the layout.
 * - Apply: add, remove, move a widget, or set a property of a widget or of
 *   its slot, as one undo step (Ctrl+Z in the editor).
 *
 * Widgets are named by their name in the tree (unique within a Widget Blueprint).
 */
namespace KesherWidget
{
	/** The widget tree of a Widget Blueprint; an "error" field when it is not one. */
	TSharedRef<FJsonObject> Read(const FString& Path);

	/** Applies operations to a Widget Blueprint's tree, as one undo step. */
	TSharedRef<FJsonObject> Apply(const FString& Path, const TArray<TSharedPtr<FJsonValue>>& Ops);
}
