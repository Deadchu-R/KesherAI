// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherLevel.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "GameFramework/Actor.h"
#include "GameFramework/WorldSettings.h"
#include "Misc/Base64.h"
#include "ScopedTransaction.h"
#include "StaticMeshAttributes.h"
#include "WorldPartition/WorldPartition.h"

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
		TArray<FAssetData> Assets;
		Registry.GetAssetsByClass(UWorld::StaticClass()->GetClassPathName(), Assets, true);
		TArray<TSharedPtr<FJsonValue>> Items;
		for (const FAssetData& A : Assets)
		{
			const FString Package = A.PackageName.ToString();
			if (Package.StartsWith(TEXT("/Game/"))) Items.Add(MakeShared<FJsonValueString>(Package));
		}
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
		// A World Partition level keeps most actors in their own files, loaded by region: only the loaded ones are here.
		Out->SetBoolField(TEXT("partitioned"), World->GetWorldPartition() != nullptr);
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
			TVertexAttributesConstRef<FVector3f> Positions = Attributes.GetVertexPositions();
			TArray<float> Corners;
			Corners.Reserve(MD->Triangles().Num() * 9);
			for (const FTriangleID T : MD->Triangles().GetElementIDs())
			{
				for (const FVertexInstanceID VI : MD->GetTriangleVertexInstances(T))
				{
					const FVector3f V = Positions[MD->GetVertexInstanceVertex(VI)];
					Corners.Add(V.X);
					Corners.Add(V.Y);
					Corners.Add(V.Z);
				}
			}
			Out->SetStringField(TEXT("corners"), FBase64::Encode(reinterpret_cast<const uint8*>(Corners.GetData()), Corners.Num() * sizeof(float)));
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
				Packages.AddUnique((*Found)->GetPackage());
				++Done;
			}
		}
		bool bSaved = false;
		// The editor closed (the commandlet): nothing stays open to save it later, so the level (and, in a World
		// Partition level, each actor's own file) is saved now.
		if (bSave && Done > 0) bSaved = UEditorLoadingAndSavingUtils::SavePackages(Packages, false);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetNumberField(TEXT("moved"), Done);
		Out->SetArrayField(TEXT("clashes"), Clashes);
		Out->SetArrayField(TEXT("missing"), Missing);
		Out->SetBoolField(TEXT("saved"), bSaved);
		return Out;
	}
}
