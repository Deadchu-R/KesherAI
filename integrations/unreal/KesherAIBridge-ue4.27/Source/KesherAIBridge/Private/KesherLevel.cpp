// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherLevel.h"

// Unreal 4.27 keeps this header at the module's top level (the AssetRegistry/ folder is 5.0+).
#include "AssetRegistryModule.h"
#include "Components/MeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "GameFramework/Actor.h"
#include "GameFramework/WorldSettings.h"
#include "Materials/MaterialInterface.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/Base64.h"
#include "ScopedTransaction.h"
#include "StaticMeshAttributes.h"
// No WorldPartition/WorldPartition.h: World Partition is Unreal 5 only, so a 4.27 level is never partitioned.

namespace
{
	TSharedRef<FJsonObject> LevelError(const FString& Text)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Text);
		return Out;
	}

	/** "/Game/Maps/Level1" (or its object path) → the level: the open one when it is the editor's, else loaded. */
	UWorld* LoadLevel(const FString& Path)
	{
		FString Package = Path;
		Package.Split(TEXT("."), &Package, nullptr);
		if (!Package.StartsWith(TEXT("/Game/"))) return nullptr;
		if (GEditor)
		{
			UWorld* Open = GEditor->GetEditorWorldContext().World();
			if (Open && Open->GetOutermost()->GetName() == Package) return Open;
		}
		const FString Name = FPackageName::GetShortName(Package);
		return LoadObject<UWorld>(nullptr, *(Package + TEXT(".") + Name));
	}

	TArray<TSharedPtr<FJsonValue>> Numbers(std::initializer_list<double> List)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		for (double D : List) Out.Add(MakeShared<FJsonValueNumber>(D));
		return Out;
	}

	/** An actor's mesh components and the material in each slot (slot name, or its index when unnamed). */
	TArray<TSharedPtr<FJsonValue>> MaterialSlots(AActor* Actor)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		TInlineComponentArray<UMeshComponent*> Meshes(Actor);
		for (const UMeshComponent* M : Meshes)
		{
			if (!M || Out.Num() >= 8) continue;
			const TArray<FName> Names = M->GetMaterialSlotNames();
			TArray<TSharedPtr<FJsonValue>> Slots;
			for (int32 I = 0; I < M->GetNumMaterials() && I < 32; ++I)
			{
				TSharedRef<FJsonObject> Slot = MakeShared<FJsonObject>();
				Slot->SetStringField(TEXT("slot"), Names.IsValidIndex(I) && !Names[I].IsNone() ? Names[I].ToString() : FString::FromInt(I));
				const UMaterialInterface* Mat = M->GetMaterial(I);
				Slot->SetStringField(TEXT("material"), Mat ? Mat->GetPathName() : FString());
				Slots.Add(MakeShared<FJsonValueObject>(Slot));
			}
			TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("component"), M->GetName());
			Item->SetArrayField(TEXT("materials"), Slots);
			Out.Add(MakeShared<FJsonValueObject>(Item));
		}
		return Out;
	}

	bool Read3(const TSharedPtr<FJsonObject>& O, const TCHAR* Key, FVector& Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* A = nullptr;
		if (!O.IsValid() || !O->TryGetArrayField(Key, A) || A->Num() != 3) return false;
		Out = FVector((*A)[0]->AsNumber(), (*A)[1]->AsNumber(), (*A)[2]->AsNumber());
		return true;
	}

	bool Read4(const TSharedPtr<FJsonObject>& O, const TCHAR* Key, FQuat& Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* A = nullptr;
		if (!O.IsValid() || !O->TryGetArrayField(Key, A) || A->Num() != 4) return false;
		Out = FQuat((*A)[0]->AsNumber(), (*A)[1]->AsNumber(), (*A)[2]->AsNumber(), (*A)[3]->AsNumber());
		return true;
	}
}

