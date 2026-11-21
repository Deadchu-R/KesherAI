// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using UnrealBuildTool;

public class KesherAIBridge : ModuleRules
{
	public KesherAIBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		// A Visual Studio newer than the engine knows reports engine headers (e.g. ConcurrentLinearAllocator.h in 5.4,
		// "'__has_feature' is not defined", C4668) as errors; the plugin cannot edit them, so undefined identifiers in
		// #if are not diagnosed in this module.
		// The setting moved between engine versions (bool before, enum after, then inside CppCompileWarningSettings),
		// and a name that does not exist fails the whole build (found on Unreal 5.4): set whichever exists, by reflection.
		DisableUndefinedIdentifierWarnings();
		// Unreal 5.4 and older with Visual Studio 17.10+: the engine's own ConcurrentLinearAllocator.h uses
		// `#if __has_feature(...)`, which that compiler does not define, so C4668 and C4067 stop the build whatever the
		// warning settings. Define it for this module's files only (MSVC accepts a function-like /D), as clang does: 0.
		if (Target.Platform == UnrealTargetPlatform.Win64 && Target.Version.MajorVersion == 5 && Target.Version.MinorVersion <= 4)
		{
			PrivateDefinitions.Add("__has_feature(x)=0");
			// The define must reach every file: a shared engine PCH is built without it (0.1.31 still failed), so this
			// module compiles without shared PCHs on these engines (slower build, same plugin).
			PCHUsage = PCHUsageMode.NoPCHs;
			bUseUnity = false;
		}

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

	/// <summary>Turns off "undefined identifier in #if" diagnostics with whichever setting this engine version has.</summary>
	private void DisableUndefinedIdentifierWarnings()
	{
		const System.Reflection.BindingFlags Flags = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
		object WarningOwner = this;
		System.Reflection.PropertyInfo Settings = GetType().GetProperty("CppCompileWarningSettings", Flags);
		if (Settings != null && Settings.GetValue(this) != null) WarningOwner = Settings.GetValue(this);
		foreach (object Owner in new object[] { WarningOwner, this })
		{
			System.Reflection.PropertyInfo Level = Owner.GetType().GetProperty("UndefinedIdentifierWarningLevel", Flags);
			if (Level != null && Level.CanWrite && Level.PropertyType.IsEnum && System.Enum.IsDefined(Level.PropertyType, "Off"))
			{
				Level.SetValue(Owner, System.Enum.Parse(Level.PropertyType, "Off"));
				return;
			}
		}
		System.Reflection.PropertyInfo Prop = GetType().GetProperty("bEnableUndefinedIdentifierWarnings", Flags);
		if (Prop != null && Prop.CanWrite) { Prop.SetValue(this, false); return; }
		System.Reflection.FieldInfo Field = GetType().GetField("bEnableUndefinedIdentifierWarnings", Flags);
		if (Field != null) Field.SetValue(this, false);
	}
}
