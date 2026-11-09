// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherWidget.h"

#include "AssetImportTask.h"
#include "AssetToolsModule.h"
#include "Blueprint/WidgetTree.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/PanelSlot.h"
#include "Components/PanelWidget.h"
#include "Components/TextBlock.h"
#include "Components/Widget.h"
#include "Fonts/SlateFontInfo.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "ScopedTransaction.h"
#include "UObject/UnrealType.h"
#include "WidgetBlueprint.h"

#define LOCTEXT_NAMESPACE "KesherAIBridge"

namespace
{
	TSharedRef<FJsonObject> WidgetError(const FString& Message)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Message);
		return Out;
	}

	UWidgetBlueprint* LoadWidgetBlueprint(const FString& Path)
	{
		return LoadObject<UWidgetBlueprint>(nullptr, *Path);
	}

	/** The properties worth showing and changing (the rest of UMG's are long or internal). */
	const TCHAR* const Readable[] = {
		TEXT("Text"), TEXT("ColorAndOpacity"), TEXT("Justification"), TEXT("AutoWrapText"),
		TEXT("Brush"), TEXT("BrushColor"), TEXT("BackgroundColor"), TEXT("ContentColorAndOpacity"),
		TEXT("Padding"), TEXT("WidthOverride"), TEXT("HeightOverride"), TEXT("MinDesiredWidth"), TEXT("MinDesiredHeight"),
		TEXT("Percent"), TEXT("FillColorAndOpacity"), TEXT("Visibility"), TEXT("RenderOpacity"), TEXT("bIsEnabled"),
		TEXT("ToolTipText"),
	};

	FString ExportProperty(FProperty* P, const void* Container, UObject* Owner)
	{
		FString Value;
		P->ExportTextItem_Direct(Value, P->ContainerPtrToValuePtr<void>(Container), nullptr, Owner, PPF_None);
		return Value.Len() > 400 ? Value.Left(400) + TEXT("…") : Value;
	}

	bool ImportProperty(UObject* Owner, const FString& Name, const FString& Value, FString& Problem)
	{
		FProperty* P = FindFProperty<FProperty>(Owner->GetClass(), *Name);
		if (!P)
		{
			Problem = TEXT("No property ") + Name + TEXT(" on ") + Owner->GetClass()->GetName();
			return false;
		}
		Owner->Modify();
		if (!P->ImportText_Direct(*Value, P->ContainerPtrToValuePtr<void>(Owner), Owner, PPF_None))
		{
			Problem = TEXT("Could not set ") + Name + TEXT(" to ") + Value;
			return false;
		}
		FPropertyChangedEvent Changed(P);
		Owner->PostEditChangeProperty(Changed);
		return true;
	}

	/** A text block's font size (FSlateFontInfo.Size), read and written through reflection. */
	FSlateFontInfo* FontOf(UWidget* W)
	{
		UTextBlock* T = Cast<UTextBlock>(W);
		FStructProperty* P = T ? FindFProperty<FStructProperty>(UTextBlock::StaticClass(), TEXT("Font")) : nullptr;
		return P && P->Struct == FSlateFontInfo::StaticStruct() ? P->ContainerPtrToValuePtr<FSlateFontInfo>(T) : nullptr;
	}

	TSharedRef<FJsonObject> Describe(UWidget* W)
	{
		TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
		J->SetStringField(TEXT("name"), W->GetName());
		J->SetStringField(TEXT("class"), W->GetClass()->GetName());
		TSharedRef<FJsonObject> Props = MakeShared<FJsonObject>();
		for (const TCHAR* Name : Readable)
		{
			if (FProperty* P = FindFProperty<FProperty>(W->GetClass(), Name)) Props->SetStringField(Name, ExportProperty(P, W, W));
		}
		if (FSlateFontInfo* Font = FontOf(W)) Props->SetNumberField(TEXT("fontSize"), Font->Size);
		J->SetObjectField(TEXT("props"), Props);

		if (UPanelSlot* Slot = W->Slot)
		{
			TSharedRef<FJsonObject> S = MakeShared<FJsonObject>();
			S->SetStringField(TEXT("class"), Slot->GetClass()->GetName());
			if (UCanvasPanelSlot* C = Cast<UCanvasPanelSlot>(Slot))
			{
				const FAnchorData L = C->GetLayout();
				S->SetNumberField(TEXT("x"), L.Offsets.Left);
				S->SetNumberField(TEXT("y"), L.Offsets.Top);
				S->SetNumberField(TEXT("w"), L.Offsets.Right);
				S->SetNumberField(TEXT("h"), L.Offsets.Bottom);
				S->SetNumberField(TEXT("anchorMinX"), L.Anchors.Minimum.X);
				S->SetNumberField(TEXT("anchorMinY"), L.Anchors.Minimum.Y);
				S->SetNumberField(TEXT("anchorMaxX"), L.Anchors.Maximum.X);
				S->SetNumberField(TEXT("anchorMaxY"), L.Anchors.Maximum.Y);
				S->SetNumberField(TEXT("alignX"), L.Alignment.X);
				S->SetNumberField(TEXT("alignY"), L.Alignment.Y);
				S->SetBoolField(TEXT("autoSize"), C->GetAutoSize());
				S->SetNumberField(TEXT("z"), C->GetZOrder());
			}
			else
			{
				// Box, overlay, border, size box slots: their few editable fields as text (Padding, Size, alignment…).
				for (TFieldIterator<FProperty> It(Slot->GetClass()); It; ++It)
				{
					if (It->HasAnyPropertyFlags(CPF_Edit) && !It->GetName().Equals(TEXT("Parent")) && !It->GetName().Equals(TEXT("Content")))
						S->SetStringField(It->GetName(), ExportProperty(*It, Slot, Slot));
				}
			}
			J->SetObjectField(TEXT("slot"), S);
		}

		if (UPanelWidget* Panel = Cast<UPanelWidget>(W))
		{
			TArray<TSharedPtr<FJsonValue>> Kids;
			for (int32 I = 0; I < Panel->GetChildrenCount(); ++I)
			{
				if (UWidget* Child = Panel->GetChildAt(I)) Kids.Add(MakeShared<FJsonValueObject>(Describe(Child)));
			}
			J->SetArrayField(TEXT("children"), Kids);
		}
		return J;
	}

	UClass* WidgetClass(const FString& Name)
	{
		UClass* C = Name.StartsWith(TEXT("/")) ? LoadObject<UClass>(nullptr, *Name) : FindFirstObject<UClass>(*Name, EFindFirstObjectOptions::None);
		if (!C && !Name.StartsWith(TEXT("U"))) C = FindFirstObject<UClass>(*(TEXT("U") + Name), EFindFirstObjectOptions::None);
		return C && C->IsChildOf(UWidget::StaticClass()) && !C->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated) ? C : nullptr;
	}

	bool SetCanvas(UCanvasPanelSlot* C, const FString& Field, const FString& Value)
	{
		TArray<FString> Parts;
		Value.ParseIntoArray(Parts, TEXT(","));
		auto N = [&](int32 I) { return Parts.IsValidIndex(I) ? FCString::Atof(*Parts[I].TrimStartAndEnd()) : 0.f; };
		C->Modify();
		if (Field == TEXT("position") && Parts.Num() == 2) C->SetPosition(FVector2D(N(0), N(1)));
		else if (Field == TEXT("size") && Parts.Num() == 2) C->SetSize(FVector2D(N(0), N(1)));
		else if (Field == TEXT("anchors") && Parts.Num() == 4) C->SetAnchors(FAnchors(N(0), N(1), N(2), N(3)));
		else if (Field == TEXT("alignment") && Parts.Num() == 2) C->SetAlignment(FVector2D(N(0), N(1)));
		else if (Field == TEXT("autoSize")) C->SetAutoSize(Value.ToBool());
		else if (Field == TEXT("z")) C->SetZOrder(FCString::Atoi(*Value));
		else return false;
		return true;
	}
}

