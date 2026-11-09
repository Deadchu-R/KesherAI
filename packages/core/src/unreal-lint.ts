/**
 * Quick checks of Unreal C++ before a compile: the mistakes that cost a
 * whole build round (a minute or more, and a long error log in the chat)
 * and that a few lines of text matching can see at once. How others do it
 * (researched first): Rider and Visual Studio's Unreal support flag these
 * in the editor as you type (a reflected class without its .generated.h
 * last, a missing GENERATED_BODY, a wrong class prefix, a module the build
 * file does not list); UnrealHeaderTool reports them only when building.
 * KesherAI says them right when a file is written, so the model fixes them
 * before compiling.
 */

/** Modules whose headers need the module in the .Build.cs. */
const MODULE_OF: Array<[RegExp, string]> = [
  [/#include\s+"(Blueprint\/UserWidget|Components\/(TextBlock|Button|Image|ProgressBar|CanvasPanel\w*|VerticalBox|HorizontalBox|Border|Overlay))\.h"/, "UMG"],
  [/#include\s+"(EnhancedInputComponent|EnhancedInputSubsystems|InputMappingContext|InputAction)\.h"/, "EnhancedInput"],
  [/#include\s+"(NiagaraFunctionLibrary|NiagaraComponent|NiagaraSystem)\.h"/, "Niagara"],
  [/#include\s+"(NavigationSystem|AIController|Navigation\/PathFollowingComponent)\.h"/, "AIModule"],
  [/#include\s+"(Kismet\/GameplayStatics)\.h"/, "Engine"],
  [/#include\s+"(Slate\w*|Widgets\/\w+)\.h"/, "Slate"],
];

/** Base classes → the prefix Unreal requires for classes made from them. */
const PREFIX: Array<[RegExp, string]> = [
  [/:\s*public\s+(AActor|APawn|ACharacter|AGameModeBase|AGameMode|APlayerController|AHUD|AGameStateBase|APlayerState|AInfo|ALevelScriptActor)\b/, "A"],
  [/:\s*public\s+(UObject|UActorComponent|USceneComponent|UPrimitiveComponent|UStaticMeshComponent|UUserWidget|UGameInstance|UDataAsset|UPrimaryDataAsset|UBlueprintFunctionLibrary|UGameInstanceSubsystem|UWorldSubsystem)\b/, "U"],
];

/** Names Unreal 5.8 already declares globally: a helper of the same name becomes ambiguous (C2872). */
const ENGINE_GLOBALS = ["Error", "MakeError", "MakeValue", "Swap", "Exchange", "Align", "Lex"];

/**
 * @param rel - The file's path in the project, e.g. Source/Game/Enemy.h.
 * @param content - The new text.
 * @param buildCs - The module's .Build.cs text, if known.
 * @returns One line per problem (empty when none was seen).
 */
export function lintUnrealSource(rel: string, content: string, buildCs?: string): string[] {
  const out: string[] = [];
  const file = rel.replace(/\\/g, "/").split("/").pop() ?? rel;
  const base = file.replace(/\.(h|hpp|cpp)$/i, "");
  const isHeader = /\.(h|hpp)$/i.test(file);
  const reflected = /^\s*(UCLASS|USTRUCT|UENUM|UINTERFACE)\s*\(/m.test(content);
  if (isHeader && reflected) {
    const includes = [...content.matchAll(/^\s*#include\s+["<]([^">]+)[">]/gm)].map((m) => m[1] ?? "");
    const gen = includes.find((i) => /\.generated\.h$/i.test(i));
    if (!gen) out.push(`${file}: a header with UCLASS/USTRUCT/UENUM needs #include "${base}.generated.h" as its last #include.`);
    else {
      if (gen.toLowerCase() !== `${base}.generated.h`.toLowerCase()) out.push(`${file}: it includes "${gen}", but the file is ${file}: it must be "${base}.generated.h".`);
      if (includes.at(-1) !== gen) out.push(`${file}: "${gen}" must be the LAST #include (after "${includes.at(-1)}").`);
    }
    const types = (content.match(/^\s*(UCLASS|USTRUCT|UINTERFACE)\s*\(/gm) ?? []).length;
    const bodies = (content.match(/\bGENERATED_(BODY|UCLASS_BODY|USTRUCT_BODY|IINTERFACE_BODY)\s*\(/g) ?? []).length;
    if (bodies < types) out.push(`${file}: each UCLASS/USTRUCT needs GENERATED_BODY() as the first line inside it (${types} types, ${bodies} GENERATED_BODY).`);
  }
  if (isHeader) {
    for (const m of content.matchAll(/^\s*UCLASS\s*\([^)]*\)\s*class\s+(?:\w+_API\s+)?(\w+)\s*(:[^{]*)/gm)) {
      const [, name = "", bases = ""] = m;
      for (const [re, prefix] of PREFIX) if (re.test(bases) && !name.startsWith(prefix)) out.push(`${file}: ${name} derives from ${re.exec(bases)?.[1]}, so Unreal needs its name to start with "${prefix}" (e.g. ${prefix}${name.replace(/^[AUF]/, "")}).`);
    }
    for (const m of content.matchAll(/^\s*USTRUCT\s*\([^)]*\)\s*struct\s+(?:\w+_API\s+)?(\w+)/gm)) if (m[1] && !m[1].startsWith("F")) out.push(`${file}: the USTRUCT ${m[1]} must start with "F" (e.g. F${m[1]}).`);
  }
  // Free functions or namespace helpers with names Unreal already declares (found compiling a plugin on 5.8).
  for (const name of ENGINE_GLOBALS) {
    if (new RegExp(`^\\s*(static\\s+)?[\\w:<>,\\s*&]+\\s+${name}\\s*\\([^;]*\\)\\s*\\{`, "m").test(content) && !new RegExp(`::${name}\\s*\\(`).test(content)) out.push(`${file}: a function named ${name}() clashes with Unreal's own ${name} (ambiguous symbol): give it another name.`);
  }
  if (buildCs !== undefined) {
    for (const [re, mod] of MODULE_OF) if (re.test(content) && !new RegExp(`"${mod}"`).test(buildCs)) out.push(`${file}: it uses the ${mod} module, which the .Build.cs does not list: add "${mod}" to PublicDependencyModuleNames, or the link fails.`);
  }
  return out;
}

/**
 * The compiler's errors, shortened for the model: each distinct error once,
 * paths from Source/ on, at most `max` lines (a broken header repeats the
 * same error in every file that includes it).
 */
export function shortErrors(log: string, max = 30): { lines: string[]; total: number } {
  const all = log.split(/\r?\n/).filter((l) => /\berror\b|fatal/i.test(l) && !/^\s*(Result|Total execution time|Trace file)/i.test(l));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of all) {
    const short = l.trim().replace(/^.*?[\\/](Source|Plugins)[\\/]/, "$1/");
    const key = short.replace(/\(\d+(,\d+)?\)/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(short.slice(0, 400));
  }
  return { lines: lines.slice(0, max), total: lines.length };
}
