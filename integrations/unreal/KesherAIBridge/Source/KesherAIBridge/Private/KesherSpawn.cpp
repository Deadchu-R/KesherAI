// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherSpawn.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Components/LightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "GameFramework/Actor.h"
#include "IAssetTools.h"
#include "Misc/PackageName.h"
#include "ScopedTransaction.h"
#include "UObject/UnrealType.h"

namespace
{
	TSharedRef<FJsonObject> SpawnError(const FString& Text)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Text);
		return Out;
	}

	/** Only engine, project and class paths are loaded; never a path that climbs out with "..". */
	bool SafePath(const FString& Path)
	{
		return (Path.StartsWith(TEXT("/Game/")) || Path.StartsWith(TEXT("/Engine/")) || Path.StartsWith(TEXT("/Script/")) || Path.StartsWith(TEXT("/Niagara/"))) && !Path.Contains(TEXT(".."));
	}

	/** "/Game/Maps/Level1" → the level: the open one when it is the editor's, else loaded (as KesherLevel). */
	UWorld* LoadWorld(const FString& Path)
	{
		FString Package = Path;
		Package.Split(TEXT("."), &Package, nullptr);
		if (!Package.StartsWith(TEXT("/Game/")) || Package.Contains(TEXT(".."))) return nullptr;
		if (GEditor)
		{
			UWorld* Open = GEditor->GetEditorWorldContext().World();
			if (Open && Open->GetOutermost()->GetName() == Package) return Open;
		}
		return LoadObject<UWorld>(nullptr, *(Package + TEXT(".") + FPackageName::GetShortName(Package)));
	}

	bool Read3(const TSharedPtr<FJsonObject>& O, const TCHAR* Key, FVector& Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* A = nullptr;
		if (!O->TryGetArrayField(Key, A) || A->Num() != 3) return false;
		Out = FVector((*A)[0]->AsNumber(), (*A)[1]->AsNumber(), (*A)[2]->AsNumber());
		return true;
	}

	/** "/Game/X/Y" → "/Game/X/Y.Y" (an object path), left as is when it already names the object. */
	FString ObjectPath(const FString& Path)
	{
		return Path.Contains(TEXT(".")) ? Path : Path + TEXT(".") + FPackageName::GetShortName(Path);
	}
}

