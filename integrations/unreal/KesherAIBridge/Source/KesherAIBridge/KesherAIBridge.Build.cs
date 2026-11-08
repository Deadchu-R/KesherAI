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
			"KismetCompiler",
			"AssetRegistry",
			"WebSockets",
			"Json",
			"JsonUtilities",
			"Slate",
			"SlateCore",
		});
	}
}
