// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherDispatch.h"

#include "Editor.h"
#include "FileHelpers.h"
#include "KesherGraph.h"
#include "KesherPlay.h"
#include "KesherWidget.h"
#include "Modules/ModuleManager.h"
#if WITH_LIVE_CODING
#include "ILiveCodingModule.h"
#endif

TSharedPtr<FJsonObject> KesherDispatch::Run(const TSharedPtr<FJsonObject>& In, bool bOffline)
{
	FString Cmd, Path, Graph;
	In->TryGetStringField(TEXT("cmd"), Cmd);
	In->TryGetStringField(TEXT("path"), Path);
	In->TryGetStringField(TEXT("graph"), Graph);

	TSharedPtr<FJsonObject> Result;
	// With the editor closed (the KesherBridge commandlet), only what needs no open editor window runs.
	if (bOffline && (Cmd == TEXT("live_coding") || Cmd == TEXT("open") || Cmd == TEXT("undo") || Cmd == TEXT("redo") || Cmd == TEXT("quit_for_update") || Cmd.StartsWith(TEXT("play"))))
	{
		Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("error"), TEXT("This needs the open Unreal Editor."));
		return Result;
	}
	if (Cmd == TEXT("list")) Result = KesherGraph::List();
	else if (Cmd == TEXT("graph")) Result = KesherGraph::Read(Path);
	else if (Cmd == TEXT("apply"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Ops = nullptr;
		if (In->TryGetArrayField(TEXT("ops"), Ops)) Result = KesherGraph::Apply(Path, Graph, *Ops);
	}
	else if (Cmd == TEXT("vars"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Ops = nullptr;
		if (In->TryGetArrayField(TEXT("ops"), Ops)) Result = KesherGraph::EditVariables(Path, *Ops);
	}
	else if (Cmd == TEXT("compile")) Result = KesherGraph::Compile(Path);
	else if (Cmd == TEXT("live_coding"))
	{
		// The editor's Live Coding (Ctrl+Alt+F11) for C++ changed in KesherAI's code editor; waits until it ends.
		Result = MakeShared<FJsonObject>();
#if WITH_LIVE_CODING
		ILiveCodingModule* LiveCoding = FModuleManager::GetModulePtr<ILiveCodingModule>(LIVE_CODING_MODULE_NAME);
		if (!LiveCoding || !LiveCoding->IsEnabledForSession())
		{
			Result->SetBoolField(TEXT("ok"), false);
			Result->SetStringField(TEXT("result"), TEXT("Live Coding is off in this editor (Editor Preferences → Live Coding), or a header changed: close the editor and compile."));
		}
		else
		{
			ELiveCodingCompileResult Outcome = ELiveCodingCompileResult::NotStarted;
			LiveCoding->Compile(ELiveCodingCompileFlags::WaitForCompletion, &Outcome);
			const bool bOk = Outcome == ELiveCodingCompileResult::Success || Outcome == ELiveCodingCompileResult::NoChanges;
			Result->SetBoolField(TEXT("ok"), bOk);
			Result->SetStringField(TEXT("result"), Outcome == ELiveCodingCompileResult::Success ? TEXT("Compiled and patched into the running editor.") : Outcome == ELiveCodingCompileResult::NoChanges ? TEXT("No changes to compile.") : Outcome == ELiveCodingCompileResult::CompileStillActive || Outcome == ELiveCodingCompileResult::InProgress ? TEXT("A compile is already running.") : TEXT("Live Coding failed: see the Live Coding window or the Output Log for the errors."));
		}
#else
		Result->SetBoolField(TEXT("ok"), false);
		Result->SetStringField(TEXT("result"), TEXT("Live Coding is not available here (Windows editor only)."));
#endif
	}
	else if (Cmd == TEXT("save")) Result = KesherGraph::Save(Path);
	else if (Cmd == TEXT("open")) Result = KesherGraph::Open(Path);
	else if (Cmd == TEXT("actions"))
	{
		FString Query, PinType, PinDir;
		In->TryGetStringField(TEXT("query"), Query);
		In->TryGetStringField(TEXT("pinType"), PinType);
		In->TryGetStringField(TEXT("pinDir"), PinDir);
		Result = KesherGraph::Actions(Path, Query, PinType, PinDir);
	}
	else if (Cmd == TEXT("widget")) Result = KesherWidget::Read(Path);
	else if (Cmd == TEXT("create"))
	{
		FString Parent;
		In->TryGetStringField(TEXT("parent"), Parent);
		Result = KesherWidget::CreateBlueprint(Path, Parent);
	}
	else if (Cmd == TEXT("import_texture"))
	{
		FString File, Folder, Name;
		In->TryGetStringField(TEXT("file"), File);
		In->TryGetStringField(TEXT("folder"), Folder);
		In->TryGetStringField(TEXT("name"), Name);
		Result = KesherWidget::ImportTexture(File, Folder, Name);
	}
	else if (Cmd == TEXT("widget_apply"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Ops = nullptr;
		if (In->TryGetArrayField(TEXT("ops"), Ops)) Result = KesherWidget::Apply(Path, *Ops);
	}
	else if (Cmd == TEXT("undo") || Cmd == TEXT("redo")) Result = KesherGraph::Undo(Cmd == TEXT("redo"));
	else if (Cmd == TEXT("quit_for_update"))
	{
		// The user pressed "Update the plugin": the editor asks to save unsaved work (the user's choice), then closes;
		// KesherAI replaces the plugin and opens the project again.
		const bool bSaved = FEditorFileUtils::SaveDirtyPackages(true, true, true);
		Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), bSaved);
		if (bSaved) FPlatformMisc::RequestExit(false);
	}
	else if (Cmd == TEXT("play"))
	{
		bool bPlace = true;
		In->TryGetBoolField(TEXT("place"), bPlace);
		Result = KesherPlay::Start(Path, bPlace);
	}
	else if (Cmd == TEXT("play_status")) Result = KesherPlay::Status();
	else if (Cmd == TEXT("play_stop")) Result = KesherPlay::Stop();
	else if (Cmd == TEXT("ping"))
	{
		Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("ok"), true);
	}

	return Result;
}

TSharedRef<FJsonObject> KesherDispatch::Answer(const TSharedPtr<FJsonObject>& In, bool bOffline)
{
	FString Cmd;
	In->TryGetStringField(TEXT("cmd"), Cmd);
	TSharedPtr<FJsonObject> Result = Run(In, bOffline);
	TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
	FString Problem;
	if (!Result.IsValid()) Problem = TEXT("Unknown command: ") + Cmd;
	else if (Result->TryGetStringField(TEXT("error"), Problem)) {}
	Out->SetBoolField(TEXT("ok"), Problem.IsEmpty());
	if (Problem.IsEmpty()) Out->SetObjectField(TEXT("result"), Result);
	else Out->SetStringField(TEXT("error"), Problem);
	return Out;
}
