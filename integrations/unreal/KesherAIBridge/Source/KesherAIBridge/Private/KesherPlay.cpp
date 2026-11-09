// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherPlay.h"

#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/Blueprint.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "GameFramework/PlayerController.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Misc/FileHelper.h"
#include "Misc/OutputDevice.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "UnrealClient.h"

namespace
{
	TSharedRef<FJsonObject> PlayError(const FString& Message)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Message);
		return Out;
	}

	/** Collects the lines that tell what a Blueprint did while the game ran. */
	class FTestLog : public FOutputDevice
	{
	public:
		virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& Category) override
		{
			const ELogVerbosity::Type Level = (ELogVerbosity::Type)(Verbosity & ELogVerbosity::VerbosityMask);
			const FString Cat = Category.ToString();
			// Print String, Blueprint runtime errors (Accessed None…), and any warning or error.
			const bool bWanted = Cat == TEXT("LogBlueprintUserMessages") || Cat == TEXT("LogScript") || Cat == TEXT("LogBlueprint") || Level <= ELogVerbosity::Warning;
			if (!bWanted) return;
			FScopeLock Lock(&Guard);
			if (Lines.Num() >= 400) { bDropped = true; return; }
			const TCHAR* Kind = Level <= ELogVerbosity::Error ? TEXT("error") : Level == ELogVerbosity::Warning ? TEXT("warning") : TEXT("log");
			Lines.Add(FString::Printf(TEXT("%s|%s|%s"), Kind, *Cat, V).Left(600));
		}
		virtual bool CanBeUsedOnAnyThread() const override { return true; }

		TArray<FString> Take(bool& bOutDropped)
		{
			FScopeLock Lock(&Guard);
			bOutDropped = bDropped;
			return Lines;
		}
		void Reset()
		{
			FScopeLock Lock(&Guard);
			Lines.Reset();
			bDropped = false;
		}

	private:
		FCriticalSection Guard;
		TArray<FString> Lines;
		bool bDropped = false;
	};

	FTestLog* Log = nullptr;
	bool bRunning = false;
	double StartedAt = 0;
	FString TestPath;
	bool bPlaceActor = false;
	FString Placed;
	FDelegateHandle StartedHandle;
	FDelegateHandle EndedHandle;

	void Unhook()
	{
		if (Log && GLog) GLog->RemoveOutputDevice(Log);
		FEditorDelegates::PostPIEStarted.Remove(StartedHandle);
		FEditorDelegates::EndPIE.Remove(EndedHandle);
	}

	UWorld* PlayWorld()
	{
		return GEditor ? GEditor->PlayWorld : nullptr;
	}

	/** The game view while playing (the viewport the player sees). */
	FViewport* PlayViewport()
	{
		if (!GEngine) return nullptr;
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if (Context.WorldType == EWorldType::PIE && Context.GameViewport && Context.GameViewport->Viewport) return Context.GameViewport->Viewport;
		}
		return nullptr;
	}

	/** Puts one of the tested Actor Blueprint in front of the player (only in the play world). */
	void PlaceActor()
	{
		Placed.Reset();
		if (!bPlaceActor || TestPath.IsEmpty()) return;
		UWorld* World = PlayWorld();
		UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *TestPath);
		if (!World || !BP || !BP->GeneratedClass || !BP->GeneratedClass->IsChildOf(AActor::StaticClass())) return;
		FVector Where = FVector::ZeroVector;
		FRotator Facing = FRotator::ZeroRotator;
		if (APlayerController* PC = World->GetFirstPlayerController())
		{
			PC->GetPlayerViewPoint(Where, Facing);
			Where += Facing.Vector() * 400.0;
		}
		FActorSpawnParameters Params;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButAlwaysSpawn;
		AActor* Actor = World->SpawnActor<AActor>(BP->GeneratedClass, Where, FRotator(0, Facing.Yaw + 180.0, 0), Params);
		if (Actor) Placed = Actor->GetName();
	}

	TArray<TSharedPtr<FJsonValue>> LogJson(bool& bDropped)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		if (!Log) return Out;
		for (const FString& Line : Log->Take(bDropped))
		{
			FString Kind, Rest, Cat, Text;
			Line.Split(TEXT("|"), &Kind, &Rest);
			Rest.Split(TEXT("|"), &Cat, &Text);
			TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
			J->SetStringField(TEXT("kind"), Kind);
			J->SetStringField(TEXT("category"), Cat);
			J->SetStringField(TEXT("text"), Text);
			Out.Add(MakeShared<FJsonValueObject>(J));
		}
		return Out;
	}

	/** Saves a PNG of the game view; empty when there is no view to read. */
	FString Picture()
	{
		FViewport* Viewport = PlayViewport();
		if (!Viewport) return FString();
		const FIntPoint Size = Viewport->GetSizeXY();
		if (Size.X <= 0 || Size.Y <= 0) return FString();
		TArray<FColor> Pixels;
		if (!Viewport->ReadPixels(Pixels) || Pixels.Num() != Size.X * Size.Y) return FString();
		for (FColor& C : Pixels) C.A = 255;
		const FString Dir = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("KesherAI"));
		IFileManager::Get().MakeDirectory(*Dir, true);
		const FString File = Dir / TEXT("test-run.png");
		TArray64<uint8> Png;
		FImageUtils::PNGCompressImageArray(Size.X, Size.Y, TArrayView64<const FColor>(Pixels.GetData(), Pixels.Num()), Png);
		if (Png.Num() == 0 || !FFileHelper::SaveArrayToFile(TArrayView64<const uint8>(Png.GetData(), Png.Num()), *File)) return FString();
		return File;
	}
}

