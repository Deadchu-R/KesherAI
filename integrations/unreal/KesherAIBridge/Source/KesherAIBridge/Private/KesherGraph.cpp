// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

#include "KesherGraph.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "FileHelpers.h"
#include "K2Node_CallFunction.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_Event.h"
#include "K2Node_ExecutionSequence.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_Variable.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Logging/TokenizedMessage.h"
#include "Misc/PackageName.h"
#include "ScopedTransaction.h"
#include "Subsystems/AssetEditorSubsystem.h"

#define LOCTEXT_NAMESPACE "KesherAIBridge"

namespace
{
	TSharedRef<FJsonObject> BridgeError(const FString& Message)
	{
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("error"), Message);
		return Out;
	}

	UBlueprint* LoadBlueprint(const FString& Path)
	{
		return LoadObject<UBlueprint>(nullptr, *Path);
	}

	void AllGraphs(UBlueprint* BP, TArray<TPair<UEdGraph*, FString>>& Out)
	{
		for (UEdGraph* G : BP->UbergraphPages) { if (G) Out.Add({ G, TEXT("event") }); }
		for (UEdGraph* G : BP->FunctionGraphs) { if (G) Out.Add({ G, TEXT("function") }); }
		for (UEdGraph* G : BP->MacroGraphs) { if (G) Out.Add({ G, TEXT("macro") }); }
	}

	UEdGraph* FindGraph(UBlueprint* BP, const FString& Name)
	{
		TArray<TPair<UEdGraph*, FString>> Graphs;
		AllGraphs(BP, Graphs);
		for (const TPair<UEdGraph*, FString>& G : Graphs)
		{
			if (Name.IsEmpty() || G.Key->GetName().Equals(Name, ESearchCase::IgnoreCase)) return G.Key;
		}
		return nullptr;
	}

	FString PinTypeName(const UEdGraphPin* Pin)
	{
		FString Type = Pin->PinType.PinCategory.ToString();
		if (UObject* Sub = Pin->PinType.PinSubCategoryObject.Get()) Type += TEXT(":") + Sub->GetName();
		if (Pin->PinType.ContainerType == EPinContainerType::Array) Type += TEXT("[]");
		return Type;
	}

	TSharedRef<FJsonObject> NodeJson(UEdGraphNode* Node)
	{
		TSharedRef<FJsonObject> N = MakeShared<FJsonObject>();
		N->SetStringField(TEXT("id"), Node->NodeGuid.ToString());
		N->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
		N->SetStringField(TEXT("class"), Node->GetClass()->GetName());
		N->SetNumberField(TEXT("x"), Node->NodePosX);
		N->SetNumberField(TEXT("y"), Node->NodePosY);
		if (!Node->NodeComment.IsEmpty()) N->SetStringField(TEXT("comment"), Node->NodeComment);
		if (const UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node))
		{
			if (const UFunction* F = Call->GetTargetFunction())
			{
				N->SetStringField(TEXT("function"), F->GetOwnerClass()->GetName() + TEXT(":") + F->GetName());
			}
		}
		if (const UK2Node_Variable* Var = Cast<UK2Node_Variable>(Node)) N->SetStringField(TEXT("variable"), Var->GetVarName().ToString());

		TArray<TSharedPtr<FJsonValue>> Pins;
		for (const UEdGraphPin* Pin : Node->Pins)
		{
			if (!Pin || Pin->bHidden) continue;
			TSharedRef<FJsonObject> P = MakeShared<FJsonObject>();
			P->SetStringField(TEXT("name"), Pin->PinName.ToString());
			const FString Shown = Pin->GetDisplayName().ToString();
			if (!Shown.IsEmpty() && Shown != Pin->PinName.ToString()) P->SetStringField(TEXT("label"), Shown);
			P->SetStringField(TEXT("dir"), Pin->Direction == EGPD_Input ? TEXT("in") : TEXT("out"));
			P->SetStringField(TEXT("type"), PinTypeName(Pin));
			FString Default = Pin->DefaultObject ? Pin->DefaultObject->GetPathName() : !Pin->DefaultTextValue.IsEmpty() ? Pin->DefaultTextValue.ToString() : Pin->DefaultValue;
			if (!Default.IsEmpty() && Pin->LinkedTo.Num() == 0) P->SetStringField(TEXT("default"), Default);
			TArray<TSharedPtr<FJsonValue>> Links;
			for (const UEdGraphPin* L : Pin->LinkedTo)
			{
				if (L && L->GetOwningNodeUnchecked())
				{
					Links.Add(MakeShared<FJsonValueString>(L->GetOwningNode()->NodeGuid.ToString() + TEXT(":") + L->PinName.ToString()));
				}
			}
			if (Links.Num()) P->SetArrayField(TEXT("links"), Links);
			Pins.Add(MakeShared<FJsonValueObject>(P));
		}
		N->SetArrayField(TEXT("pins"), Pins);
		return N;
	}

	/** "KismetSystemLibrary:PrintString", "/Script/Engine.KismetSystemLibrary:PrintString" or just "PrintString". */
	UFunction* FindFunctionFor(UBlueprint* BP, const FString& Spec)
	{
		FString ClassName, FuncName;
		if (!Spec.Split(TEXT(":"), &ClassName, &FuncName))
		{
			FuncName = Spec;
		}
		TArray<UClass*> Classes;
		if (!ClassName.IsEmpty())
		{
			UClass* C = ClassName.StartsWith(TEXT("/")) ? LoadObject<UClass>(nullptr, *ClassName) : FindFirstObject<UClass>(*ClassName, EFindFirstObjectOptions::None);
			if (!C && !ClassName.StartsWith(TEXT("U"))) C = FindFirstObject<UClass>(*(TEXT("U") + ClassName), EFindFirstObjectOptions::None);
			if (C) Classes.Add(C);
		}
		if (BP->SkeletonGeneratedClass) Classes.Add(BP->SkeletonGeneratedClass);
		if (BP->ParentClass) Classes.Add(BP->ParentClass);
		for (const TCHAR* Lib : { TEXT("KismetSystemLibrary"), TEXT("KismetMathLibrary"), TEXT("KismetStringLibrary"), TEXT("GameplayStatics"), TEXT("KismetArrayLibrary") })
		{
			if (UClass* C = FindFirstObject<UClass>(Lib, EFindFirstObjectOptions::None)) Classes.Add(C);
		}
		for (UClass* C : Classes)
		{
			if (UFunction* F = C->FindFunctionByName(FName(*FuncName))) return F;
		}
		return nullptr;
	}

	UEdGraphPin* FindPin(UEdGraphNode* Node, const FString& Name, EEdGraphPinDirection Wanted)
	{
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (Pin && (Pin->PinName.ToString().Equals(Name, ESearchCase::IgnoreCase) || Pin->GetDisplayName().ToString().Equals(Name, ESearchCase::IgnoreCase))) return Pin;
		}
		// "exec" / "then": the first execution pin on the side that is wanted.
		const bool bExecName = Name.Equals(TEXT("exec"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("execute"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("then"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("in"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("out"), ESearchCase::IgnoreCase);
		if (bExecName)
		{
			for (UEdGraphPin* Pin : Node->Pins)
			{
				if (Pin && Pin->Direction == Wanted && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec) return Pin;
			}
		}
		return nullptr;
	}

	FString JsonStr(const TSharedPtr<FJsonObject>& O, const TCHAR* Field)
	{
		FString V;
		O->TryGetStringField(Field, V);
		return V;
	}

	int32 JsonInt(const TSharedPtr<FJsonObject>& O, const TCHAR* Field, int32 Default)
	{
		double V = Default;
		O->TryGetNumberField(Field, V);
		return FMath::RoundToInt(V);
	}
}

namespace KesherGraph
{
	TSharedRef<FJsonObject> List()
	{
		IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
		TArray<FAssetData> Assets;
		Registry.GetAssetsByClass(UBlueprint::StaticClass()->GetClassPathName(), Assets, true);
		TArray<TSharedPtr<FJsonValue>> Items;
		for (const FAssetData& A : Assets)
		{
			const FString Path = A.GetObjectPathString();
			if (!Path.StartsWith(TEXT("/Game/"))) continue;
			TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("path"), Path);
			Item->SetStringField(TEXT("name"), A.AssetName.ToString());
			FString Parent;
			if (A.GetTagValue(FBlueprintTags::ParentClassPath, Parent)) Item->SetStringField(TEXT("parent"), FPackageName::ObjectPathToObjectName(Parent));
			Items.Add(MakeShared<FJsonValueObject>(Item));
		}
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("blueprints"), Items);
		return Out;
	}

	TSharedRef<FJsonObject> Read(const FString& Path)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("path"), Path);
		Out->SetStringField(TEXT("name"), BP->GetName());
		if (BP->ParentClass) Out->SetStringField(TEXT("parent"), BP->ParentClass->GetName());

		TArray<TSharedPtr<FJsonValue>> Vars;
		for (const FBPVariableDescription& V : BP->NewVariables)
		{
			TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
			J->SetStringField(TEXT("name"), V.VarName.ToString());
			FString Type = V.VarType.PinCategory.ToString();
			if (UObject* Sub = V.VarType.PinSubCategoryObject.Get()) Type += TEXT(":") + Sub->GetName();
			J->SetStringField(TEXT("type"), Type);
			Vars.Add(MakeShared<FJsonValueObject>(J));
		}
		Out->SetArrayField(TEXT("variables"), Vars);

		TArray<TPair<UEdGraph*, FString>> Graphs;
		AllGraphs(BP, Graphs);
		TArray<TSharedPtr<FJsonValue>> GraphsJson;
		for (const TPair<UEdGraph*, FString>& G : Graphs)
		{
			TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
			J->SetStringField(TEXT("name"), G.Key->GetName());
			J->SetStringField(TEXT("kind"), G.Value);
			TArray<TSharedPtr<FJsonValue>> Nodes;
			for (UEdGraphNode* Node : G.Key->Nodes)
			{
				if (Node) Nodes.Add(MakeShared<FJsonValueObject>(NodeJson(Node)));
			}
			J->SetArrayField(TEXT("nodes"), Nodes);
			GraphsJson.Add(MakeShared<FJsonValueObject>(J));
		}
		Out->SetArrayField(TEXT("graphs"), GraphsJson);
		return Out;
	}

	TSharedRef<FJsonObject> Apply(const FString& Path, const FString& GraphName, const TArray<TSharedPtr<FJsonValue>>& Ops)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		UEdGraph* Graph = FindGraph(BP, GraphName);
		if (!Graph) return BridgeError(TEXT("No graph named ") + GraphName);
		const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();

		FScopedTransaction Transaction(LOCTEXT("Edit", "KesherAI edit"));
		BP->Modify();
		Graph->Modify();

		TMap<FString, UEdGraphNode*> Refs;
		auto NodeOf = [&](const FString& Id) -> UEdGraphNode*
		{
			if (UEdGraphNode** Found = Refs.Find(Id)) return *Found;
			FGuid Guid;
			if (!FGuid::Parse(Id, Guid)) return nullptr;
			for (UEdGraphNode* N : Graph->Nodes)
			{
				if (N && N->NodeGuid == Guid) return N;
			}
			return nullptr;
		};

		TArray<TSharedPtr<FJsonValue>> Results;
		int32 Failed = 0;
		for (const TSharedPtr<FJsonValue>& V : Ops)
		{
			const TSharedPtr<FJsonObject> Op = V.IsValid() ? V->AsObject() : nullptr;
			if (!Op.IsValid()) continue;
			const FString Kind = JsonStr(Op, TEXT("op"));
			FString Problem;
			UEdGraphNode* Made = nullptr;

			if (Kind == TEXT("add"))
			{
				const FString Type = JsonStr(Op, TEXT("type"));
				const int32 X = JsonInt(Op, TEXT("x"), 0), Y = JsonInt(Op, TEXT("y"), 0);
				if (Type == TEXT("call"))
				{
					if (UFunction* F = FindFunctionFor(BP, JsonStr(Op, TEXT("function"))))
					{
						FGraphNodeCreator<UK2Node_CallFunction> Creator(*Graph);
						UK2Node_CallFunction* N = Creator.CreateNode();
						N->SetFromFunction(F);
						N->NodePosX = X;
						N->NodePosY = Y;
						Creator.Finalize();
						Made = N;
					}
					else Problem = TEXT("No function ") + JsonStr(Op, TEXT("function"));
				}
				else if (Type == TEXT("event"))
				{
					const FName EventName(*JsonStr(Op, TEXT("event")));
					UFunction* F = BP->ParentClass ? BP->ParentClass->FindFunctionByName(EventName) : nullptr;
					if (F)
					{
						UClass* Owner = F->GetOwnerClass();
						if (UK2Node_Event* Existing = FBlueprintEditorUtils::FindOverrideForFunction(BP, Owner, EventName)) Made = Existing;
						else
						{
							FGraphNodeCreator<UK2Node_Event> Creator(*Graph);
							UK2Node_Event* N = Creator.CreateNode();
							N->EventReference.SetExternalMember(EventName, Owner);
							N->bOverrideFunction = true;
							N->NodePosX = X;
							N->NodePosY = Y;
							Creator.Finalize();
							Made = N;
						}
					}
					else Problem = TEXT("No event ") + EventName.ToString() + TEXT(" in the parent class");
				}
				else if (Type == TEXT("custom_event"))
				{
					FGraphNodeCreator<UK2Node_CustomEvent> Creator(*Graph);
					UK2Node_CustomEvent* N = Creator.CreateNode();
					N->CustomFunctionName = FName(*JsonStr(Op, TEXT("name")));
					N->NodePosX = X;
					N->NodePosY = Y;
					Creator.Finalize();
					Made = N;
				}
				else if (Type == TEXT("branch"))
				{
					FGraphNodeCreator<UK2Node_IfThenElse> Creator(*Graph);
					UK2Node_IfThenElse* N = Creator.CreateNode();
					N->NodePosX = X;
					N->NodePosY = Y;
					Creator.Finalize();
					Made = N;
				}
				else if (Type == TEXT("sequence"))
				{
					FGraphNodeCreator<UK2Node_ExecutionSequence> Creator(*Graph);
					UK2Node_ExecutionSequence* N = Creator.CreateNode();
					N->NodePosX = X;
					N->NodePosY = Y;
					Creator.Finalize();
					Made = N;
				}
				else if (Type == TEXT("get") || Type == TEXT("set"))
				{
					const FName Var(*JsonStr(Op, TEXT("variable")));
					if (FBlueprintEditorUtils::FindNewVariableIndex(BP, Var) == INDEX_NONE && !(BP->SkeletonGeneratedClass && BP->SkeletonGeneratedClass->FindPropertyByName(Var)))
					{
						Problem = TEXT("No variable ") + Var.ToString();
					}
					else if (Type == TEXT("get"))
					{
						FGraphNodeCreator<UK2Node_VariableGet> Creator(*Graph);
						UK2Node_VariableGet* N = Creator.CreateNode();
						N->VariableReference.SetSelfMember(Var);
						N->NodePosX = X;
						N->NodePosY = Y;
						Creator.Finalize();
						Made = N;
					}
					else
					{
						FGraphNodeCreator<UK2Node_VariableSet> Creator(*Graph);
						UK2Node_VariableSet* N = Creator.CreateNode();
						N->VariableReference.SetSelfMember(Var);
						N->NodePosX = X;
						N->NodePosY = Y;
						Creator.Finalize();
						Made = N;
					}
				}
				else Problem = TEXT("Unknown node type ") + Type;

				if (Made)
				{
					const FString Ref = JsonStr(Op, TEXT("ref"));
					if (!Ref.IsEmpty()) Refs.Add(Ref, Made);
				}
			}
			else if (Kind == TEXT("connect"))
			{
				const TSharedPtr<FJsonObject>* From = nullptr;
				const TSharedPtr<FJsonObject>* To = nullptr;
				if (Op->TryGetObjectField(TEXT("from"), From) && Op->TryGetObjectField(TEXT("to"), To))
				{
					UEdGraphNode* A = NodeOf(JsonStr(*From, TEXT("node")));
					UEdGraphNode* B = NodeOf(JsonStr(*To, TEXT("node")));
					UEdGraphPin* PA = A ? FindPin(A, JsonStr(*From, TEXT("pin")), EGPD_Output) : nullptr;
					UEdGraphPin* PB = B ? FindPin(B, JsonStr(*To, TEXT("pin")), EGPD_Input) : nullptr;
					if (!PA || !PB) Problem = TEXT("Pin not found: ") + JsonStr(*From, TEXT("node")) + TEXT(".") + JsonStr(*From, TEXT("pin")) + TEXT(" → ") + JsonStr(*To, TEXT("node")) + TEXT(".") + JsonStr(*To, TEXT("pin"));
					else if (!Schema->TryCreateConnection(PA, PB)) Problem = TEXT("These pins cannot be connected: ") + PA->PinName.ToString() + TEXT(" → ") + PB->PinName.ToString();
				}
				else Problem = TEXT("connect needs from and to");
			}
			else if (Kind == TEXT("set"))
			{
				UEdGraphNode* N = NodeOf(JsonStr(Op, TEXT("node")));
				UEdGraphPin* Pin = N ? FindPin(N, JsonStr(Op, TEXT("pin")), EGPD_Input) : nullptr;
				if (!Pin) Problem = TEXT("Pin not found: ") + JsonStr(Op, TEXT("pin"));
				else
				{
					Pin->Modify();
					Schema->TrySetDefaultValue(*Pin, JsonStr(Op, TEXT("value")));
				}
			}
			else if (Kind == TEXT("move"))
			{
				if (UEdGraphNode* N = NodeOf(JsonStr(Op, TEXT("node"))))
				{
					N->Modify();
					N->NodePosX = JsonInt(Op, TEXT("x"), N->NodePosX);
					N->NodePosY = JsonInt(Op, TEXT("y"), N->NodePosY);
				}
				else Problem = TEXT("Node not found");
			}
			else if (Kind == TEXT("delete"))
			{
				if (UEdGraphNode* N = NodeOf(JsonStr(Op, TEXT("node")))) FBlueprintEditorUtils::RemoveNode(BP, N, true);
				else Problem = TEXT("Node not found");
			}
			else if (Kind == TEXT("comment"))
			{
				if (UEdGraphNode* N = NodeOf(JsonStr(Op, TEXT("node"))))
				{
					N->Modify();
					N->NodeComment = JsonStr(Op, TEXT("text"));
					N->bCommentBubbleVisible = !N->NodeComment.IsEmpty();
				}
				else Problem = TEXT("Node not found");
			}
			else Problem = TEXT("Unknown operation ") + Kind;

			TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
			R->SetStringField(TEXT("op"), Kind);
			R->SetBoolField(TEXT("ok"), Problem.IsEmpty());
			if (!Problem.IsEmpty())
			{
				R->SetStringField(TEXT("error"), Problem);
				Failed++;
			}
			if (Made) R->SetStringField(TEXT("node"), Made->NodeGuid.ToString());
			Results.Add(MakeShared<FJsonValueObject>(R));
		}

		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("results"), Results);
		Out->SetNumberField(TEXT("failed"), Failed);
		return Out;
	}

	TSharedRef<FJsonObject> Compile(const FString& Path)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		FCompilerResultsLog Log;
		FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &Log);
		TArray<TSharedPtr<FJsonValue>> Messages;
		for (const TSharedRef<FTokenizedMessage>& M : Log.Messages)
		{
			const EMessageSeverity::Type S = M->GetSeverity();
			if (S == EMessageSeverity::Info) continue;
			TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
			J->SetStringField(TEXT("severity"), S == EMessageSeverity::Error ? TEXT("error") : TEXT("warning"));
			J->SetStringField(TEXT("text"), M->ToText().ToString());
			Messages.Add(MakeShared<FJsonValueObject>(J));
		}
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetBoolField(TEXT("ok"), BP->Status != BS_Error);
		Out->SetArrayField(TEXT("messages"), Messages);
		return Out;
	}

	TSharedRef<FJsonObject> Save(const FString& Path)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		TArray<UPackage*> Packages = { BP->GetPackage() };
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetBoolField(TEXT("ok"), UEditorLoadingAndSavingUtils::SavePackages(Packages, false));
		return Out;
	}

	TSharedRef<FJsonObject> Open(const FString& Path)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		if (GEditor) GEditor->GetEditorSubsystem<UAssetEditorSubsystem>()->OpenEditorForAsset(BP);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetBoolField(TEXT("ok"), true);
		return Out;
	}
}

#undef LOCTEXT_NAMESPACE
