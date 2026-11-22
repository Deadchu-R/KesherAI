// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherAssets.h"

#include "AssetExportTask.h"
#include "AssetImportTask.h"
#include "AssetToolsModule.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Exporters/Exporter.h"
#include "Exporters/FbxExportOption.h"
#include "Factories/FbxImportUI.h"
#include "HAL/FileManager.h"
#include "IAssetTools.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Sound/SoundWave.h"

namespace
{
	TSharedRef<FJsonObject> AssetError(const FString& Text)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Text);
		return Out;
	}

	/** Whether a file is inside the project's Saved/KesherAI/<Sub>/ folder (the only place KesherAI's files go). */
	bool InKesherFolder(const FString& File, const TCHAR* Sub)
	{
		if (File.Contains(TEXT(".."))) return false;
		FString Full = FPaths::ConvertRelativePathToFull(File);
		FPaths::NormalizeFilename(Full);
		FString Root = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("KesherAI") / Sub);
		FPaths::NormalizeFilename(Root);
		return Full.StartsWith(Root + TEXT("/"), ESearchCase::IgnoreCase);
	}

	/** "/Game/Props/SM_Rock" (or its object path) → its package, or "" when it is not under /Game. */
	FString PackageOf(const FString& Path)
	{
		FString Package = Path;
		Path.Split(TEXT("."), &Package, nullptr);
		return Package.StartsWith(TEXT("/Game/")) && !Package.Contains(TEXT("..")) ? Package : FString();
	}

	/** A package's main asset, loaded. */
	UObject* LoadAsset(const FString& Package)
	{
		return LoadObject<UObject>(nullptr, *(Package + TEXT(".") + FPackageName::GetShortName(Package)));
	}

	/** An asset name made only of letters, digits, "_" and "-". */
	bool PlainName(const FString& Name)
	{
		if (Name.IsEmpty() || Name.Len() > 120) return false;
		for (const TCHAR C : Name)
		{
			if (!FChar::IsAlnum(C) && C != TEXT('_') && C != TEXT('-')) return false;
		}
		return true;
	}
}

TSharedRef<FJsonObject> KesherAssets::Export(const FString& Path, const FString& File)
{
	const FString Package = PackageOf(Path);
	if (Package.IsEmpty()) return AssetError(TEXT("An asset under /Game."));
	if (!InKesherFolder(File, TEXT("exports"))) return AssetError(TEXT("Exports go under Saved/KesherAI/exports."));
	UObject* Asset = LoadAsset(Package);
	if (!Asset) return AssetError(TEXT("No asset at ") + Package);
	FString Ext;
	if (Asset->IsA<UStaticMesh>() || Asset->IsA<USkeletalMesh>()) Ext = TEXT("fbx");
	else if (Asset->IsA<UTexture2D>()) Ext = TEXT("png");
	else if (Asset->IsA<USoundWave>()) Ext = TEXT("wav");
	else return AssetError(Package + TEXT(" is a ") + Asset->GetClass()->GetName() + TEXT(": only meshes, textures and sounds open in KesherAI's editors."));
	if (!FPaths::GetExtension(File).Equals(Ext, ESearchCase::IgnoreCase)) return AssetError(TEXT("This asset exports as .") + Ext);

	IFileManager::Get().MakeDirectory(*FPaths::GetPath(File), true);
	UAssetExportTask* Task = NewObject<UAssetExportTask>();
	Task->Object = Asset;
	Task->Filename = File;
	Task->bSelected = false;
	Task->bReplaceIdentical = true;
	Task->bPrompt = false;
	Task->bAutomated = true;
	if (Ext == TEXT("fbx"))
	{
		// No options window (automated), binary FBX, the mesh only (no LODs, no collision).
		UFbxExportOption* Options = NewObject<UFbxExportOption>();
		Options->bASCII = false;
		Options->LevelOfDetail = false;
		Options->Collision = false;
		Task->Options = Options;
	}
	if (!UExporter::RunAssetExportTask(Task) || !IFileManager::Get().FileExists(*File)) return AssetError(TEXT("Unreal could not export ") + Package);
	TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("file"), File);
	Out->SetStringField(TEXT("format"), Ext);
	Out->SetStringField(TEXT("class"), Asset->GetClass()->GetName());
	return Out;
}

TSharedRef<FJsonObject> KesherAssets::Import(const FString& Path, const FString& File, const FString& Name)
{
	const FString Package = PackageOf(Path);
	if (Package.IsEmpty()) return AssetError(TEXT("An asset under /Game."));
	if (!InKesherFolder(File, TEXT("imports")) || !IFileManager::Get().FileExists(*File)) return AssetError(TEXT("The file to import must be under Saved/KesherAI/imports."));
	const FString Ext = FPaths::GetExtension(File).ToLower();
	if (Ext != TEXT("fbx") && Ext != TEXT("glb") && Ext != TEXT("gltf") && Ext != TEXT("png") && Ext != TEXT("wav")) return AssetError(TEXT("Only FBX, glTF, PNG and WAV files are imported."));
	const FString AssetName = Name.IsEmpty() ? FPackageName::GetShortName(Package) : Name;
	if (!PlainName(AssetName)) return AssetError(TEXT("An asset name of letters, digits, _ and -."));
	const FString Folder = FPackageName::GetLongPackagePath(Package);
	// The asset being replaced (or the original next to a new one): its kind decides how a mesh is imported.
	UObject* Existing = LoadAsset(Folder / AssetName);
	UObject* Original = Existing ? Existing : LoadAsset(Package);

	UAssetImportTask* Task = NewObject<UAssetImportTask>();
	Task->Filename = File;
	Task->DestinationPath = Folder;
	Task->DestinationName = AssetName;
	Task->bAutomated = true;
	Task->bReplaceExisting = true;
	Task->bSave = true;
	if (Ext == TEXT("fbx"))
	{
		const bool bSkeletal = Original && Original->IsA<USkeletalMesh>();
		UFbxImportUI* Options = NewObject<UFbxImportUI>();
		Options->bAutomatedImportShouldDetectType = false;
		Options->bImportAsSkeletal = bSkeletal;
		Options->MeshTypeToImport = bSkeletal ? FBXIT_SkeletalMesh : FBXIT_StaticMesh;
		Options->bImportMaterials = false;
		Options->bImportTextures = false;
		Options->bImportAnimations = false;
		Task->Options = Options;
	}
	FAssetToolsModule& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
	Tools.Get().ImportAssetTasks({ Task });
	if (Task->ImportedObjectPaths.Num() == 0) return AssetError(TEXT("Unreal did not import ") + FPaths::GetCleanFilename(File));
	TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("asset"), Task->ImportedObjectPaths[0]);
	Out->SetBoolField(TEXT("replaced"), Existing != nullptr);
	return Out;
}
