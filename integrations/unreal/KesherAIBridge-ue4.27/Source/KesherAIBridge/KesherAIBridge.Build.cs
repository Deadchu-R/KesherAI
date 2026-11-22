// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using UnrealBuildTool;

public class KesherAIBridge : ModuleRules
{
	public KesherAIBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		// UE 4.27: the bool form; reflection is not needed here.
		bEnableUndefinedIdentifierWarnings = false;

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"UnrealEd",
			"BlueprintGraph",
			"Kismet",
			"GraphEditor",
			"KismetCompiler",
			"AssetRegistry",
			"MeshDescription",
			"StaticMeshDescription",
			"WebSockets",
			"Json",
			"JsonUtilities",
			"Slate",
			"SlateCore",
			"UMG",
			// UE 4.27: "UMGEditor" does not exist; UMG's editor utilities are in "UMG" itself.
			"AssetTools",
			"ImageCore",
			"InputCore",
		});

		// UE 4.27: Enhanced Input plugin does not exist. Gameplay test "input" steps are disabled.
		PublicDefinitions.Add("KESHER_WITH_ENHANCED_INPUT=0");

		// UE 4.27: Live Coding module does not exist in 4.27.
		// WITH_LIVE_CODING will be 0.
	}
}
