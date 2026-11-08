// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"
#include "Containers/Ticker.h"

class IWebSocket;
class FJsonObject;

/**
 * Connects the Unreal Editor to KesherAI running on this computer.
 *
 * The editor is the client: it connects to ws://127.0.0.1:<port>/api/unreal/ws
 * (port 7420, or the KESHER_PORT environment variable) and tries again every
 * few seconds while KesherAI is closed. Nothing listens inside Unreal, and
 * KesherAI accepts this connection only from the same computer.
 *
 * KesherAI sends commands ({ "id", "cmd", ... }) and the editor answers
 * ({ "id", "ok", "result" | "error" }). Commands: list, graph, apply,
 * compile, save. See FKesherGraph for what they do.
 */
class FKesherAIBridgeModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

private:
	/** Tries to connect when not connected; runs every few seconds. */
	bool Tick(float DeltaTime);
	void Connect();
	void OnMessage(const FString& Text);
	void Send(const TSharedRef<FJsonObject>& Message);
	/** Tells KesherAI a Blueprint changed (compiled), so it can refresh what it shows. */
	void OnBlueprintCompiled();

	TSharedPtr<IWebSocket> Socket;
	FTSTicker::FDelegateHandle TickHandle;
	FDelegateHandle CompiledHandle;
	double NextTry = 0;
	bool bConnecting = false;
};