namespace KesherLevel
{
	TSharedRef<FJsonObject> Levels()
	{
		IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
		// In the headless editor (Unreal closed) the registry is still scanning when the command runs: wait for it,
		// else the list is empty (found on the PC: no levels in a project that has them).
		if (IsRunningCommandlet() || Registry.IsLoadingAssets()) Registry.SearchAllAssets(true);
		TArray<FAssetData> Assets;
		// Unreal 4.27: classes are named by FName here (FTopLevelAssetPath is 5.1+).
		Registry.GetAssetsByClass(UWorld::StaticClass()->GetFName(), Assets, true);
		TSet<FString> Found;
		for (const FAssetData& A : Assets)
		{
			const FString Package = A.PackageName.ToString();
			if (Package.StartsWith(TEXT("/Game/"))) Found.Add(Package);
		}
		// And the .umap files in Content/ themselves: the headless editor's registry can still come back without the
		// maps (found on the PC: no levels, with plugin 0.1.22, in a project that has them).
		TArray<FString> Files;
		IFileManager::Get().FindFilesRecursive(Files, *FPaths::ProjectContentDir(), TEXT("*.umap"), true, false);
		for (const FString& F : Files)
		{
			FString Package;
			if (FPackageName::TryConvertFilenameToLongPackageName(F, Package) && Package.StartsWith(TEXT("/Game/")) && !Package.Contains(TEXT("/__ExternalActors__/")) && !Package.Contains(TEXT("/__ExternalObjects__/"))) Found.Add(Package);
		}
		TArray<FString> Sorted = Found.Array();
		Sorted.Sort();
		TArray<TSharedPtr<FJsonValue>> Items;
		for (const FString& P : Sorted) Items.Add(MakeShared<FJsonValueString>(P));
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("levels"), Items);
		return Out;
	}

	TSharedRef<FJsonObject> Read(const FString& Path)
	{
		UWorld* World = LoadLevel(Path);
		if (!World || !World->PersistentLevel) return LevelError(TEXT("No level at ") + Path);
		TArray<TSharedPtr<FJsonValue>> Items;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (!Actor || Actor->IsEditorOnly() || !Actor->GetRootComponent() || Items.Num() >= 20000) continue;
			// Unreal's own helpers (the world settings, the brush, the default physics volume) are not the scene.
			if (Actor->IsA(AWorldSettings::StaticClass()) || Actor->GetClass()->GetName().StartsWith(TEXT("Default"))) continue;
			const USceneComponent* Root = Actor->GetRootComponent();
			const FVector P = Root->GetRelativeLocation();
			const FQuat Q = Root->GetRelativeRotation().Quaternion();
			const FVector S = Root->GetRelativeScale3D();
			TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("id"), Actor->GetFName().ToString());
			Item->SetStringField(TEXT("name"), Actor->GetActorLabel());
			Item->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
			if (const AActor* Parent = Actor->GetAttachParentActor()) Item->SetStringField(TEXT("parent"), Parent->GetFName().ToString());
			Item->SetArrayField(TEXT("position"), Numbers({P.X, P.Y, P.Z}));
			Item->SetArrayField(TEXT("rotation"), Numbers({Q.X, Q.Y, Q.Z, Q.W}));
			Item->SetArrayField(TEXT("scale"), Numbers({S.X, S.Y, S.Z}));
			// What is attached to it, as Details shows it: its components' classes, and its Blueprint when it is one.
			TArray<TSharedPtr<FJsonValue>> Parts;
#if WITH_EDITORONLY_DATA
			if (Actor->GetClass()->ClassGeneratedBy) Parts.Add(MakeShared<FJsonValueString>(TEXT("Blueprint:") + Actor->GetClass()->ClassGeneratedBy->GetName()));
