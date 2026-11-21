// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.
//
// Gameplay tests: see KesherPlayTest.h. Not compiled in KesherAI's CI (no engine there): every engine API used here
// exists in Unreal 5.1+; Enhanced Input parts are behind KESHER_WITH_ENHANCED_INPUT (set by KesherAIBridge.Build.cs).

#include "KesherPlayTest.h"

#include "Containers/Ticker.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/Blueprint.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "ImageUtils.h"
#include "InputCoreTypes.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/OutputDevice.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UnrealClient.h"

#ifndef KESHER_WITH_ENHANCED_INPUT
#define KESHER_WITH_ENHANCED_INPUT 0
#endif
#if KESHER_WITH_ENHANCED_INPUT
#include "EnhancedInputSubsystems.h"
#include "InputAction.h"
#include "InputActionValue.h"
#endif

namespace
{
	TSharedRef<FJsonObject> TestError(const FString& Message)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Message);
		return Out;
	}

	/** Print String, Blueprint errors, and every warning or error, while the test runs. */
	class FPlayTestLog : public FOutputDevice
	{
	public:
		virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& Category) override
		{
			const ELogVerbosity::Type Level = (ELogVerbosity::Type)(Verbosity & ELogVerbosity::VerbosityMask);
			const FString Cat = Category.ToString();
			if (!(Cat == TEXT("LogBlueprintUserMessages") || Cat == TEXT("LogScript") || Level <= ELogVerbosity::Warning)) return;
			FScopeLock Lock(&Guard);
			if (Lines.Num() >= 300) return;
			TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
			J->SetStringField(TEXT("kind"), Level <= ELogVerbosity::Error ? TEXT("error") : Level == ELogVerbosity::Warning ? TEXT("warning") : TEXT("log"));
			J->SetStringField(TEXT("category"), Cat);
			J->SetStringField(TEXT("text"), FString(V).Left(500));
			Lines.Add(MakeShared<FJsonValueObject>(J));
		}
		virtual bool CanBeUsedOnAnyThread() const override { return true; }
		TArray<TSharedPtr<FJsonValue>> Copy()
		{
			FScopeLock Lock(&Guard);
			return Lines;
		}
		void Reset()
		{
			FScopeLock Lock(&Guard);
			Lines.Reset();
		}

	private:
		FCriticalSection Guard;
		TArray<TSharedPtr<FJsonValue>> Lines;
	};

	/** The test that runs (one at a time). */
	struct FRun
	{
		TArray<TSharedPtr<FJsonValue>> Steps;
		TArray<TSharedPtr<FJsonValue>> Results;
		int32 Index = 0;
		int32 Frame = 0;
		double StepStart = 0;
		double Started = 0;
		double Timeout = 60;
		bool bActive = false;
		bool bPlaying = false;
		bool bDone = false;
		bool bPassed = false;
		FString Reason;
		FString LastSeen;
		FTSTicker::FDelegateHandle Ticker;
		FDelegateHandle StartedHandle;
		FDelegateHandle EndedHandle;
	};

	FRun Run;
	FPlayTestLog* Log = nullptr;

	UWorld* PlayWorld() { return GEditor ? GEditor->PlayWorld : nullptr; }

	APlayerController* Player()
	{
		UWorld* World = PlayWorld();
		return World ? World->GetFirstPlayerController() : nullptr;
	}

	/** The actor a step names: player, controller, class:<Name>, or an actor's name or label. */
	AActor* FindActor(const FString& Spec)
	{
		UWorld* World = PlayWorld();
		APlayerController* PC = Player();
		if (!World) return nullptr;
		if (Spec == TEXT("player") || Spec == TEXT("pawn")) return PC ? PC->GetPawn() : nullptr;
		if (Spec == TEXT("controller")) return PC;
		const bool bClass = Spec.StartsWith(TEXT("class:"));
		const FString Want = bClass ? Spec.Mid(6) : Spec;
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			AActor* A = *It;
			if (bClass ? A->GetClass()->GetName().StartsWith(Want) : (A->GetName() == Want || A->GetActorLabel() == Want)) return A;
		}
		return nullptr;
	}

	/** A value read from the play world. */
	struct FSeen
	{
		bool bFound = false;
		bool bNumber = false;
		bool bVector = false;
		double Number = 0;
		FVector Vector = FVector::ZeroVector;
		FString Text;
	};

	FSeen Number(double V)
	{
		FSeen S;
		S.bFound = S.bNumber = true;
		S.Number = V;
		S.Text = FString::SanitizeFloat(V);
		return S;
	}

	FSeen Vector(const FVector& V)
	{
		FSeen S;
		S.bFound = S.bVector = true;
		S.Vector = V;
		S.Text = V.ToString();
		return S;
	}

	/** location, location.z, rotation(.yaw), velocity(.x), speed, hidden, or a property path (Stats.Health). */
	FSeen Read(AActor* Actor, const FString& Property)
	{
		FSeen None;
		if (!Actor) return None;
		FString Head = Property, Tail;
		Property.Split(TEXT("."), &Head, &Tail);
		const FString Low = Head.ToLower();
		auto Pick = [&Tail](const FVector& V) -> FSeen
		{
			const FString T = Tail.ToLower();
			if (T == TEXT("x") || T == TEXT("pitch")) return Number(V.X);
			if (T == TEXT("y") || T == TEXT("yaw")) return Number(V.Y);
			if (T == TEXT("z") || T == TEXT("roll")) return Number(V.Z);
			return Vector(V);
		};
		if (Low == TEXT("location")) return Pick(Actor->GetActorLocation());
		if (Low == TEXT("rotation")) { const FRotator R = Actor->GetActorRotation(); return Pick(FVector(R.Pitch, R.Yaw, R.Roll)); }
		if (Low == TEXT("velocity")) return Pick(Actor->GetVelocity());
		if (Low == TEXT("speed")) return Number(Actor->GetVelocity().Size());
		if (Low == TEXT("hidden")) return Number(Actor->IsHidden() ? 1 : 0);

		// A property by name, through structs: Stats.Health.
		UStruct* Struct = Actor->GetClass();
		void* Container = Actor;
		TArray<FString> Parts;
		Property.ParseIntoArray(Parts, TEXT("."));
		for (int32 I = 0; I < Parts.Num(); ++I)
		{
			FProperty* Prop = Struct ? FindFProperty<FProperty>(Struct, FName(*Parts[I])) : nullptr;
			if (!Prop) return None;
			void* Value = Prop->ContainerPtrToValuePtr<void>(Container);
			if (I + 1 < Parts.Num())
			{
				FStructProperty* SP = CastField<FStructProperty>(Prop);
				if (!SP) return None;
				Struct = SP->Struct;
				Container = Value;
				continue;
			}
			if (FNumericProperty* NP = CastField<FNumericProperty>(Prop))
				return Number(NP->IsFloatingPoint() ? NP->GetFloatingPointPropertyValue(Value) : (double)NP->GetSignedIntPropertyValue(Value));
			if (FBoolProperty* BP = CastField<FBoolProperty>(Prop)) return Number(BP->GetPropertyValue(Value) ? 1 : 0);
			if (FStructProperty* SP = CastField<FStructProperty>(Prop); SP && SP->Struct == TBaseStructure<FVector>::Get())
				return Vector(*static_cast<FVector*>(Value));
			FSeen S;
			S.bFound = true;
			Prop->ExportTextItem_Direct(S.Text, Value, nullptr, nullptr, PPF_None);
			return S;
		}
		return None;
	}

	/** Whether a condition holds; Seen says what was there (for the step's text). */
	bool Holds(const TSharedPtr<FJsonObject>& C, FString& Seen)
	{
		const FString ActorSpec = C->GetStringField(TEXT("actor"));
		const FString Property = C->GetStringField(TEXT("property"));
		const FString Op = C->GetStringField(TEXT("op"));
		AActor* Actor = FindActor(ActorSpec);
		const FSeen V = Read(Actor, Property);
		Seen = !Actor ? FString::Printf(TEXT("no actor %s"), *ActorSpec) : !V.bFound ? FString::Printf(TEXT("%s has no %s"), *Actor->GetName(), *Property) : FString::Printf(TEXT("%s = %s"), *Property, *V.Text);
		if (Op == TEXT("exists")) return V.bFound;
		if (!V.bFound) return false;
		const TSharedPtr<FJsonValue> Want = C->TryGetField(TEXT("value"));
		if (!Want.IsValid()) return false;
		double Tolerance = Op == TEXT("near") ? 50 : 1e-3;
		C->TryGetNumberField(TEXT("tolerance"), Tolerance);
		if (V.bVector)
		{
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (!Want->TryGetArray(Arr) || Arr->Num() < 3) return false;
			const FVector W((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
			const bool bClose = FVector::Dist(V.Vector, W) <= Tolerance;
			return Op == TEXT("!=") ? !bClose : (Op == TEXT("==") || Op == TEXT("near")) && bClose;
		}
		if (V.bNumber && (Want->Type == EJson::Number || Want->Type == EJson::Boolean))
		{
			const double W = Want->Type == EJson::Boolean ? (Want->AsBool() ? 1 : 0) : Want->AsNumber();
			if (Op == TEXT("==") || Op == TEXT("near")) return FMath::Abs(V.Number - W) <= Tolerance;
			if (Op == TEXT("!=")) return FMath::Abs(V.Number - W) > Tolerance;
			if (Op == TEXT(">")) return V.Number > W;
			if (Op == TEXT("<")) return V.Number < W;
			if (Op == TEXT(">=")) return V.Number >= W;
			if (Op == TEXT("<=")) return V.Number <= W;
			return false;
		}
		const FString W = Want->AsString();
		if (Op == TEXT("contains")) return V.Text.Contains(W);
		if (Op == TEXT("==")) return V.Text.Equals(W, ESearchCase::IgnoreCase);
		if (Op == TEXT("!=")) return !V.Text.Equals(W, ESearchCase::IgnoreCase);
		return false;
	}

	/** A PNG of the game view in Saved/KesherAI/play-test/<Name>.png; empty without a view (-NullRHI). */
	FString Picture(const FString& Name)
	{
		FViewport* Viewport = nullptr;
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
			if (Context.WorldType == EWorldType::PIE && Context.GameViewport && Context.GameViewport->Viewport) Viewport = Context.GameViewport->Viewport;
		if (!Viewport) return FString();
		const FIntPoint Size = Viewport->GetSizeXY();
		TArray<FColor> Pixels;
		if (Size.X <= 0 || Size.Y <= 0 || !Viewport->ReadPixels(Pixels) || Pixels.Num() != Size.X * Size.Y) return FString();
		for (FColor& C : Pixels) C.A = 255;
		const FString Dir = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("KesherAI") / TEXT("play-test"));
		IFileManager::Get().MakeDirectory(*Dir, true);
		// Only letters, digits, - and _ in the file name (KesherAI reads nothing else back).
		FString Safe;
		for (TCHAR Ch : Name) Safe.AppendChar(FChar::IsAlnum(Ch) || Ch == '-' || Ch == '_' ? Ch : '_');
		const FString File = Dir / (Safe.Left(64) + TEXT(".png"));
		TArray64<uint8> Png;
		FImageUtils::PNGCompressImageArray(Size.X, Size.Y, TArrayView64<const FColor>(Pixels.GetData(), Pixels.Num()), Png);
		return Png.Num() && FFileHelper::SaveArrayToFile(TArrayView64<const uint8>(Png.GetData(), Png.Num()), *File) ? File : FString();
	}

	void Record(bool bOk, const FString& Text, const FString& PictureFile = FString())
	{
		const TSharedPtr<FJsonObject> Step = Run.Steps[Run.Index]->AsObject();
		TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
		R->SetNumberField(TEXT("index"), Run.Index);
		R->SetStringField(TEXT("do"), Step.IsValid() ? Step->GetStringField(TEXT("do")) : FString());
		R->SetBoolField(TEXT("ok"), bOk);
		R->SetStringField(TEXT("text"), Text.Left(400));
		R->SetNumberField(TEXT("ms"), FMath::RoundToInt((FPlatformTime::Seconds() - Run.StepStart) * 1000));
		if (!PictureFile.IsEmpty()) R->SetStringField(TEXT("picture"), PictureFile);
		Run.Results.Add(MakeShared<FJsonValueObject>(R));
		Run.Index++;
		Run.Frame = 0;
		Run.StepStart = FPlatformTime::Seconds();
		if (!bOk) { Run.bDone = true; Run.bPassed = false; }
		else if (Run.Index >= Run.Steps.Num()) { Run.bDone = true; Run.bPassed = true; }
	}

	void Finish(const FString& Why)
	{
		if (Run.bDone) return;
		Run.bDone = true;
		Run.bPassed = false;
		Run.Reason = Why;
	}

	int32 Frames(const TSharedPtr<FJsonObject>& S)
	{
		double F = 10;
		S->TryGetNumberField(TEXT("frames"), F);
		return FMath::Clamp((int32)F, 1, 600);
	}

	/** One frame of the current step. */
	void StepFrame()
	{
		const TSharedPtr<FJsonObject> S = Run.Steps[Run.Index]->AsObject();
		APlayerController* PC = Player();
		if (!S.IsValid()) return Record(false, TEXT("Not a step."));
		const FString Do = S->GetStringField(TEXT("do"));
		const double InStep = FPlatformTime::Seconds() - Run.StepStart;
		const int32 Frame = Run.Frame++;

		if (Do == TEXT("spawn"))
		{
			const FString Path = S->GetStringField(TEXT("class"));
			UClass* Class = LoadClass<AActor>(nullptr, *Path);
			if (!Class)
			{
				// A Blueprint asset path (without _C): its generated class.
				if (UBlueprint* Asset = LoadObject<UBlueprint>(nullptr, *Path)) Class = Asset->GeneratedClass;
			}
			if (!Class || !Class->IsChildOf(AActor::StaticClass())) return Record(false, TEXT("No actor class at ") + Path);
			FVector Where = FVector::ZeroVector;
			FRotator Facing = FRotator::ZeroRotator;
			if (PC) PC->GetPlayerViewPoint(Where, Facing);
			const TArray<TSharedPtr<FJsonValue>>* Off = nullptr;
			FVector Offset(400, 0, 0);
			if (S->TryGetArrayField(TEXT("offset"), Off) && Off->Num() >= 2) Offset = FVector((*Off)[0]->AsNumber(), (*Off)[1]->AsNumber(), Off->Num() > 2 ? (*Off)[2]->AsNumber() : 0);
			FActorSpawnParameters Params;
			Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButAlwaysSpawn;
			AActor* A = PlayWorld()->SpawnActor<AActor>(Class, Where + FRotator(0, Facing.Yaw, 0).RotateVector(Offset), FRotator(0, Facing.Yaw + 180, 0), Params);
			if (!A) return Record(false, TEXT("Could not spawn ") + Class->GetName());
			bool bPossess = false;
			S->TryGetBoolField(TEXT("possess"), bPossess);
			if (bPossess)
			{
				APawn* Pawn = Cast<APawn>(A);
				if (!Pawn || !PC) return Record(false, A->GetName() + TEXT(" is not a pawn the player can possess"));
				PC->Possess(Pawn);
			}
			return Record(true, TEXT("spawned ") + A->GetName());
		}
		if (Do == TEXT("possess"))
		{
			APawn* Pawn = Cast<APawn>(FindActor(S->GetStringField(TEXT("actor"))));
			if (!Pawn || !PC) return Record(false, TEXT("No pawn named ") + S->GetStringField(TEXT("actor")));
			PC->Possess(Pawn);
			return Record(true, TEXT("possessed ") + Pawn->GetName());
		}
		if (Do == TEXT("input"))
		{
#if KESHER_WITH_ENHANCED_INPUT
			UInputAction* Action = LoadObject<UInputAction>(nullptr, *S->GetStringField(TEXT("action")));
			UEnhancedInputLocalPlayerSubsystem* Input = PC && PC->GetLocalPlayer() ? ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()) : nullptr;
			if (!Action) return Record(false, TEXT("No input action at ") + S->GetStringField(TEXT("action")));
			if (!Input) return Record(false, TEXT("The player has no Enhanced Input subsystem."));
			FInputActionValue Value(true);
			const TSharedPtr<FJsonValue> V = S->TryGetField(TEXT("value"));
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (V.IsValid() && V->Type == EJson::Number) Value = FInputActionValue((float)V->AsNumber());
			else if (V.IsValid() && V->Type == EJson::Boolean) Value = FInputActionValue(V->AsBool());
			else if (V.IsValid() && V->TryGetArray(Arr) && Arr->Num() == 2) Value = FInputActionValue(FVector2D((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber()));
			else if (V.IsValid() && V->TryGetArray(Arr) && Arr->Num() >= 3) Value = FInputActionValue(FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber()));
			Input->InjectInputForAction(Action, Value, {}, {});
			if (Frame + 1 >= Frames(S)) return Record(true, FString::Printf(TEXT("%s for %d frames"), *Action->GetName(), Frames(S)));
			return;
#else
			return Record(false, TEXT("This engine has no Enhanced Input plugin; use a key step."));
#endif
		}
		if (Do == TEXT("key") || Do == TEXT("axis"))
		{
			const FKey Key(FName(*S->GetStringField(TEXT("key"))));
			if (!Key.IsValid()) return Record(false, TEXT("No key named ") + S->GetStringField(TEXT("key")));
			if (!PC) return Record(false, TEXT("No player controller."));
			const int32 N = Frames(S);
			const float Dt = PlayWorld()->GetDeltaSeconds();
			if (Do == TEXT("axis"))
			{
				double V = 1;
				S->TryGetNumberField(TEXT("value"), V);
				PC->InputKey(FInputKeyParams(Key, V, Dt, 1, Key.IsGamepadKey()));
			}
			else if (Frame == 0) PC->InputKey(FInputKeyParams(Key, IE_Pressed, 1.0, Key.IsGamepadKey()));
			if (Frame + 1 >= N)
			{
				if (Do == TEXT("key")) PC->InputKey(FInputKeyParams(Key, IE_Released, 0.0, Key.IsGamepadKey()));
				return Record(true, FString::Printf(TEXT("%s for %d frames"), *Key.ToString(), N));
			}
			return;
		}
		if (Do == TEXT("wait"))
		{
			const TSharedPtr<FJsonObject>* Until = nullptr;
			if (S->TryGetObjectField(TEXT("until"), Until))
			{
				double Limit = 5;
				S->TryGetNumberField(TEXT("timeout"), Limit);
				FString Seen;
				if (Holds(*Until, Seen)) return Record(true, Seen);
				if (InStep >= Limit) return Record(false, FString::Printf(TEXT("still not true after %.1f s (%s)"), Limit, *Seen));
				return;
			}
			double Seconds = 1;
			S->TryGetNumberField(TEXT("seconds"), Seconds);
			if (InStep >= Seconds) Record(true, FString());
			return;
		}
		if (Do == TEXT("assert"))
		{
			FString Seen;
			const bool bOk = Holds(S, Seen);
			FString Message;
			S->TryGetStringField(TEXT("message"), Message);
			return Record(bOk, bOk || Message.IsEmpty() ? Seen : Message + TEXT(" (") + Seen + TEXT(")"));
		}
		if (Do == TEXT("screenshot"))
		{
			// One frame after the step before, so the view shows its result.
			if (Frame == 0) return;
			FString Name;
			if (!S->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty()) Name = FString::Printf(TEXT("step%d"), Run.Index + 1);
			const FString File = Picture(Name);
			return Record(true, File.IsEmpty() ? TEXT("no picture (nothing is drawn here)") : Name, File);
		}
		Record(false, TEXT("Unknown step ") + Do);
	}

	bool Tick(float)
	{
		if (!Run.bActive) return false;
		if (Run.bDone || !Run.bPlaying) return true;
		if (!PlayWorld())
		{
			Finish(TEXT("Play ended before the test finished."));
			return true;
		}
		if (FPlatformTime::Seconds() - Run.Started > Run.Timeout)
		{
			Finish(FString::Printf(TEXT("The test did not finish in %.0f s."), Run.Timeout));
			return true;
		}
		StepFrame();
		return true;
	}

	void Unhook()
	{
		if (Run.Ticker.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(Run.Ticker);
		Run.Ticker.Reset();
		FEditorDelegates::PostPIEStarted.Remove(Run.StartedHandle);
		FEditorDelegates::EndPIE.Remove(Run.EndedHandle);
		if (Log && GLog) GLog->RemoveOutputDevice(Log);
	}

	TSharedRef<FJsonObject> State()
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetBoolField(TEXT("running"), Run.bActive && !Run.bDone);
		Out->SetBoolField(TEXT("done"), Run.bDone);
		Out->SetBoolField(TEXT("passed"), Run.bDone && Run.bPassed);
		if (!Run.Reason.IsEmpty()) Out->SetStringField(TEXT("reason"), Run.Reason);
		Out->SetArrayField(TEXT("steps"), Run.Results);
		Out->SetArrayField(TEXT("log"), Log ? Log->Copy() : TArray<TSharedPtr<FJsonValue>>());
		Out->SetNumberField(TEXT("seconds"), Run.Started > 0 ? FPlatformTime::Seconds() - Run.Started : 0);
		return Out;
	}
}

