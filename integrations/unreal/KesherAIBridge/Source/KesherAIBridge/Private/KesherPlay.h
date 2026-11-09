// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * The "Test" button: runs the game in the editor (Play In Editor) for a few
 * seconds and reports what happened, so KesherAI (or its model) can say
 * whether a Blueprint does what it should.
 *
 * - Start: compiles the Blueprint, starts Play In Editor, and (for an Actor
 *   Blueprint) places one in front of the player once the game runs. The log
 *   is collected from then on (Print String, Blueprint errors, warnings).
 * - Stop: takes a picture of the game view, ends Play In Editor, and returns
 *   the log lines and the picture's file.
 *
 * Nothing in the level is changed: the test actor lives only in the play world.
 */
namespace KesherPlay
{
	/** Starts a test run of the Blueprint at Path (Path may be empty: just play the level). */
	TSharedRef<FJsonObject> Start(const FString& Path, bool bPlace);

	/** Whether a test is running, and the log so far. */
	TSharedRef<FJsonObject> Status();

	/** Ends the test run: a picture of the game view, the log, then Play In Editor stops. */
	TSharedRef<FJsonObject> Stop();

	/** Lets go of the log hook (module shutdown). */
	void Shutdown();
}
