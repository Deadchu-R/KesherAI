// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using UnrealBuildTool;

public class KesherAIBridge : ModuleRules
{
	public KesherAIBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		// A Visual Studio newer than the engine knows reports engine headers (e.g. ConcurrentLinearAllocator.h in 5.4,
		// "'__has_feature' is not defined", C4668) as errors; the plugin cannot edit them, so undefined identifiers in
		// #if are not diagnosed in this module. UndefinedIdentifierWarningLevel exists since UE 5.3; older engines
		// only have the bool. UE_5_3_OR_LATER is defined by UBT for every engine from 5.3 on (5.1 and 5.2 skip it).
#if UE_5_3_OR_LATER
		UndefinedIdentifierWarningLevel = WarningLevel.Off;
#else
		bEnableUndefinedIdentifierWarnings = false;
#endif

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