namespace KesherSpawn
{
	TSharedRef<FJsonObject> Spawn(const FString& Level, const TArray<TSharedPtr<FJsonValue>>& Actors, bool bSave)
	{
		UWorld* World = LoadWorld(Level);
		if (!World || !World->PersistentLevel) return SpawnError(TEXT("No level at ") + Level);
		TArray<TSharedPtr<FJsonValue>> Missing;
		TArray<UPackage*> Packages;
		int32 Done = 0;
		{
			const FScopedTransaction Transaction(NSLOCTEXT("KesherAI", "Blockout", "KesherAI: block-out"));
			for (const TSharedPtr<FJsonValue>& V : Actors)
			{
				const TSharedPtr<FJsonObject> A = V.IsValid() ? V->AsObject() : nullptr;
				if (!A.IsValid()) continue;
				FString Name, Mesh, Asset, Class, Folder, Color;
				A->TryGetStringField(TEXT("name"), Name);
				A->TryGetStringField(TEXT("mesh"), Mesh);
				A->TryGetStringField(TEXT("asset"), Asset);
				A->TryGetStringField(TEXT("class"), Class);
				A->TryGetStringField(TEXT("folder"), Folder);
				FVector Loc = FVector::ZeroVector, Rot = FVector::ZeroVector, Scale = FVector::OneVector;
				Read3(A, TEXT("location"), Loc);
				Read3(A, TEXT("rotation"), Rot);
				Read3(A, TEXT("scale"), Scale);
				const FTransform Xf(FRotator(Rot.X, Rot.Y, Rot.Z), Loc, Scale);
				FActorSpawnParameters Params;
				Params.OverrideLevel = World->PersistentLevel;
				AActor* Actor = nullptr;
				if (!Asset.IsEmpty())
				{
					// A Blueprint (its generated class) or a static mesh (a static mesh actor showing it).
					UObject* Obj = SafePath(Asset) ? LoadObject<UObject>(nullptr, *ObjectPath(Asset)) : nullptr;
					if (UBlueprint* BP = Cast<UBlueprint>(Obj)) { if (BP->GeneratedClass) Actor = World->SpawnActor<AActor>(BP->GeneratedClass, Xf, Params); }
					else if (UStaticMesh* SM = Cast<UStaticMesh>(Obj)) Mesh = SM->GetPathName();
					if (!Actor && Mesh.IsEmpty()) { Missing.Add(MakeShared<FJsonValueString>(Asset)); continue; }
				}
				if (!Actor && !Class.IsEmpty())
				{
					UClass* C = SafePath(Class) ? LoadObject<UClass>(nullptr, *Class) : nullptr;
					if (!C || !C->IsChildOf(AActor::StaticClass())) { Missing.Add(MakeShared<FJsonValueString>(Class)); continue; }
					Actor = World->SpawnActor<AActor>(C, Xf, Params);
				}
				if (!Actor && !Mesh.IsEmpty())
				{
					UStaticMesh* SM = SafePath(Mesh) ? LoadObject<UStaticMesh>(nullptr, *ObjectPath(Mesh)) : nullptr;
					if (!SM) { Missing.Add(MakeShared<FJsonValueString>(Mesh)); continue; }
					AStaticMeshActor* SMA = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), Xf, Params);
					if (SMA)
					{
						SMA->GetStaticMeshComponent()->SetStaticMesh(SM);
						SMA->SetMobility(EComponentMobility::Static);
					}
					Actor = SMA;
				}
				if (!Actor) continue;
				// Brush volumes (NavMeshBoundsVolume) and some classes ignore the spawn transform's scale.
				Actor->SetActorScale3D(Scale);
				if (ULightComponent* Light = Actor->FindComponentByClass<ULightComponent>())
				{
					double Intensity = 0;
					if (A->TryGetNumberField(TEXT("intensity"), Intensity)) Light->SetIntensity(Intensity);
					if (A->TryGetStringField(TEXT("color"), Color)) Light->SetLightColor(FLinearColor(FColor::FromHex(Color)));
				}
				if (!Name.IsEmpty()) Actor->SetActorLabel(Name);
				if (!Folder.IsEmpty()) Actor->SetFolderPath(FName(*Folder));
				Actor->PostEditChange();
				Packages.AddUnique(Actor->GetPackage());
				++Done;
			}
		}
		// The editor closed (the commandlet): the level (or each actor's own file) is saved now; open, she saves it.
		bool bSaved = false;
		if (bSave && Done > 0) bSaved = UEditorLoadingAndSavingUtils::SavePackages(Packages, false);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetNumberField(TEXT("spawned"), Done);
		Out->SetArrayField(TEXT("missing"), Missing);
		Out->SetBoolField(TEXT("saved"), bSaved);
		return Out;
	}

	TSharedRef<FJsonObject> CreateVfx(const TSharedPtr<FJsonObject>& In, bool bSave)
	{
		FString Path, Template, Level;
		In->TryGetStringField(TEXT("path"), Path);
		In->TryGetStringField(TEXT("template"), Template);
		In->TryGetStringField(TEXT("level"), Level);
		if (!Path.StartsWith(TEXT("/Game/")) || Path.Contains(TEXT(".."))) return SpawnError(TEXT("The new effect's path is under /Game."));
		UClass* SystemClass = LoadObject<UClass>(nullptr, TEXT("/Script/Niagara.NiagaraSystem"));
		if (!SystemClass) return SpawnError(TEXT("The Niagara plugin is off in this project (Edit > Plugins > Niagara)."));
		// The template: an asset path, or a name looked up among the Niagara systems under /Niagara.
		UObject* Source = nullptr;
		if (Template.StartsWith(TEXT("/"))) Source = SafePath(Template) ? LoadObject<UObject>(nullptr, *ObjectPath(Template)) : nullptr;
		else
		{
			IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
			TArray<FAssetData> Found;
			Registry.GetAssetsByPath(FName(TEXT("/Niagara")), Found, true);
			for (const FAssetData& D : Found)
			{
				if (D.AssetName.ToString() == Template && D.GetClass() && D.GetClass()->IsChildOf(SystemClass)) { Source = D.GetAsset(); break; }
			}
		}
		if (!Source || !Source->IsA(SystemClass)) return SpawnError(TEXT("No Niagara system template ") + Template + TEXT(": name one with template (/Game/… or /Niagara/…)."));
		IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get();
		UObject* Copy = Tools.DuplicateAsset(FPackageName::GetShortName(Path), FPackageName::GetLongPackagePath(Path), Source);
		if (!Copy) return SpawnError(TEXT("Could not make ") + Path + TEXT(" (does it exist already?)."));
		TArray<UPackage*> Packages = {Copy->GetPackage()};
		FString Placed;
		if (!Level.IsEmpty())
		{
			UWorld* World = LoadWorld(Level);
			UClass* ActorClass = LoadObject<UClass>(nullptr, TEXT("/Script/Niagara.NiagaraActor"));
			if (World && World->PersistentLevel && ActorClass)
			{
				FVector Loc = FVector::ZeroVector;
				Read3(In, TEXT("location"), Loc);
				const FScopedTransaction Transaction(NSLOCTEXT("KesherAI", "PlaceVfx", "KesherAI: place an effect"));
				FActorSpawnParameters Params;
				Params.OverrideLevel = World->PersistentLevel;
				AActor* Actor = World->SpawnActor<AActor>(ActorClass, FTransform(Loc), Params);
				// The actor's Niagara component gets the new system through reflection (its `Asset` property).
				UActorComponent* Comp = Actor ? Actor->GetComponentByClass(LoadObject<UClass>(nullptr, TEXT("/Script/Niagara.NiagaraComponent"))) : nullptr;
				if (FObjectProperty* Prop = Comp ? FindFProperty<FObjectProperty>(Comp->GetClass(), TEXT("Asset")) : nullptr)
				{
					Comp->Modify();
					Prop->SetObjectPropertyValue_InContainer(Comp, Copy);
					Comp->PostEditChange();
				}
				if (Actor)
				{
					Actor->SetActorLabel(FPackageName::GetShortName(Path));
					Actor->SetFolderPath(FName(TEXT("KesherVFX")));
					Placed = Actor->GetActorLabel();
					Packages.AddUnique(Actor->GetPackage());
				}
			}
		}
		bool bSaved = false;
		if (bSave) bSaved = UEditorLoadingAndSavingUtils::SavePackages(Packages, false);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("asset"), Copy->GetPathName());
		Out->SetStringField(TEXT("template"), Source->GetPathName());
		if (!Placed.IsEmpty()) Out->SetStringField(TEXT("placed"), Placed);
		Out->SetBoolField(TEXT("saved"), bSaved);
		return Out;
	}
}
