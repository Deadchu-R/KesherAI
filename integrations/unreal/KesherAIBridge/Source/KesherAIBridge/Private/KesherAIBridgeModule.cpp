// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherAIBridgeModule.h"

#include "Editor.h"
#include "IWebSocket.h"
#include "KesherGraph.h"
#include "Misc/App.h"
#include "Misc/EngineVersion.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogKesherAI, Log, All);

/** The plugin's version, sent to KesherAI so it can say when a newer one is out. */
static const TCHAR* BridgeVersion = TEXT("0.1.3");

void FKesherAIBridgeModule::StartupModule()
{
	FModuleManager::LoadModuleChecked<FWebSocketsModule>("WebSockets");
	TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FKesherAIBridgeModule::Tick), 1.0f);
	if (GEditor) CompiledHandle = GEditor->OnBlueprintCompiled().AddRaw(this, &FKesherAIBridgeModule::OnBlueprintCompiled);
}

void FKesherAIBridgeModule::ShutdownModule()
{
	FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
	if (GEditor) GEditor->OnBlueprintCompiled().Remove(CompiledHandle);
	if (Socket.IsValid())
	{
		Socket->OnClosed().Clear();
		Socket->Close();
		Socket.Reset();
	}
}

bool FKesherAIBridgeModule::Tick(float)
{
	const bool bConnected = Socket.IsValid() && Socket->IsConnected();
	if (!bConnected && !bConnecting && FPlatformTime::Seconds() >= NextTry) Connect();
	return true;
}

void FKesherAIBridgeModule::Connect()
{
	FString Port = FPlatformMisc::GetEnvironmentVariable(TEXT("KESHER_PORT"));
	if (Port.IsEmpty()) Port = TEXT("7420");
	const FString Url = FString::Printf(TEXT("ws://127.0.0.1:%s/api/unreal/ws"), *Port);
	bConnecting = true;
	Socket = FWebSocketsModule::Get().CreateWebSocket(Url, TEXT(""));
	Socket->OnConnected().AddLambda([this]()
	{
		bConnecting = false;
		UE_LOG(LogKesherAI, Log, TEXT("Connected to KesherAI."));
		TSharedRef<FJsonObject> Hello = MakeShared<FJsonObject>();
		Hello->SetStringField(TEXT("event"), TEXT("hello"));
		Hello->SetStringField(TEXT("project"), FApp::GetProjectName());
		Hello->SetStringField(TEXT("engine"), FEngineVersion::Current().ToString(EVersionComponent::Patch));
		Hello->SetStringField(TEXT("bridge"), BridgeVersion);
		// Where the project is, so KesherAI's chat works on the project open in this editor.
		Hello->SetStringField(TEXT("projectFile"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
		Send(Hello);
	});
	Socket->OnConnectionError().AddLambda([this](const FString&)
	{
		// KesherAI is not running: try again in a few seconds, quietly.
		bConnecting = false;
		NextTry = FPlatformTime::Seconds() + 5.0;
	});
	Socket->OnClosed().AddLambda([this](int32, const FString&, bool)
	{
		bConnecting = false;
		NextTry = FPlatformTime::Seconds() + 3.0;
	});
	Socket->OnMessage().AddRaw(this, &FKesherAIBridgeModule::OnMessage);
	Socket->Connect();
}

void FKesherAIBridgeModule::Send(const TSharedRef<FJsonObject>& Message)
{
	if (!Socket.IsValid() || !Socket->IsConnected()) return;
	FString Text;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text);
	FJsonSerializer::Serialize(Message, Writer);
	Socket->Send(Text);
}

void FKesherAIBridgeModule::OnBlueprintCompiled()
{
	TSharedRef<FJsonObject> Event = MakeShared<FJsonObject>();
	Event->SetStringField(TEXT("event"), TEXT("changed"));
	Send(Event);
}

void FKesherAIBridgeModule::OnMessage(const FString& Text)
{
	TSharedPtr<FJsonObject> In;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, In) || !In.IsValid()) return;

	FString Id, Cmd, Path, Graph;
	In->TryGetStringField(TEXT("id"), Id);
	In->TryGetStringField(TEXT("cmd"), Cmd);
	In->TryGetStringField(TEXT("path"), Path);
	In->TryGetStringField(TEXT("graph"), Graph);

	TSharedPtr<FJsonObject> Result;
	if (Cmd == TEXT("list")) Result = KesherGraph::List();
	else if (Cmd == TEXT("graph")) Result = KesherGraph::Read(Path);
	else if (Cmd == TEXT("apply"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Ops = nullptr;
		if (In->TryGetArrayField(TEXT("ops"), Ops)) Result = KesherGraph::Apply(Path, Graph, *Ops);
	}
	else if (Cmd == TEXT("compile")) Result = KesherGraph::Compile(Path);
	else if (Cmd == TEXT("save")) Result = KesherGraph::Save(Path);
	else if (Cmd == TEXT("open")) Result = KesherGraph::Open(Path);
	else if (Cmd == TEXT("ping"))
	{
		Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), true);
	}

	TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("id"), Id);
	FString Problem;
	if (!Result.IsValid()) Problem = TEXT("Unknown command: ") + Cmd;
	else if (Result->TryGetStringField(TEXT("error"), Problem)) {}
	Out->SetBoolField(TEXT("ok"), Problem.IsEmpty());
	if (Problem.IsEmpty()) Out->SetObjectField(TEXT("result"), Result);
	else Out->SetStringField(TEXT("error"), Problem);
	Send(Out);
}

IMPLEMENT_MODULE(FKesherAIBridgeModule, KesherAIBridge)
