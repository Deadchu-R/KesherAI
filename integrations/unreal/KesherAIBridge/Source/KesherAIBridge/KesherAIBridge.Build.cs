// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using UnrealBuildTool;

public class KesherAIBridge : ModuleRules
{
	public KesherAIBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

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
			"UMGEditor",
			"AssetTools",
			"ImageCore",
			"InputCore",
		});

		// Gameplay tests inject Enhanced Input actions (the EnhancedInput plugin, on by default since UE 5.1). Without
		// it, KESHER_WITH_ENHANCED_INPUT is 0 and input steps say to use key steps instead.
		PrivateDependencyModuleNames.Add("EnhancedInput");
		PublicDefinitions.Add("KESHER_WITH_ENHANCED_INPUT=1");

		// Live Coding from KesherAI's C++ editor (Windows editor only).
		if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			PrivateDependencyModuleNames.Add("LiveCoding");
		}
	}
}