namespace KesherPlayTest
{
	TSharedRef<FJsonObject> Start(const TSharedPtr<FJsonObject>& Plan)
	{
		if (!GEditor) return TestError(TEXT("No editor."));
		if (GEditor->IsPlaySessionInProgress() || GEditor->PlayWorld) return TestError(TEXT("The game is already playing in the editor. Stop it first (Esc), then test again."));
		const TArray<TSharedPtr<FJsonValue>>* Steps = nullptr;
		if (!Plan.IsValid() || !Plan->TryGetArrayField(TEXT("steps"), Steps) || Steps->Num() == 0 || Steps->Num() > 40) return TestError(TEXT("The test plan needs 1-40 steps."));

		Unhook();
		Run = FRun();
		Run.Steps = *Steps;
		Plan->TryGetNumberField(TEXT("timeout"), Run.Timeout);
		Run.Timeout = FMath::Clamp(Run.Timeout, 5.0, 300.0);
		if (!Log) Log = new FPlayTestLog();
		Log->Reset();
		GLog->AddOutputDevice(Log);
		Run.bActive = true;
		Run.StartedHandle = FEditorDelegates::PostPIEStarted.AddLambda([](const bool)
		{
			Run.bPlaying = true;
			Run.Started = Run.StepStart = FPlatformTime::Seconds();
		});
		Run.EndedHandle = FEditorDelegates::EndPIE.AddLambda([](const bool) { Run.bPlaying = false; Finish(TEXT("Play ended before the test finished.")); });
		Run.Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateStatic(&Tick));