#endif
			TInlineComponentArray<UActorComponent*> Components(Actor);
			for (const UActorComponent* C : Components)
			{
				if (C && Parts.Num() < 40) Parts.Add(MakeShared<FJsonValueString>(C->GetClass()->GetName()));
			}
			Item->SetArrayField(TEXT("components"), Parts);
			// The materials of its meshes (unreal_inspect_level, and the old value on unreal_apply_material's card).
			const TArray<TSharedPtr<FJsonValue>> Slots = MaterialSlots(Actor);
			if (Slots.Num()) Item->SetArrayField(TEXT("slots"), Slots);
			// The folder it sits in in the Outliner.
			if (!Actor->GetFolderPath().IsNone()) Item->SetStringField(TEXT("folder"), Actor->GetFolderPath().ToString());
			// The shape: the static mesh of its root (a Static Mesh Actor), or of its first mesh component.
			const UStaticMeshComponent* MeshComp = Cast<UStaticMeshComponent>(Actor->GetRootComponent());
			if (!MeshComp) MeshComp = Actor->FindComponentByClass<UStaticMeshComponent>();
			if (MeshComp && MeshComp->GetStaticMesh())
			{
				Item->SetStringField(TEXT("mesh"), MeshComp->GetStaticMesh()->GetPathName());
				if (MeshComp != Actor->GetRootComponent())
				{
					// The mesh sits under the root at its own place: the stand-in shows it there.
					const FTransform T = MeshComp->GetComponentTransform().GetRelativeTransform(Root->GetComponentTransform());
					const FVector MP = T.GetLocation();
					const FQuat MQ = T.GetRotation();
					const FVector MS = T.GetScale3D();
					TSharedRef<FJsonObject> Off = MakeShared<FJsonObject>();
					Off->SetArrayField(TEXT("position"), Numbers({MP.X, MP.Y, MP.Z}));
					Off->SetArrayField(TEXT("rotation"), Numbers({MQ.X, MQ.Y, MQ.Z, MQ.W}));
					Off->SetArrayField(TEXT("scale"), Numbers({MS.X, MS.Y, MS.Z}));
					Item->SetObjectField(TEXT("meshAt"), Off);
				}
			}
			Items.Add(MakeShared<FJsonValueObject>(Item));
		}
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("path"), World->GetOutermost()->GetName());
		Out->SetArrayField(TEXT("actors"), Items);
		// World Partition (most actors in their own files, loaded by region) is Unreal 5 only: every 4.27 level is whole.
		Out->SetBoolField(TEXT("partitioned"), false);
		return Out;
	}

	TSharedRef<FJsonObject> Mesh(const FString& Path)
	{
		if (!Path.StartsWith(TEXT("/Game/")) && !Path.StartsWith(TEXT("/Engine/"))) return LevelError(TEXT("A mesh under /Game or /Engine."));
		UStaticMesh* SM = LoadObject<UStaticMesh>(nullptr, *Path);
		if (!SM) return LevelError(TEXT("No static mesh at ") + Path);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		const FBox B = SM->GetBoundingBox();
		Out->SetArrayField(TEXT("min"), Numbers({B.Min.X, B.Min.Y, B.Min.Z}));
		Out->SetArrayField(TEXT("max"), Numbers({B.Max.X, B.Max.Y, B.Max.Z}));
#if WITH_EDITORONLY_DATA
		// The lightest LOD that has its source (Nanite meshes and LOD 0 included): three corners per triangle, in cm.
		const FMeshDescription* MD = nullptr;
		for (int32 Lod = SM->GetNumSourceModels() - 1; Lod >= 0 && !MD; --Lod) MD = SM->GetMeshDescription(Lod);
		if (MD && MD->Triangles().Num() <= 30000)
		{
			FStaticMeshConstAttributes Attributes(*MD);
			// Positions are FVector in 4.27 and FVector3f in 5.x: auto takes whichever this engine has.
			const auto Positions = Attributes.GetVertexPositions();
			TArray<float> Corners;
			Corners.Reserve(MD->Triangles().Num() * 9);
			for (const FTriangleID T : MD->Triangles().GetElementIDs())
			{
				for (const FVertexInstanceID VI : MD->GetTriangleVertexInstances(T))
				{
					const FVector V = Positions[MD->GetVertexInstanceVertex(VI)];
					Corners.Add(V.X);
					Corners.Add(V.Y);
					Corners.Add(V.Z);
				}
			}
			// FBase64::Encode(const TArray<uint8>&) is the overload every 4.2x engine has.
			TArray<uint8> Bytes;
			Bytes.Append(reinterpret_cast<const uint8*>(Corners.GetData()), Corners.Num() * sizeof(float));
			Out->SetStringField(TEXT("corners"), FBase64::Encode(Bytes));
		}
#endif
		return Out;
	}

	TSharedRef<FJsonObject> Move(const FString& Path, const TArray<TSharedPtr<FJsonValue>>& Moves, bool bSave)
	{
		UWorld* World = LoadLevel(Path);
		if (!World || !World->PersistentLevel) return LevelError(TEXT("No level at ") + Path);
		TMap<FString, AActor*> ByName;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (Actor) ByName.Add(Actor->GetFName().ToString(), Actor);
		}
		TArray<TSharedPtr<FJsonValue>> Clashes, Missing;
		TArray<UPackage*> Packages;
		int32 Done = 0;
		{
			const FScopedTransaction Transaction(NSLOCTEXT("KesherAI", "StandInMoves", "KesherAI: moves from the stand-in"));
			for (const TSharedPtr<FJsonValue>& V : Moves)
			{
				const TSharedPtr<FJsonObject> M = V.IsValid() ? V->AsObject() : nullptr;
				FString Id;
				if (!M.IsValid() || !M->TryGetStringField(TEXT("id"), Id)) continue;
				AActor** Found = ByName.Find(Id);
				USceneComponent* Root = Found && *Found ? (*Found)->GetRootComponent() : nullptr;
				const TSharedPtr<FJsonObject>* From = nullptr;
				const TSharedPtr<FJsonObject>* To = nullptr;
				FVector FromP, ToP, ToS;
				FQuat FromQ, ToQ;
				if (!Root || !M->TryGetObjectField(TEXT("from"), From) || !M->TryGetObjectField(TEXT("to"), To) || !Read3(*From, TEXT("position"), FromP) || !Read4(*From, TEXT("rotation"), FromQ) || !Read3(*To, TEXT("position"), ToP) || !Read4(*To, TEXT("rotation"), ToQ) || !Read3(*To, TEXT("scale"), ToS))
				{
					Missing.Add(MakeShared<FJsonValueString>(Id));
					continue;
				}
				// Moved in Unreal too since the stand-in was made: Unreal's place stays.
				if (FVector::Dist(Root->GetRelativeLocation(), FromP) > 0.1 || Root->GetRelativeRotation().Quaternion().AngularDistance(FromQ.GetNormalized()) > 0.001)
				{
					Clashes.Add(MakeShared<FJsonValueString>((*Found)->GetActorLabel()));
					continue;
				}
				(*Found)->Modify();
				Root->Modify();
				Root->SetRelativeTransform(FTransform(ToQ.GetNormalized(), ToP, ToS));
				(*Found)->PostEditMove(true);
				// GetOutermost() is the package in every engine version (UObject::GetPackage is newer).
				Packages.AddUnique((*Found)->GetOutermost());
				++Done;
			}
		}
		bool bSaved = false;
		// The editor closed (the commandlet): nothing stays open to save it later, so the level is saved now.
		if (bSave && Done > 0) bSaved = UEditorLoadingAndSavingUtils::SavePackages(Packages, false);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetNumberField(TEXT("moved"), Done);
		Out->SetArrayField(TEXT("clashes"), Clashes);
		Out->SetArrayField(TEXT("missing"), Missing);
		Out->SetBoolField(TEXT("saved"), bSaved);
		return Out;
	}

	TSharedRef<FJsonObject> SetMaterial(const FString& Path, const FString& ActorKey, const FString& ComponentName, const FString& SlotKey, const FString& MaterialPath, bool bSave)
	{
		UWorld* World = LoadLevel(Path);
		if (!World || !World->PersistentLevel) return LevelError(TEXT("No level at ") + Path);
		AActor* Actor = nullptr;
		for (AActor* A : World->PersistentLevel->Actors)
		{
			if (A && (A->GetFName().ToString() == ActorKey || A->GetActorLabel() == ActorKey)) { Actor = A; break; }
		}
		if (!Actor) return LevelError(TEXT("No actor ") + ActorKey + TEXT(" in ") + Path);
		UMeshComponent* Mesh = nullptr;
		TInlineComponentArray<UMeshComponent*> Meshes(Actor);
		for (UMeshComponent* M : Meshes)
		{
			if (M && (ComponentName.IsEmpty() || M->GetName() == ComponentName)) { Mesh = M; break; }
		}
		if (!Mesh) return LevelError(ComponentName.IsEmpty() ? ActorKey + TEXT(" has no mesh component.") : TEXT("No mesh component ") + ComponentName + TEXT(" on ") + ActorKey);
		int32 Index = INDEX_NONE;
		if (SlotKey.IsNumeric()) Index = FCString::Atoi(*SlotKey);
		else Index = Mesh->GetMaterialIndex(FName(*SlotKey));
		if (Index < 0 || Index >= Mesh->GetNumMaterials()) return LevelError(TEXT("No material slot ") + SlotKey + TEXT(" on ") + Mesh->GetName());
		if (!MaterialPath.StartsWith(TEXT("/Game/")) && !MaterialPath.StartsWith(TEXT("/Engine/"))) return LevelError(TEXT("A material under /Game or /Engine."));
		UMaterialInterface* Material = LoadObject<UMaterialInterface>(nullptr, *MaterialPath);
		if (!Material) return LevelError(TEXT("No material or material instance at ") + MaterialPath);
		const UMaterialInterface* Old = Mesh->GetMaterial(Index);
		{
			const FScopedTransaction Transaction(NSLOCTEXT("KesherAI", "ApplyMaterial", "KesherAI: apply a material"));
			Actor->Modify();
			Mesh->Modify();
			Mesh->SetMaterial(Index, Material);
			Actor->PostEditChange();
		}
		bool bSaved = false;
		// The editor closed (the commandlet): the level is saved now; open, she saves it.
		if (bSave) bSaved = UEditorLoadingAndSavingUtils::SavePackages({Actor->GetOutermost()}, false);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("actor"), Actor->GetActorLabel());
		Out->SetStringField(TEXT("component"), Mesh->GetName());
		Out->SetNumberField(TEXT("slot"), Index);
		Out->SetStringField(TEXT("from"), Old ? Old->GetPathName() : FString());
		Out->SetStringField(TEXT("to"), Material->GetPathName());
		Out->SetBoolField(TEXT("saved"), bSaved);
		return Out;
	}
}
