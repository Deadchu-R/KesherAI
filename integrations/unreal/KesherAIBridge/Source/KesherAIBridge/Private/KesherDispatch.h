// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Runs one KesherAI command ({ "cmd", "path", ... }): from the open editor (the WebSocket) or, with the editor
 * closed, from the KesherBridge commandlet. Commands: list, graph, apply, vars, compile, save, actions, widget,
 * create, import_texture, widget_apply; with the open editor also open, undo, redo, live_coding, play, play_status,
 * play_stop, quit_for_update, ping.
 */
namespace KesherDispatch
{
	/** The command's result, or null for an unknown command. */
	TSharedPtr<FJsonObject> Run(const TSharedPtr<FJsonObject>& In, bool bOffline);
	/** The answer KesherAI reads: { ok, result } or { ok: false, error }. */
	TSharedRef<FJsonObject> Answer(const TSharedPtr<FJsonObject>& In, bool bOffline);
}
