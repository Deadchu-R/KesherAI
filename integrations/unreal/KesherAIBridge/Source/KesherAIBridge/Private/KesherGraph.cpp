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
#include "K2Node_Knot.h"
#include "K2Node_MacroInstance.h"
#include "EdGraphUtilities.h"
#include "EdGraphNode_Comment.h"
#include "K2Node_Variable.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UObject/UObjectIterator.h"
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

	/**
	 * A variable type as KesherAI names it: bool, int, int64, byte, real (float), string, name, text,
	 * struct:Vector, object:Actor, object:/Game/Enemies/BP_Enemy (a Blueprint), class:Actor;
	 * a list ends in "[]".
	 */
	FString VarTypeName(const FEdGraphPinType& T)
	{
		FString Out = T.PinCategory.ToString();
		if (UObject* Sub = T.PinSubCategoryObject.Get())
		{
			const UClass* C = Cast<UClass>(Sub);
			const UBlueprint* Owner = C ? Cast<UBlueprint>(C->ClassGeneratedBy) : nullptr;
			Out += TEXT(":") + (Owner ? Owner->GetPathName() : Sub->GetName());
		}
		if (T.ContainerType == EPinContainerType::Array) Out += TEXT("[]");
		return Out;
	}

	/** The class or struct a type names: a Blueprint's asset path, a script path, or a short name. */
	UObject* FindTypeObject(const FString& Name, bool bStruct)
	{
		if (Name.StartsWith(TEXT("/")))
		{
			if (UBlueprint* B = LoadObject<UBlueprint>(nullptr, *Name)) return B->GeneratedClass;
			return bStruct ? static_cast<UObject*>(LoadObject<UScriptStruct>(nullptr, *Name)) : static_cast<UObject*>(LoadObject<UClass>(nullptr, *Name));
		}
		if (bStruct)
		{
			if (Name == TEXT("Vector")) return TBaseStructure<FVector>::Get();
			if (Name == TEXT("Vector2D")) return TBaseStructure<FVector2D>::Get();
			if (Name == TEXT("Rotator")) return TBaseStructure<FRotator>::Get();
			if (Name == TEXT("Transform")) return TBaseStructure<FTransform>::Get();
			if (Name == TEXT("LinearColor")) return TBaseStructure<FLinearColor>::Get();
			return FindFirstObject<UScriptStruct>(*Name, EFindFirstObjectOptions::NativeFirst);
		}
		return FindFirstObject<UClass>(*Name, EFindFirstObjectOptions::NativeFirst);
	}

	/** Reads a type name (VarTypeName's form) into a pin type; false with a reason when it is not known. */
	bool ParseVarType(FString Name, FEdGraphPinType& Out, FString& Problem)
	{
		Out = FEdGraphPinType();
		if (Name.EndsWith(TEXT("[]")))
		{
			Out.ContainerType = EPinContainerType::Array;
			Name.LeftChopInline(2);
		}
		FString Cat = Name, Sub;
		Name.Split(TEXT(":"), &Cat, &Sub);
		if (Sub.IsEmpty()) Cat = Name;
		Cat = Cat.ToLower();
		if (Cat == TEXT("bool") || Cat == TEXT("boolean")) Out.PinCategory = UEdGraphSchema_K2::PC_Boolean;
		else if (Cat == TEXT("int")) Out.PinCategory = UEdGraphSchema_K2::PC_Int;
		else if (Cat == TEXT("int64")) Out.PinCategory = UEdGraphSchema_K2::PC_Int64;
		else if (Cat == TEXT("byte")) Out.PinCategory = UEdGraphSchema_K2::PC_Byte;
		else if (Cat == TEXT("real") || Cat == TEXT("float") || Cat == TEXT("double"))
		{
			Out.PinCategory = UEdGraphSchema_K2::PC_Real;
			Out.PinSubCategory = UEdGraphSchema_K2::PC_Double;
		}
		else if (Cat == TEXT("string")) Out.PinCategory = UEdGraphSchema_K2::PC_String;
		else if (Cat == TEXT("name")) Out.PinCategory = UEdGraphSchema_K2::PC_Name;
		else if (Cat == TEXT("text")) Out.PinCategory = UEdGraphSchema_K2::PC_Text;
		else if (Cat == TEXT("struct") || Cat == TEXT("object") || Cat == TEXT("class") || Cat == TEXT("softobject"))
		{
			UObject* Obj = FindTypeObject(Sub, Cat == TEXT("struct"));
			if (!Obj)
			{
				Problem = TEXT("Unknown type ") + Sub;
				return false;
			}
			Out.PinCategory = Cat == TEXT("struct") ? UEdGraphSchema_K2::PC_Struct : Cat == TEXT("class") ? UEdGraphSchema_K2::PC_Class : Cat == TEXT("softobject") ? UEdGraphSchema_K2::PC_SoftObject : UEdGraphSchema_K2::PC_Object;
			Out.PinSubCategoryObject = Obj;
		}
		else
		{
			Problem = TEXT("Unknown type ") + Name;
			return false;
		}
		return true;
	}

	/** A variable's starting value as text, read from the Blueprint's default object. */
	FString VarDefault(UBlueprint* BP, const FBPVariableDescription& V)
	{
		UClass* C = BP->GeneratedClass;
		UObject* CDO = C ? C->GetDefaultObject(false) : nullptr;
		const FProperty* P = C ? C->FindPropertyByName(V.VarName) : nullptr;
		if (!CDO || !P) return V.DefaultValue;
		FString Out;
		P->ExportText_InContainer(0, Out, CDO, CDO, CDO, PPF_None);
		return Out;
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
		if (const UEdGraphNode_Comment* C = Cast<UEdGraphNode_Comment>(Node))
		{
			N->SetNumberField(TEXT("width"), C->NodeWidth);
			N->SetNumberField(TEXT("height"), C->NodeHeight);
			N->SetStringField(TEXT("color"), C->CommentColor.ToFColor(true).ToHex());
		}
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
			// What the variables panel shows and changes.
			J->SetStringField(TEXT("ptype"), VarTypeName(V.VarType));
			J->SetStringField(TEXT("default"), VarDefault(BP, V));
			J->SetBoolField(TEXT("editable"), !(V.PropertyFlags & CPF_DisableEditOnInstance));
			FString Tip;
			FBlueprintEditorUtils::GetBlueprintVariableMetaData(BP, V.VarName, nullptr, FBlueprintMetadata::MD_Tooltip, Tip);
			J->SetStringField(TEXT("tooltip"), Tip);
			J->SetStringField(TEXT("category"), V.Category.ToString());
			FString Priv;
			J->SetBoolField(TEXT("private"), FBlueprintEditorUtils::GetBlueprintVariableMetaData(BP, V.VarName, nullptr, FBlueprintMetadata::MD_Private, Priv) && Priv == TEXT("true"));
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
			FString CopiedText;
			TArray<TSharedPtr<FJsonValue>> PastedIds;

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
				else if (Type == TEXT("reroute"))
				{
					// A reroute node (the dot on a wire): connect it like any node.
					FGraphNodeCreator<UK2Node_Knot> Creator(*Graph);
					UK2Node_Knot* N = Creator.CreateNode();
					N->NodePosX = X;
					N->NodePosY = Y;
					Creator.Finalize();
					Made = N;
				}
				else if (Type == TEXT("comment_box"))
				{
					// A comment box (C in Unreal): a coloured frame with a title around nodes.
					UEdGraphNode_Comment* N = NewObject<UEdGraphNode_Comment>(Graph);
					N->CreateNewGuid();
					N->NodePosX = X;
					N->NodePosY = Y;
					N->NodeWidth = FMath::Clamp(JsonInt(Op, TEXT("width"), 400), 64, 8000);
					N->NodeHeight = FMath::Clamp(JsonInt(Op, TEXT("height"), 200), 64, 8000);
					Graph->AddNode(N, true, false);
					N->PostPlacedNewNode();
					// After PostPlacedNewNode, which puts back the default title and colour (found on 5.8: the text was lost).
					const FString Text = JsonStr(Op, TEXT("text"));
					N->NodeComment = Text.IsEmpty() ? TEXT("Comment") : Text;
					const FString Color = JsonStr(Op, TEXT("color"));
					if (!Color.IsEmpty()) N->CommentColor = FLinearColor(FColor::FromHex(Color));
					Made = N;
				}
				else if (Type == TEXT("macro"))
				{
					// Unreal's standard macros (hold-a-key nodes): ForEachLoop, Gate, DoOnce, DoN, MultiGate, ForLoop, WhileLoop…
					static const TCHAR* MacrosPath = TEXT("/Engine/EditorBlueprintResources/StandardMacros.StandardMacros");
					UBlueprint* Macros = LoadObject<UBlueprint>(nullptr, MacrosPath);
					const FString Name = JsonStr(Op, TEXT("macro"));
					UEdGraph* MacroGraph = nullptr;
					if (Macros)
					{
						for (UEdGraph* G : Macros->MacroGraphs)
						{
							if (G && G->GetName() == Name) MacroGraph = G;
						}
					}
					if (!MacroGraph) Problem = TEXT("No standard macro ") + Name;
					else
					{
						FGraphNodeCreator<UK2Node_MacroInstance> Creator(*Graph);
						UK2Node_MacroInstance* N = Creator.CreateNode();
						N->SetMacroGraph(MacroGraph);
						N->NodePosX = X;
						N->NodePosY = Y;
						Creator.Finalize();
						Made = N;
					}
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
			else if (Kind == TEXT("disconnect"))
			{
				// Alt+click on a pin in Unreal: break all its links.
				UEdGraphNode* N = NodeOf(JsonStr(Op, TEXT("node")));
				UEdGraphPin* Pin = N ? FindPin(N, JsonStr(Op, TEXT("pin")), EGPD_Input) : nullptr;
				if (N && !Pin) Pin = FindPin(N, JsonStr(Op, TEXT("pin")), EGPD_Output);
				if (!Pin) Problem = TEXT("Pin not found: ") + JsonStr(Op, TEXT("pin"));
				else
				{
					N->Modify();
					// "link" ("node:pin" of the other end): one chosen wire only (0.1.15); else every wire of the pin.
					const FString Link = JsonStr(Op, TEXT("link"));
					FString OtherNode, OtherPinName;
					UEdGraphPin* Other = nullptr;
					if (Link.Split(TEXT(":"), &OtherNode, &OtherPinName, ESearchCase::IgnoreCase, ESearchDir::FromEnd))
					{
						if (UEdGraphNode* O = NodeOf(OtherNode)) Other = FindPin(O, OtherPinName, Pin->Direction == EGPD_Input ? EGPD_Output : EGPD_Input);
					}
					if (Other && Pin->LinkedTo.Contains(Other))
					{
						Other->GetOwningNode()->Modify();
						Schema->BreakSinglePinLink(Pin, Other);
					}
					else if (!Link.IsEmpty()) Problem = TEXT("That wire was not found");
					else Schema->BreakPinLinks(*Pin, true);
				}
			}
			else if (Kind == TEXT("comment"))
			{
				if (UEdGraphNode* N = NodeOf(JsonStr(Op, TEXT("node"))))
				{
					N->Modify();
					N->NodeComment = JsonStr(Op, TEXT("text"));
					// A comment box keeps its title as its text; another node shows it as a bubble.
					if (!N->IsA<UEdGraphNode_Comment>()) N->bCommentBubbleVisible = !N->NodeComment.IsEmpty();
					const FString Color = JsonStr(Op, TEXT("color"));
					if (UEdGraphNode_Comment* C = Cast<UEdGraphNode_Comment>(N); C && !Color.IsEmpty()) C->CommentColor = FLinearColor(FColor::FromHex(Color));
				}
				else Problem = TEXT("Node not found");
			}
			else if (Kind == TEXT("resize"))
			{
				if (UEdGraphNode_Comment* C = Cast<UEdGraphNode_Comment>(NodeOf(JsonStr(Op, TEXT("node")))))
				{
					C->Modify();
					C->NodeWidth = FMath::Clamp(JsonInt(Op, TEXT("width"), C->NodeWidth), 64, 8000);
					C->NodeHeight = FMath::Clamp(JsonInt(Op, TEXT("height"), C->NodeHeight), 64, 8000);
				}
				else Problem = TEXT("Comment box not found");
			}
			else if (Kind == TEXT("copy"))
			{
				// Unreal's own clipboard text for the chosen nodes (Ctrl+C in the editor makes the same text).
				TSet<UObject*> Chosen;
				const TArray<TSharedPtr<FJsonValue>>* Ids = nullptr;
				if (Op->TryGetArrayField(TEXT("nodes"), Ids))
				{
					for (const TSharedPtr<FJsonValue>& IdV : *Ids)
					{
						if (UEdGraphNode* N = NodeOf(IdV->AsString()); N && N->CanDuplicateNode())
						{
							N->PrepareForCopying();
							Chosen.Add(N);
						}
					}
				}
				if (Chosen.Num() == 0) Problem = TEXT("Nothing that can be copied");
				else FEdGraphUtilities::ExportNodesToText(Chosen, CopiedText);
			}
			else if (Kind == TEXT("paste"))
			{
				// Ctrl+V: nodes from the clipboard text, their top-left at (x, y), with new ids and their links kept.
				const FString Text = JsonStr(Op, TEXT("text"));
				TSet<UEdGraphNode*> Pasted;
				if (Text.IsEmpty() || !FEdGraphUtilities::CanImportNodesFromText(Graph, Text)) Problem = TEXT("Nothing to paste here");
				else
				{
					FEdGraphUtilities::ImportNodesFromText(Graph, Text, Pasted);
					int32 MinX = TNumericLimits<int32>::Max(), MinY = TNumericLimits<int32>::Max();
					for (UEdGraphNode* N : Pasted)
					{
						MinX = FMath::Min(MinX, N->NodePosX);
						MinY = FMath::Min(MinY, N->NodePosY);
					}
					const int32 X = JsonInt(Op, TEXT("x"), MinX), Y = JsonInt(Op, TEXT("y"), MinY);
					for (UEdGraphNode* N : Pasted)
					{
						N->CreateNewGuid();
						N->NodePosX += X - MinX;
						N->NodePosY += Y - MinY;
						N->PostPasteNode();
						PastedIds.Add(MakeShared<FJsonValueString>(N->NodeGuid.ToString()));
					}
					if (Pasted.Num() == 0) Problem = TEXT("Nothing was pasted");
				}
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
			if (!CopiedText.IsEmpty()) R->SetStringField(TEXT("text"), CopiedText);
			if (PastedIds.Num()) R->SetArrayField(TEXT("nodes"), PastedIds);
			Results.Add(MakeShared<FJsonValueObject>(R));
		}

		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("results"), Results);
		Out->SetNumberField(TEXT("failed"), Failed);
		return Out;
	}

	TSharedRef<FJsonObject> EditVariables(const FString& Path, const TArray<TSharedPtr<FJsonValue>>& Ops)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		FScopedTransaction Transaction(LOCTEXT("Vars", "KesherAI variables"));
		BP->Modify();

		auto Exists = [&](const FName& N) { return FBlueprintEditorUtils::FindNewVariableIndex(BP, N) != INDEX_NONE; };
		// Starting values are set on the default object after the compile, when the property exists.
		TMap<FName, FString> Defaults;
		TArray<TSharedPtr<FJsonValue>> Results;
		int32 Failed = 0;
		for (const TSharedPtr<FJsonValue>& V : Ops)
		{
			const TSharedPtr<FJsonObject> Op = V.IsValid() ? V->AsObject() : nullptr;
			if (!Op.IsValid()) continue;
			const FString Kind = JsonStr(Op, TEXT("op"));
			FName Name(*JsonStr(Op, TEXT("name")));
			FString Problem;
			if (Name.IsNone()) Problem = TEXT("A variable needs a name");
			else if (Kind == TEXT("add"))
			{
				FEdGraphPinType Type;
				if (Exists(Name)) Problem = TEXT("There is already a variable ") + Name.ToString();
				else if (ParseVarType(JsonStr(Op, TEXT("type")), Type, Problem))
				{
					if (!FBlueprintEditorUtils::AddMemberVariable(BP, Name, Type, JsonStr(Op, TEXT("default")))) Problem = TEXT("Unreal did not add ") + Name.ToString() + TEXT(" (is the name allowed?)");
				}
			}
			else if (!Exists(Name)) Problem = TEXT("No variable ") + Name.ToString();
			else if (Kind == TEXT("remove")) FBlueprintEditorUtils::RemoveMemberVariable(BP, Name);
			else if (Kind == TEXT("change"))
			{
				const FString NewName = JsonStr(Op, TEXT("newName"));
				if (!NewName.IsEmpty() && FName(*NewName) != Name)
				{
					if (Exists(FName(*NewName))) Problem = TEXT("There is already a variable ") + NewName;
					else
					{
						// Renames its Get/Set nodes too, like the editor.
						FBlueprintEditorUtils::RenameMemberVariable(BP, Name, FName(*NewName));
						Name = FName(*NewName);
					}
				}
				FString TypeName;
				if (Problem.IsEmpty() && Op->TryGetStringField(TEXT("type"), TypeName))
				{
					FEdGraphPinType Type;
					const int32 I = FBlueprintEditorUtils::FindNewVariableIndex(BP, Name);
					if (ParseVarType(TypeName, Type, Problem) && I != INDEX_NONE && !(BP->NewVariables[I].VarType == Type)) FBlueprintEditorUtils::ChangeMemberVariableType(BP, Name, Type);
				}
			}
			else Problem = TEXT("Unknown operation ") + Kind;

			// What add and change share: shown in the level (Instance Editable), tooltip, category, starting value.
			if (Problem.IsEmpty() && (Kind == TEXT("add") || Kind == TEXT("change")))
			{
				bool bEditable = false;
				if (Op->TryGetBoolField(TEXT("editable"), bEditable)) FBlueprintEditorUtils::SetBlueprintOnlyEditableFlag(BP, Name, !bEditable);
				FString Text;
				if (Op->TryGetStringField(TEXT("tooltip"), Text))
				{
					if (Text.IsEmpty()) FBlueprintEditorUtils::RemoveBlueprintVariableMetaData(BP, Name, nullptr, FBlueprintMetadata::MD_Tooltip);
					else FBlueprintEditorUtils::SetBlueprintVariableMetaData(BP, Name, nullptr, FBlueprintMetadata::MD_Tooltip, Text);
				}
				// Private: other Blueprints cannot read or change it (the Details panel's "Private").
				bool bPrivate = false;
				if (Op->TryGetBoolField(TEXT("private"), bPrivate))
				{
					if (bPrivate) FBlueprintEditorUtils::SetBlueprintVariableMetaData(BP, Name, nullptr, FBlueprintMetadata::MD_Private, TEXT("true"));
					else FBlueprintEditorUtils::RemoveBlueprintVariableMetaData(BP, Name, nullptr, FBlueprintMetadata::MD_Private);
				}
				if (Op->TryGetStringField(TEXT("category"), Text)) FBlueprintEditorUtils::SetBlueprintVariableCategory(BP, Name, nullptr, FText::FromString(Text.IsEmpty() ? TEXT("Default") : Text), true);
				if (Op->TryGetStringField(TEXT("default"), Text) && Kind == TEXT("change")) Defaults.Add(Name, Text);
			}

			TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
			R->SetStringField(TEXT("op"), Kind);
			R->SetStringField(TEXT("name"), Name.ToString());
			R->SetBoolField(TEXT("ok"), Problem.IsEmpty());
			if (!Problem.IsEmpty())
			{
				R->SetStringField(TEXT("error"), Problem);
				Failed++;
			}
			Results.Add(MakeShared<FJsonValueObject>(R));
		}

		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);
		if (Defaults.Num())
		{
			FKismetEditorUtilities::CompileBlueprint(BP);
			UObject* CDO = BP->GeneratedClass ? BP->GeneratedClass->GetDefaultObject() : nullptr;
			for (const TPair<FName, FString>& D : Defaults)
			{
				const int32 I = FBlueprintEditorUtils::FindNewVariableIndex(BP, D.Key);
				if (I != INDEX_NONE) BP->NewVariables[I].DefaultValue = D.Value;
				const FProperty* P = BP->GeneratedClass ? BP->GeneratedClass->FindPropertyByName(D.Key) : nullptr;
				if (CDO && P)
				{
					CDO->Modify();
					if (!P->ImportText_InContainer(*D.Value, CDO, CDO, PPF_None))
					{
						TSharedRef<FJsonObject> R = MakeShared<FJsonObject>();
						R->SetStringField(TEXT("op"), TEXT("default"));
						R->SetStringField(TEXT("name"), D.Key.ToString());
						R->SetBoolField(TEXT("ok"), false);
						R->SetStringField(TEXT("error"), TEXT("Unreal could not read the starting value ") + D.Value);
						Results.Add(MakeShared<FJsonValueObject>(R));
						Failed++;
					}
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
		}
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

	TSharedRef<FJsonObject> Actions(const FString& Path, const FString& Query)
	{
		UBlueprint* BP = LoadBlueprint(Path);
		if (!BP) return BridgeError(TEXT("No Blueprint at ") + Path);
		TArray<FString> Words;
		Query.ToLower().ParseIntoArrayWS(Words);
		auto Matches = [&](const FString& A, const FString& B, const FString& C)
		{
			const FString All = (A + TEXT(" ") + B + TEXT(" ") + C).ToLower();
			for (const FString& W : Words)
			{
				if (!All.Contains(W)) return false;
			}
			return true;
		};
		TArray<TSharedPtr<FJsonValue>> Items;
		const int32 Max = 60;
		auto Add = [&](const FString& Title, const FString& Category, const FString& Type, const FString& Field, const FString& Value)
		{
			TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
			J->SetStringField(TEXT("title"), Title);
			J->SetStringField(TEXT("category"), Category);
			J->SetStringField(TEXT("type"), Type);
			if (!Field.IsEmpty()) J->SetStringField(Field, Value);
			Items.Add(MakeShared<FJsonValueObject>(J));
		};
		// Flow control first, like Unreal's own menu.
		if (Matches(TEXT("Branch"), TEXT("if"), TEXT("Flow Control"))) Add(TEXT("Branch"), TEXT("Flow Control"), TEXT("branch"), TEXT(""), TEXT(""));
		if (Matches(TEXT("Sequence"), TEXT(""), TEXT("Flow Control"))) Add(TEXT("Sequence"), TEXT("Flow Control"), TEXT("sequence"), TEXT(""), TEXT(""));
		if (Matches(TEXT("Add Custom Event"), TEXT(""), TEXT("Add Event"))) Add(TEXT("Add Custom Event…"), TEXT("Add Event"), TEXT("custom_event"), TEXT("name"), TEXT("NewEvent"));
		// The Blueprint's variables.
		for (const FBPVariableDescription& V : BP->NewVariables)
		{
			const FString Name = V.VarName.ToString();
			if (Items.Num() < Max && Matches(TEXT("Get ") + Name, TEXT("variable"), TEXT("Variables"))) Add(TEXT("Get ") + Name, TEXT("Variables"), TEXT("get"), TEXT("variable"), Name);
			if (Items.Num() < Max && Matches(TEXT("Set ") + Name, TEXT("variable"), TEXT("Variables"))) Add(TEXT("Set ") + Name, TEXT("Variables"), TEXT("set"), TEXT("variable"), Name);
		}
		auto Usable = [](const UFunction* F)
		{
			return F->HasAnyFunctionFlags(FUNC_BlueprintCallable | FUNC_BlueprintPure) && !F->HasMetaData(TEXT("BlueprintInternalUseOnly")) && !F->HasMetaData(TEXT("DeprecatedFunction"));
		};
		// Events the parent class lets Blueprints implement, then its callable functions.
		if (UClass* Parent = BP->ParentClass)
		{
			for (TFieldIterator<UFunction> It(Parent, EFieldIteratorFlags::IncludeSuper); It && Items.Num() < Max; ++It)
			{
				UFunction* F = *It;
				const FString Title = F->GetDisplayNameText().ToString();
				if (F->HasAnyFunctionFlags(FUNC_BlueprintEvent) && !F->GetReturnProperty() && Matches(TEXT("Event ") + Title, F->GetName(), TEXT("Add Event")))
					Add(TEXT("Event ") + Title, TEXT("Add Event"), TEXT("event"), TEXT("event"), F->GetName());
				else if (Usable(F) && Matches(Title, F->GetName(), F->GetMetaData(TEXT("Category"))))
					Add(Title, F->GetMetaData(TEXT("Category")), TEXT("call"), TEXT("function"), F->GetOwnerClass()->GetName() + TEXT(":") + F->GetName());
			}
		}
		// Function libraries (Print String, math, Gameplay Statics…).
		for (TObjectIterator<UClass> C; C && Items.Num() < Max; ++C)
		{
			if (!C->IsChildOf(UBlueprintFunctionLibrary::StaticClass()) || C->HasAnyClassFlags(CLASS_Deprecated | CLASS_NewerVersionExists | CLASS_Abstract)) continue;
			for (TFieldIterator<UFunction> It(*C, EFieldIteratorFlags::ExcludeSuper); It && Items.Num() < Max; ++It)
			{
				UFunction* F = *It;
				if (!Usable(F)) continue;
				const FString Title = F->GetDisplayNameText().ToString();
				if (Matches(Title, F->GetName(), F->GetMetaData(TEXT("Category"))))
					Add(Title, F->GetMetaData(TEXT("Category")), TEXT("call"), TEXT("function"), C->GetName() + TEXT(":") + F->GetName());
			}
		}
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetArrayField(TEXT("actions"), Items);
		return Out;
	}

	TSharedRef<FJsonObject> Undo(bool bRedo)
	{
		const bool bOk = GEditor && (bRedo ? GEditor->RedoTransaction() : GEditor->UndoTransaction());
		TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetBoolField(TEXT("ok"), bOk);
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
