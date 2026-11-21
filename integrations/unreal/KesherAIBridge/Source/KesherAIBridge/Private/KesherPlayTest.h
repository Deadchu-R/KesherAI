// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Gameplay tests (plugin 0.1.25): KesherAI sends a short plan of steps and the plugin runs it in Play In Editor, one
 * step after another on the engine's ticker, so each step's result can be read while the game runs.
 *
 * Steps (checked again by KesherAI's play-test.ts before they come here):
 * - spawn { class, offset?, possess? }: an actor in front of the player (play world only), possessed if it is a pawn.
 * - possess { actor }: the player controller possesses that pawn.
 * - input { action, value?, frames? }: an Enhanced Input action injected every frame (bool, axis, 2D or 3D value).
 * - key { key, frames? } / axis { key, value, frames? }: a key held (pressed, then released) or an axis fed each frame.
 * - wait { seconds } or { until: condition, timeout }: waits, or until the condition holds (fails at the timeout).
 * - assert { actor, property, op, value, tolerance? }: checks a value now.
 * - screenshot { name? }: a PNG of the game view in Saved/KesherAI/play-test (none with -NullRHI).
 *
 * Safety: nothing outside the play world changes. A map in the plan is only the map played (GlobalMapOverride); the
 * editor's open level stays as it is. The only file written is the picture under Saved/KesherAI/play-test.
 *
 * The same runner is the automation test "KesherAI.PlayTest.<name>" (one per Content/KesherTests/<name>.json, and
 * "Request" for a plan file named by KESHER_PLAYTEST_REQUEST), so Session Frontend, CI, and KesherAI with Unreal
 * closed (UnrealEditor-Cmd -ExecCmds="Automation RunTests KesherAI.PlayTest.Request") run it too.
 */
namespace KesherPlayTest
{
	/** Starts a gameplay test from its plan (play starts on the next editor frame). */
	TSharedRef<FJsonObject> Start(const TSharedPtr<FJsonObject>& Plan);

	/** The steps finished so far, whether it is done, and the log. */
	TSharedRef<FJsonObject> Status();

	/** Ends the test (and play): the last state, with the pictures' files. Safe to call any time. */
	TSharedRef<FJsonObject> Stop();

	/** Whether the test has finished (every step ran, one failed, or play ended). */
	bool IsDone();

	/** Lets go of the ticker and the log hook (module shutdown). */
	void Shutdown();
}