		FRequestPlaySessionParams Params;
		Params.WorldType = EPlaySessionWorldType::PlayInEditor;
		// A test map is only what is played; the level open in the editor is not changed.
		FString Map;
		if (Plan->TryGetStringField(TEXT("map"), Map) && Map.StartsWith(TEXT("/Game/"))) Params.GlobalMapOverride = Map;
		GEditor->RequestPlaySession(Params);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetBoolField(TEXT("started"), true);
		return Out;
	}

	TSharedRef<FJsonObject> Status() { return State(); }

	TSharedRef<FJsonObject> Stop()
	{
		if (Run.bActive && !Run.bDone) Finish(TEXT("Stopped."));
		TSharedRef<FJsonObject> Out = State();
		Unhook();
		Run.bActive = false;
		if (GEditor && GEditor->PlayWorld) GEditor->RequestEndPlayMap();
		return Out;
	}

	bool IsDone() { return !Run.bActive || Run.bDone; }

	void Shutdown()
	{
		Unhook();
		Run = FRun();
		delete Log;
		Log = nullptr;
	}
}

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	/** Waits for the gameplay test, then reports each failed step to the automation framework (and the file). */
	class FKesherWaitPlayTest : public IAutomationLatentCommand
	{
	public:
		FKesherWaitPlayTest(FAutomationTestBase* InTest, FString InResponse) : Test(InTest), Response(MoveTemp(InResponse)), Since(FPlatformTime::Seconds()) {}
		virtual bool Update() override
		{
			if (!KesherPlayTest::IsDone() && FPlatformTime::Seconds() - Since < 330) return false;
			const TSharedRef<FJsonObject> End = KesherPlayTest::Stop();
			FString Reason;
			if (End->TryGetStringField(TEXT("reason"), Reason)) Test->AddError(Reason);
			for (const TSharedPtr<FJsonValue>& V : End->GetArrayField(TEXT("steps")))
			{
				const TSharedPtr<FJsonObject> S = V->AsObject();
				if (S.IsValid() && !S->GetBoolField(TEXT("ok"))) Test->AddError(FString::Printf(TEXT("Step %d (%s): %s"), (int32)S->GetNumberField(TEXT("index")) + 1, *S->GetStringField(TEXT("do")), *S->GetStringField(TEXT("text"))));
			}
			if (!Response.IsEmpty())
			{
				FString Text;
				const TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&Text);
				FJsonSerializer::Serialize(End, W);
				FFileHelper::SaveStringToFile(Text, *Response);
			}
			return true;
		}

	private:
		FAutomationTestBase* Test;
		FString Response;
		double Since;
	};
}

