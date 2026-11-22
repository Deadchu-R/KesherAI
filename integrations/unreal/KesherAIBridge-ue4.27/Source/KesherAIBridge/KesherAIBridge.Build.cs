// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using UnrealBuildTool;

/// <summary>
/// The KesherAI Bridge module for Unreal Engine 4.27. KesherAI lays the Unreal 5 plugin's files first and this folder's
/// files over them, so every source file of the module is here in its 4.27 form.
/// </summary>
public class KesherAIBridge : ModuleRules
{
	public KesherAIBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		// A Visual Studio newer than the engine reports undefined identifiers in the engine's own #if lines; 4.27 has
		// the plain bool for this (the reflection the Unreal 5 Build.cs needs is not needed here).
		bEnableUndefinedIdentifierWarnings = false;

		// Each .cpp compiles on its own: several files have file-local helpers with the same name (Read3, PlayWorld,
		// Unhook), which one unity file would merge into a redefinition. It is also how the Unreal 5 plugin is built
		// on 5.4 and older, and one compile then reports every file's errors instead of stopping at the first.
		bUseUnity = false;

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
			// Widget Blueprint creation (UWidgetBlueprintFactory, UWidgetBlueprint): UMGEditor exists in 4.27 too.
			"UMGEditor",
			"AssetTools",
			"ImageCore",
			"InputCore",
		});

		// Unreal 4.27 has no Enhanced Input plugin: gameplay test "input" steps answer that a key or axis step is needed.
		PublicDefinitions.Add("KESHER_WITH_ENHANCED_INPUT=0");

		// Live Coding from KesherAI's C++ editor (Windows editor only; the LiveCoding module exists in 4.27 too).
		if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			PrivateDependencyModuleNames.Add("LiveCoding");
		}
	}
}