namespace KesherWidget
{
	TSharedRef<FJsonObject> Read(const FString& Path)
	{
		UWidgetBlueprint* BP = LoadWidgetBlueprint(Path);
		if (!BP) return WidgetError(TEXT("No Widget Blueprint at ") + Path);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("path"), Path);
		Out->SetStringField(TEXT("name"), BP->GetName());
		if (BP->WidgetTree && BP->WidgetTree->RootWidget) Out->SetObjectField(TEXT("root"), Describe(BP->WidgetTree->RootWidget));
		return Out;
	}

	TSharedRef<FJsonObject> ImportTexture(const FString& File, const FString& Folder, const FString& Name)
	{
		if (!File.EndsWith(TEXT(".png"), ESearchCase::IgnoreCase) || !IFileManager::Get().FileExists(*File)) return WidgetError(TEXT("No PNG at ") + File);
		if (!Folder.StartsWith(TEXT("/Game/")) || Folder.Contains(TEXT(".."))) return WidgetError(TEXT("Textures go under /Game/"));
		UAssetImportTask* Task = NewObject<UAssetImportTask>();
		Task->Filename = File;
		Task->DestinationPath = Folder;
		Task->DestinationName = Name;
		Task->bAutomated = true;
		Task->bReplaceExisting = true;
		Task->bSave = true;
		FAssetToolsModule& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
		Tools.Get().ImportAssetTasks({ Task });
		if (Task->ImportedObjectPaths.Num() == 0) return WidgetError(TEXT("Unreal did not import ") + FPaths::GetCleanFilename(File));
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("asset"), Task->ImportedObjectPaths[0]);
		return Out;
	}

	TSharedRef<FJsonObject> Apply(const FString& Path, const TArray<TSharedPtr<FJsonValue>>& Ops)
	{
		UWidgetBlueprint* BP = LoadWidgetBlueprint(Path);
		if (!BP || !BP->WidgetTree) return WidgetError(TEXT("No Widget Blueprint at ") + Path);
		UWidgetTree* Tree = BP->WidgetTree;
		const FScopedTransaction Transaction(LOCTEXT("KesherWidgetEdit", "KesherAI: change widgets"));
		BP->Modify();
		Tree->Modify();

		TArray<TSharedPtr<FJsonValue>> Results;
		int32 Failed = 0;
		for (const TSharedPtr<FJsonValue>& V : Ops)
		{
			const TSharedPtr<FJsonObject> Op = V.IsValid() ? V->AsObject() : nullptr;
			if (!Op.IsValid()) continue;
			FString Kind, Name, Problem;
			Op->TryGetStringField(TEXT("op"), Kind);
			Op->TryGetStringField(TEXT("widget"), Name);
			UWidget* W = Name.IsEmpty() ? nullptr : Tree->FindWidget(FName(*Name));

			if (Kind == TEXT("add"))
			{
				FString ClassName, Parent, NewName;
				Op->TryGetStringField(TEXT("class"), ClassName);
				Op->TryGetStringField(TEXT("parent"), Parent);
				Op->TryGetStringField(TEXT("name"), NewName);
				UClass* C = WidgetClass(ClassName);
				UPanelWidget* P = Parent.IsEmpty() ? nullptr : Cast<UPanelWidget>(Tree->FindWidget(FName(*Parent)));
				if (!C) Problem = TEXT("No widget class ") + ClassName;
				else if (!Parent.IsEmpty() && !P) Problem = TEXT("No panel named ") + Parent;
				else if (!P && Tree->RootWidget) Problem = TEXT("Say which panel it goes in (parent)");
				else if (P && !P->CanAddMoreChildren()) Problem = Parent + TEXT(" takes no more children");
				else
				{
					const FName Unique = NewName.IsEmpty() || Tree->FindWidget(FName(*NewName)) ? MakeUniqueObjectName(Tree, C, FName(*(NewName.IsEmpty() ? C->GetName() : NewName))) : FName(*NewName);
					UWidget* Made = Tree->ConstructWidget<UWidget>(C, Unique);
					if (P)
					{
						P->Modify();
						P->AddChild(Made);
					}
					else Tree->RootWidget = Made;
					Name = Made->GetName();
				}
			}
			else if (!W) Problem = TEXT("No widget named ") + Name;
			else if (Kind == TEXT("set"))
			{
				FString Property, Value;
				Op->TryGetStringField(TEXT("property"), Property);
				Op->TryGetStringField(TEXT("value"), Value);
				if (Property == TEXT("fontSize"))
				{
					if (FSlateFontInfo* Font = FontOf(W))
					{
						W->Modify();
						Font->Size = FCString::Atoi(*Value);
						W->SynchronizeProperties();
					}
					else Problem = TEXT("Only a Text Block has a font size");
				}
				else if (Property.StartsWith(TEXT("slot.")))
				{
					const FString Field = Property.Mid(5);
					if (!W->Slot) Problem = TEXT("This widget has no slot (it is the root)");
					else if (UCanvasPanelSlot* C = Cast<UCanvasPanelSlot>(W->Slot))
					{
						if (!SetCanvas(C, Field, Value)) ImportProperty(C, Field, Value, Problem);
					}
					else if (ImportProperty(W->Slot, Field, Value, Problem)) W->Slot->SynchronizeProperties();
				}
				else if (UTextBlock* T = Property == TEXT("Text") ? Cast<UTextBlock>(W) : nullptr)
				{
					T->Modify();
					T->SetText(FText::FromString(Value));
				}
				else if (ImportProperty(W, Property, Value, Problem)) W->SynchronizeProperties();
			}
			else if (Kind == TEXT("remove"))
			{
				if (W == Tree->RootWidget) Tree->RootWidget = nullptr;
				else W->RemoveFromParent();
				Tree->RemoveWidget(W);
			}
			else if (Kind == TEXT("move"))
			{
				FString Parent;
				Op->TryGetStringField(TEXT("parent"), Parent);
				int32 Index = -1;
				Op->TryGetNumberField(TEXT("index"), Index);
				UPanelWidget* P = Cast<UPanelWidget>(Tree->FindWidget(FName(*Parent)));
				if (!P) Problem = TEXT("No panel named ") + Parent;
				else if (P == W || (W->IsA<UPanelWidget>() && P->IsChildOf(W))) Problem = TEXT("A widget cannot go inside itself");
				else
				{
					W->Modify();
					P->Modify();
					W->RemoveFromParent();
					if (Index >= 0 && Index < P->GetChildrenCount()) P->InsertChildAt(Index, W);
					else P->AddChild(W);
				}
			}
			else Problem = TEXT("Unknown operation ") + Kind;

			TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
			R->SetStringField(TEXT("op"), Kind);
			R->SetBoolField(TEXT("ok"), Problem.IsEmpty());
			if (!Name.IsEmpty()) R->SetStringField(TEXT("widget"), Name);
			if (!Problem.IsEmpty())
			{
				R->SetStringField(TEXT("error"), Problem);
				Failed++;
			}
			Results.Add(MakeShared<FJsonValueObject>(R));
		}
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("results"), Results);
		Out->SetNumberField(TEXT("failed"), Failed);
		return Out;
	}
}

#undef LOCTEXT_NAMESPACE
