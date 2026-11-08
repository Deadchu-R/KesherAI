// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * What KesherAI can do with Blueprints, as JSON in and JSON out.
 *
 * - List: every Blueprint under /Game.
 * - Read: a Blueprint's graphs (event graph, functions, macros) with every
 *   node, pin, default value and link, plus its variables.
 * - Apply: a list of operations (add a node, connect two pins, set a pin's
 *   default, move or delete a node) in one undo step (Ctrl+Z in the editor).
 * - Compile and save.
 *
 * Nodes are named by their GUID; a node added in the same Apply is named by
 * the "ref" given to it ("$1", "$print"…).
 */
namespace KesherGraph
{
	/** Every Blueprint asset under /Game. */
	TSharedRef<FJsonObject> List();

	/** One Blueprint's graphs; an "error" field when it cannot be loaded. */
	TSharedRef<FJsonObject> Read(const FString& Path);

	/** Applies operations to one graph of a Blueprint, as one undo step. */
	TSharedRef<FJsonObject> Apply(const FString& Path, const FString& GraphName, const TArray<TSharedPtr<FJsonValue>>& Ops);

	/** Compiles a Blueprint and returns the compiler's messages. */
	TSharedRef<FJsonObject> Compile(const FString& Path);

	/** Saves a Blueprint's package to disk. */
	TSharedRef<FJsonObject> Save(const FString& Path);

	/** Opens a Blueprint in its editor. */
	TSharedRef<FJsonObject> Open(const FString& Path);
}
