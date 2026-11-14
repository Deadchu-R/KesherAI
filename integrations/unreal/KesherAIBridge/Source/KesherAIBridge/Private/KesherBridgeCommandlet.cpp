// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherBridgeCommandlet.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformMisc.h"
#include "KesherDispatch.h"
#include "KesherGraph.h"
#include "Misc/FileHelper.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogKesherBridgeCommandlet, Log, All);

UKesherBridgeCommandlet::UKesherBridgeCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UKesherBridgeCommandlet::Main(const FString& Params)
{
	const FString RequestFile = FPlatformMisc::GetEnvironmentVariable(TEXT("KESHER_BRIDGE_REQUEST"));
	const FString ResponseFile = FPlatformMisc::GetEnvironmentVariable(TEXT("KESHER_BRIDGE_RESPONSE"));
	FString Text;
	if (RequestFile.IsEmpty() || ResponseFile.IsEmpty() || !FFileHelper::LoadFileToString(Text, *RequestFile))
	{
		UE_LOG(LogKesherBridgeCommandlet, Error, TEXT("KesherBridge: no request (KESHER_BRIDGE_REQUEST / KESHER_BRIDGE_RESPONSE)."));
		return 1;
	}
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		UE_LOG(LogKesherBridgeCommandlet, Error, TEXT("KesherBridge: the request is not JSON."));
		return 1;
	}

	TArray<TSharedPtr<FJsonObject>> Commands;
	const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
	if (Request->TryGetArrayField(TEXT("commands"), List))
	{
		for (const TSharedPtr<FJsonValue>& V : *List)
		{
			if (V.IsValid() && V->Type == EJson::Object) Commands.Add(V->AsObject());
		}
	}
	else Commands.Add(Request);

	TArray<TSharedPtr<FJsonValue>> Answers;
	for (const TSharedPtr<FJsonObject>& In : Commands)
	{
		TSharedRef<FJsonObject> Out = KesherDispatch::Answer(In, true);
		FString Cmd, Path;
		In->TryGetStringField(TEXT("cmd"), Cmd);
		In->TryGetStringField(TEXT("path"), Path);
		bool bOk = false;
		Out->TryGetBoolField(TEXT("ok"), bOk);
		// Nothing stays open to save it later: a changed asset is saved now.
		if (bOk && !Path.IsEmpty() && (Cmd == TEXT("apply") || Cmd == TEXT("vars") || Cmd == TEXT("widget_apply") || Cmd == TEXT("create") || Cmd == TEXT("compile")))
		{
			KesherGraph::Save(Path);
		}
		Answers.Add(MakeShared<FJsonValueObject>(Out));
	}

	TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
	if (List) Response->SetArrayField(TEXT("answers"), Answers);
	else if (Answers.Num() > 0) Response = Answers[0]->AsObject().ToSharedRef();
	FString Json;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
	FJsonSerializer::Serialize(Response, Writer);
	if (!FFileHelper::SaveStringToFile(Json, *ResponseFile, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
	{
		UE_LOG(LogKesherBridgeCommandlet, Error, TEXT("KesherBridge: could not write the answer."));
		return 1;
	}
	return 0;
}