/**
 * KesherAI.PlayTest.<name>: one automation test per Content/KesherTests/<name>.json, and "Request" for the plan file
 * named by KESHER_PLAYTEST_REQUEST (KesherAI with Unreal closed; the result goes to KESHER_PLAYTEST_RESPONSE).
 */
IMPLEMENT_COMPLEX_AUTOMATION_TEST(FKesherPlayTestAutomation, "KesherAI.PlayTest", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ProductFilter)

void FKesherPlayTestAutomation::GetTests(TArray<FString>& OutBeautifiedNames, TArray<FString>& OutTestCommands) const
{
	OutBeautifiedNames.Add(TEXT("Request"));
	OutTestCommands.Add(FString());
	TArray<FString> Files;
	const FString Dir = FPaths::ProjectContentDir() / TEXT("KesherTests");
	IFileManager::Get().FindFiles(Files, *(Dir / TEXT("*.json")), true, false);
	for (const FString& F : Files)
	{
		OutBeautifiedNames.Add(FPaths::GetBaseFilename(F));
		OutTestCommands.Add(Dir / F);
	}
}

bool FKesherPlayTestAutomation::RunTest(const FString& Parameters)
{
	const bool bRequest = Parameters.IsEmpty();
	const FString File = bRequest ? FPlatformMisc::GetEnvironmentVariable(TEXT("KESHER_PLAYTEST_REQUEST")) : Parameters;
	FString Text;
	if (File.IsEmpty() || !FFileHelper::LoadFileToString(Text, *File))
	{
		// "Request" without KesherAI asking is nothing to run (Session Frontend lists it too).
		if (bRequest) return true;
		AddError(TEXT("Cannot read ") + File);
		return false;
	}
	TSharedPtr<FJsonObject> Plan;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Plan) || !Plan.IsValid())
	{
		AddError(TEXT("Not a test plan: ") + File);
		return false;
	}
	const TSharedRef<FJsonObject> Start = KesherPlayTest::Start(Plan);
	FString Problem;
	if (Start->TryGetStringField(TEXT("error"), Problem))
	{
		AddError(Problem);
		return false;
	}
	ADD_LATENT_AUTOMATION_COMMAND(FKesherWaitPlayTest(this, bRequest ? FPlatformMisc::GetEnvironmentVariable(TEXT("KESHER_PLAYTEST_RESPONSE")) : FString()));
	return true;
}

#endif