namespace KesherPlay
{
	TSharedRef<FJsonObject> Start(const FString& Path, bool bPlace)
	{
		if (!GEditor) return PlayError(TEXT("No editor."));
		if (GEditor->IsPlaySessionInProgress() || GEditor->PlayWorld) return PlayError(TEXT("The game is already playing in the editor. Stop it first (Esc), then test again."));

		TArray<TSharedPtr<FJsonValue>> Compile;
		bool bCompiled = true;
		if (!Path.IsEmpty())
		{
			UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *Path);
			if (!BP) return PlayError(TEXT("No Blueprint at ") + Path);
			FCompilerResultsLog Results;
			FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &Results);
			for (const TSharedRef<FTokenizedMessage>& M : Results.Messages)
			{
				if (M->GetSeverity() == EMessageSeverity::Info) continue;
				Compile.Add(MakeShared<FJsonValueString>(M->ToText().ToString()));
			}
			bCompiled = BP->Status != BS_Error;
		}
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("compile"), Compile);
		if (!bCompiled)
		{
			Out->SetBoolField(TEXT("started"), false);
			Out->SetStringField(TEXT("reason"), TEXT("The Blueprint has compile errors, so it was not run."));
			return Out;
		}

		if (!Log) Log = new FTestLog();
		Log->Reset();
		Unhook();
		GLog->AddOutputDevice(Log);
		TestPath = Path;
		bPlaceActor = bPlace;
		Placed.Reset();
		StartedHandle = FEditorDelegates::PostPIEStarted.AddLambda([](const bool) { PlaceActor(); });
		EndedHandle = FEditorDelegates::EndPIE.AddLambda([](const bool) { bRunning = false; });

		FRequestPlaySessionParams Params;
		Params.WorldType = EPlaySessionWorldType::PlayInEditor;
		GEditor->RequestPlaySession(Params);
		bRunning = true;
		StartedAt = FPlatformTime::Seconds();
		Out->SetBoolField(TEXT("started"), true);
		return Out;
	}

	TSharedRef<FJsonObject> Status()
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		bool bDropped = false;
		Out->SetBoolField(TEXT("playing"), GEditor && GEditor->PlayWorld != nullptr);
		Out->SetBoolField(TEXT("running"), bRunning);
		Out->SetNumberField(TEXT("seconds"), bRunning ? FPlatformTime::Seconds() - StartedAt : 0);
		Out->SetStringField(TEXT("placed"), Placed);
		Out->SetArrayField(TEXT("log"), LogJson(bDropped));
		return Out;
	}

	TSharedRef<FJsonObject> Stop()
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		const bool bPlaying = GEditor && GEditor->PlayWorld != nullptr;
		Out->SetBoolField(TEXT("played"), bPlaying);
		Out->SetStringField(TEXT("placed"), Placed);
		Out->SetStringField(TEXT("picture"), bPlaying ? Picture() : FString());
		bool bDropped = false;
		Out->SetArrayField(TEXT("log"), LogJson(bDropped));
		Out->SetBoolField(TEXT("logCut"), bDropped);
		Out->SetNumberField(TEXT("seconds"), bRunning ? FPlatformTime::Seconds() - StartedAt : 0);
		Unhook();
		bRunning = false;
		if (bPlaying) GEditor->RequestEndPlayMap();
		return Out;
	}

	void Shutdown()
	{
		Unhook();
		delete Log;
		Log = nullptr;
	}
}
