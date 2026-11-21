/**
 * Unreal Blueprints as plain data, so the Blueprint page can edit a graph with Unreal closed: the saved copy (the JSON
 * the KesherAI Bridge plugin's `graph` answers) is changed here with the same operations the plugin's `apply` runs,
 * and the queued operations show at once. When Unreal opens (or the headless editor syncs), the queue is applied
 * there, compiled, and Unreal's own answer replaces this copy.
 *
 * - {@link unrealPinsFit}: whether a wire from one pin type fits another, by Unreal's K2 schema rules (exec, numbers
 *   with conversion nodes, strings, structs by name, object / class / interface pins by class, wildcards).
 * - {@link bpNodeKind} / {@link isPureNode} / {@link bpHeadColor}: how a node is drawn (event, function, pure, macro…).
 * - {@link applyBpOps}: add, delete, move, connect, disconnect, set a pin's value, comment, resize, collapse to function.
 * - {@link COMMON_BP_ACTIONS} / {@link searchBpActions}: the node palette (the plugin's kept list, else common nodes).
 * - {@link mapCompileMessages}: compile errors and warnings tied to the nodes they are about.
 * - {@link parseBpDoc} / {@link serializeBpDoc} / {@link diffBpGraphs}: checked JSON and "sync on open".
 *
 * The data shape is the one the Unity Visual Scripting editor uses (unity-vs.ts), so both share the canvas.
 */
import { diffVsGraphs, parseVsDoc, type VsDiff, type VsDoc, type VsGraph, type VsNode, type VsPin, type VsResult } from "./unity-vs.js";

/** One pin: `exec`, else `category[:Sub][[]]` as the plugin names it (real, struct:Vector, object:Actor, wildcard…). */
export type BpPin = VsPin;
/** One node of a graph (K2Node_* class, comment box or reroute). */
export type BpNode = VsNode;
/** One graph of a Blueprint: the event graph, a function or a macro. */
export type BpGraph = VsGraph;
/** A whole Blueprint, as the plugin's `graph` answers it. */
export type BpDoc = VsDoc;
/** One operation (the plugin's `apply` vocabulary). */
export type BpOp = Record<string, unknown>;
/** The answer for one operation. */
export type BpResult = VsResult;
/** What changed between two versions of a Blueprint. */
export type BpDiff = VsDiff;

/** One entry of the node palette (the plugin's `actions` answer; plugin 0.1.26+ adds the function's pins). */
export interface BpAction {
  title: string;
  category: string;
  /** call, event, custom_event, branch, sequence, macro, get, set, cast, timeline, reroute, comment_box. */
  type: string;
  function?: string;
  event?: string;
  variable?: string;
  macro?: string;
  /** cast: the class cast to. */
  class?: string;
  name?: string;
  /** The pins the node gets (known for common nodes and for functions the plugin listed). */
  pins?: BpPin[];
  pure?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Pin types
// ---------------------------------------------------------------------------------------------------------------

/** Engine classes and their parents, so object pins can be checked with Unreal closed (child into parent fits). */
const CLASS_PARENT: Record<string, string> = {
  Actor: "Object", Pawn: "Actor", Character: "Pawn", DefaultPawn: "Pawn", WheeledVehiclePawn: "Pawn",
  Controller: "Actor", PlayerController: "Controller", AIController: "Controller",
  Info: "Actor", GameModeBase: "Info", GameMode: "GameModeBase", GameStateBase: "Info", GameState: "GameStateBase", PlayerState: "Info", WorldSettings: "Info",
  HUD: "Actor", PlayerCameraManager: "Actor", StaticMeshActor: "Actor", SkeletalMeshActor: "Actor", TriggerBase: "Actor", TriggerBox: "TriggerBase", TriggerSphere: "TriggerBase", Light: "Actor", PointLight: "Light", CameraActor: "Actor",
  ActorComponent: "Object", SceneComponent: "ActorComponent", PrimitiveComponent: "SceneComponent", MeshComponent: "PrimitiveComponent",
  StaticMeshComponent: "MeshComponent", InstancedStaticMeshComponent: "StaticMeshComponent", SkinnedMeshComponent: "MeshComponent", SkeletalMeshComponent: "SkinnedMeshComponent",
  ShapeComponent: "PrimitiveComponent", BoxComponent: "ShapeComponent", SphereComponent: "ShapeComponent", CapsuleComponent: "ShapeComponent",
  CameraComponent: "SceneComponent", SpringArmComponent: "SceneComponent", AudioComponent: "SceneComponent", LightComponent: "SceneComponent", PointLightComponent: "LightComponent", WidgetComponent: "MeshComponent", ChildActorComponent: "SceneComponent", ArrowComponent: "PrimitiveComponent", TextRenderComponent: "PrimitiveComponent", NiagaraComponent: "PrimitiveComponent",
  MovementComponent: "ActorComponent", NavMovementComponent: "MovementComponent", PawnMovementComponent: "NavMovementComponent", CharacterMovementComponent: "PawnMovementComponent", FloatingPawnMovement: "PawnMovementComponent", ProjectileMovementComponent: "MovementComponent", RotatingMovementComponent: "MovementComponent",
  Visual: "Object", Widget: "Visual", UserWidget: "Widget", PanelWidget: "Widget", ContentWidget: "PanelWidget", Button: "ContentWidget", Border: "ContentWidget", CanvasPanel: "PanelWidget", VerticalBox: "PanelWidget", HorizontalBox: "PanelWidget", TextLayoutWidget: "Widget", TextBlock: "TextLayoutWidget", Image: "Widget", ProgressBar: "Widget", Slider: "Widget", CheckBox: "ContentWidget", EditableTextBox: "Widget",
  GameInstance: "Object", SaveGame: "Object", DataAsset: "Object", PrimaryDataAsset: "DataAsset", DataTable: "Object", CurveFloat: "Object",
  Texture: "Object", Texture2D: "Texture", TextureRenderTarget2D: "Texture", MaterialInterface: "Object", Material: "MaterialInterface", MaterialInstance: "MaterialInterface", MaterialInstanceConstant: "MaterialInstance", MaterialInstanceDynamic: "MaterialInstance",
  StaticMesh: "Object", SkeletalMesh: "Object", SoundBase: "Object", SoundWave: "SoundBase", SoundCue: "SoundBase", AnimInstance: "Object", AnimSequenceBase: "Object", AnimMontage: "AnimSequenceBase", NiagaraSystem: "Object", ParticleSystem: "Object",
  World: "Object", Level: "Object", InputAction: "DataAsset", InputMappingContext: "DataAsset",
};

/** "BP_Enemy_C" and "BP_Enemy" are the same Blueprint class. */
const className = (c: string) => c.replace(/^.*[/.]/, "").replace(/_C$/, "");

/**
 * Whether one class is the other or a child of it, by the engine classes known here and the Blueprints' parents.
 *
 * @param child - The class (a name: Pawn, BP_Enemy_C…).
 * @param parent - The class it should be.
 * @param parents - Blueprint classes' parents (BP_Enemy → Character), from the project's Blueprint list.
 * @returns true / false, or undefined when the classes are not known here (Unreal decides when it syncs).
 */
export function isChildClass(child: string, parent: string, parents: Record<string, string> = {}): boolean | undefined {
  const want = className(parent);
  if (want === "Object") return true;
  let c: string | undefined = className(child);
  const seen = new Set<string>();
  while (c && !seen.has(c)) {
    if (c === want) return true;
    seen.add(c);
    const up: string | undefined = parents[c] ?? parents[`${c}_C`] ?? CLASS_PARENT[c];
    c = up ? className(up) : undefined;
  }
  // The whole chain up to Object is known and the class wanted is not on it: no. It ended at a class not known here
  // (a Blueprint whose parent was not listed, a plugin class): Unreal decides.
  return seen.has("Object") ? false : undefined;
}

const NUMBER = new Set(["int", "int64", "byte", "real", "float", "double"]);
/** Types Unreal turns into a string with a conversion node (To String). */
const TO_STRING = new Set(["int", "int64", "byte", "real", "float", "double", "bool", "name", "text"]);
const TO_STRING_STRUCTS = new Set(["Vector", "Vector2D", "Rotator", "Transform", "LinearColor", "IntPoint", "IntVector"]);

/** A pin type's parts: category, sub type (struct, class or enum name) and whether it is a list. */
export function pinParts(type: string): { cat: string; sub: string; list: boolean } {
  const list = /\[\]$/.test(type);
  const t = list ? type.slice(0, -2) : type;
  const i = t.indexOf(":");
  return { cat: (i < 0 ? t : t.slice(0, i)).toLowerCase(), sub: i < 0 ? "" : t.slice(i + 1), list };
}

/**
 * Whether a wire from an output pin of one type fits an input pin of another, as Unreal's K2 schema decides while
 * dragging: exec only to exec; a wildcard takes any value type (the node then takes that type); numbers convert
 * (Unreal adds the conversion node); numbers, bool, name, text and some structs into a string, string ↔ name / text;
 * structs only to the same struct; an object into a pin of its class or a parent class (soft references convert);
 * classes the same way; lists only to lists.
 *
 * @param from - The output pin's type.
 * @param to - The input pin's type.
 * @param parents - Blueprint classes' parents, for Blueprint object pins.
 * @returns ok, and in short why (a conversion's direction, or why it does not fit).
 */
export function unrealPinsFit(from: string, to: string, parents: Record<string, string> = {}): { ok: boolean; why: string } {
  const a = pinParts(from);
  const b = pinParts(to);
  if ((a.cat === "exec") !== (b.cat === "exec")) return { ok: false, why: "Exec ≠ value" };
  if (a.cat === "exec") return { ok: true, why: "" };
  if (a.cat === "wildcard" || b.cat === "wildcard") {
    if (a.list !== b.list && !(a.cat === "wildcard" && b.cat === "wildcard")) return { ok: false, why: a.list ? "A list into a single value" : "A single value into a list" };
    return { ok: true, why: a.cat === b.cat ? "" : `→ ${a.cat === "wildcard" ? to : from}` };
  }
  if (a.list !== b.list) return { ok: false, why: `${from} ≠ ${to}` };
  if (from === to) return { ok: true, why: "" };
  if (NUMBER.has(a.cat) && NUMBER.has(b.cat)) {
    // Two different enums (byte:EFoo / byte:EBar) do not mix.
    if (a.sub && b.sub && a.sub !== b.sub) return { ok: false, why: `${a.sub} ≠ ${b.sub}` };
    return { ok: true, why: a.cat === b.cat ? "" : `${a.cat} → ${b.cat}` };
  }
  if (a.cat === "enum" && b.cat === "enum") return a.sub === b.sub || !a.sub || !b.sub ? { ok: true, why: "" } : { ok: false, why: `${a.sub} ≠ ${b.sub}` };
  if (!a.list && b.cat === "string" && (TO_STRING.has(a.cat) || (a.cat === "struct" && TO_STRING_STRUCTS.has(a.sub)))) return { ok: true, why: `${a.sub || a.cat} → string` };
  if (!a.list && a.cat === "string" && (b.cat === "name" || b.cat === "text")) return { ok: true, why: `string → ${b.cat}` };
  if (!a.list && a.cat === "name" && b.cat === "text") return { ok: true, why: "name → text" };
  if (a.cat === "struct" && b.cat === "struct") return !a.sub || !b.sub || a.sub === b.sub ? { ok: true, why: "" } : { ok: false, why: `${a.sub} ≠ ${b.sub}` };
  const objects = new Set(["object", "softobject", "interface"]);
  const classes = new Set(["class", "softclass"]);
  const sameFamily = (objects.has(a.cat) && objects.has(b.cat)) || (classes.has(a.cat) && classes.has(b.cat));
  if (sameFamily) {
    if (a.cat === "interface" || b.cat === "interface") return { ok: true, why: a.cat === b.cat ? "" : "checked by Unreal" };
    const soft = a.cat !== b.cat ? `${a.cat} → ${b.cat}` : "";
    if (!a.sub || !b.sub) return { ok: true, why: soft };
    const child = isChildClass(a.sub, b.sub, parents);
    if (child === false) return { ok: false, why: `${className(a.sub)} is not a ${className(b.sub)}` };
    return { ok: true, why: child === undefined ? soft || "checked by Unreal" : soft };
  }
  if (a.cat === b.cat && (!a.sub || !b.sub || a.sub === b.sub)) return { ok: true, why: "" };
  return { ok: false, why: `${from} ≠ ${to}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------------------------------------------

/** How a node is drawn, as in Unreal's graph editor. */
export type BpNodeKind = "event" | "function" | "pure" | "macro" | "loop" | "variable" | "flow" | "cast" | "timeline" | "entry" | "comment" | "reroute" | "other";

const EVENT_CLASSES = /^K2Node_(Event|CustomEvent|ComponentBoundEvent|ActorBoundEvent|InputAction|InputAxisEvent|InputKey|InputTouch|EnhancedInputAction|InputActionEvent)$/;
const FLOW_CLASSES = /^K2Node_(IfThenElse|ExecutionSequence|Switch\w*|Select|MultiGate|DoOnceMultiInput)$/;

/** @returns Whether a node has no execution pins (a pure function, a getter, math): it runs when its value is read. */
export function isPureNode(n: Pick<BpNode, "class" | "pins">): boolean {
  if (/Comment|Knot|Event|FunctionEntry|FunctionResult|Tunnel/.test(n.class)) return false;
  return !n.pins.some((p) => p.type === "exec");
}

/**
 * What kind of node this is (for its header colour and the palette's grouping).
 *
 * @param n - The node.
 * @returns event, function, pure, macro, loop, variable, flow, cast, timeline, entry, comment, reroute or other.
 */
export function bpNodeKind(n: Pick<BpNode, "class" | "pins" | "title">): BpNodeKind {
  const c = n.class;
  if (c === "EdGraphNode_Comment") return "comment";
  if (c === "K2Node_Knot") return "reroute";
  if (EVENT_CLASSES.test(c)) return "event";
  if (/^K2Node_(FunctionEntry|FunctionResult|Tunnel)$/.test(c)) return "entry";
  if (c === "K2Node_MacroInstance") return /Loop/.test(n.title) ? "loop" : "macro";
  if (/^K2Node_Variable(Get|Set)?$|^K2Node_(Self|StructMemberGet|StructMemberSet)$/.test(c)) return "variable";
  if (FLOW_CLASSES.test(c)) return "flow";
  if (/^K2Node_(Dynamic|ClassDynamic)Cast$/.test(c)) return "cast";
  if (c === "K2Node_Timeline") return "timeline";
  if (/^K2Node_/.test(c)) return isPureNode(n) ? "pure" : "function";
  return "other";
}

/** Header colours by kind, close to Unreal's (events red, functions blue, pure green, macros grey…). */
const HEAD: Record<BpNodeKind, string> = {
  event: "#7a1f1f", function: "#1f4f7a", pure: "#3d6b2e", macro: "#4a4a55", loop: "#4a4a55", variable: "#2c5a2c",
  flow: "#3a3a44", cast: "#1d5f63", timeline: "#7a5a1f", entry: "#5a2c6b", comment: "#3a3a44", reroute: "#3a3a44", other: "#3a3a44",
};

/** @returns The header colour of a node. */
export function bpHeadColor(n: Pick<BpNode, "class" | "pins" | "title">): string {
  return HEAD[bpNodeKind(n)];
}

// ---------------------------------------------------------------------------------------------------------------
// Common nodes (the palette with Unreal never read, and the pins of nodes added with Unreal closed)
// ---------------------------------------------------------------------------------------------------------------

const P = (name: string, dir: "in" | "out", type: string, label?: string, def?: string): BpPin => ({ name, dir, type, ...(label ? { label } : {}), ...(def !== undefined ? { default: def } : {}) });
const EXEC_IN = P("execute", "in", "exec");
const EXEC_OUT = P("then", "out", "exec");

/** Common nodes with their pins as the plugin names them (pin names Unreal's FindPin also accepts). */
const COMMON: Array<BpAction & { class: string; pins: BpPin[] }> = [
  { title: "Branch", category: "Flow Control", type: "branch", class: "K2Node_IfThenElse", pins: [EXEC_IN, P("Condition", "in", "bool", undefined, "false"), P("then", "out", "exec", "True"), P("else", "out", "exec", "False")] },
  { title: "Sequence", category: "Flow Control", type: "sequence", class: "K2Node_ExecutionSequence", pins: [EXEC_IN, P("then_0", "out", "exec", "Then 0"), P("then_1", "out", "exec", "Then 1")] },
  { title: "Event BeginPlay", category: "Add Event", type: "event", event: "ReceiveBeginPlay", class: "K2Node_Event", pins: [EXEC_OUT] },
  { title: "Event Tick", category: "Add Event", type: "event", event: "ReceiveTick", class: "K2Node_Event", pins: [EXEC_OUT, P("DeltaSeconds", "out", "real", "Delta Seconds")] },
  { title: "Event ActorBeginOverlap", category: "Add Event", type: "event", event: "ReceiveActorBeginOverlap", class: "K2Node_Event", pins: [EXEC_OUT, P("OtherActor", "out", "object:Actor", "Other Actor")] },
  { title: "Event ActorEndOverlap", category: "Add Event", type: "event", event: "ReceiveActorEndOverlap", class: "K2Node_Event", pins: [EXEC_OUT, P("OtherActor", "out", "object:Actor", "Other Actor")] },
  { title: "Event Hit", category: "Add Event", type: "event", event: "ReceiveHit", class: "K2Node_Event", pins: [EXEC_OUT, P("MyComp", "out", "object:PrimitiveComponent", "My Comp"), P("Other", "out", "object:Actor"), P("OtherComp", "out", "object:PrimitiveComponent", "Other Comp"), P("HitLocation", "out", "struct:Vector", "Hit Location"), P("Hit", "out", "struct:HitResult")] },
  { title: "Event EndPlay", category: "Add Event", type: "event", event: "ReceiveEndPlay", class: "K2Node_Event", pins: [EXEC_OUT, P("EndPlayReason", "out", "byte:EEndPlayReason", "End Play Reason")] },
  { title: "Event Destroyed", category: "Add Event", type: "event", event: "ReceiveDestroyed", class: "K2Node_Event", pins: [EXEC_OUT] },
  { title: "Event AnyDamage", category: "Add Event", type: "event", event: "ReceiveAnyDamage", class: "K2Node_Event", pins: [EXEC_OUT, P("Damage", "out", "real"), P("DamageType", "out", "object:DamageType", "Damage Type"), P("InstigatedBy", "out", "object:Controller", "Instigated By"), P("DamageCauser", "out", "object:Actor", "Damage Causer")] },
  { title: "Add Custom Event…", category: "Add Event", type: "custom_event", name: "NewEvent", class: "K2Node_CustomEvent", pins: [EXEC_OUT] },
  { title: "Print String", category: "Development", type: "call", function: "KismetSystemLibrary:PrintString", class: "K2Node_CallFunction", pins: [EXEC_IN, EXEC_OUT, P("InString", "in", "string", "In String", "Hello"), P("bPrintToScreen", "in", "bool", "Print to Screen", "true"), P("bPrintToLog", "in", "bool", "Print to Log", "true"), P("TextColor", "in", "struct:LinearColor", "Text Color"), P("Duration", "in", "real", undefined, "2.0")] },
  { title: "Delay", category: "Utilities|FlowControl", type: "call", function: "KismetSystemLibrary:Delay", class: "K2Node_CallFunction", pins: [EXEC_IN, P("then", "out", "exec", "Completed"), P("Duration", "in", "real", undefined, "0.2")] },
  { title: "Is Valid", category: "Utilities", type: "call", function: "KismetSystemLibrary:IsValid", class: "K2Node_CallFunction", pure: true, pins: [P("Object", "in", "object:Object"), P("ReturnValue", "out", "bool", "Return Value")] },
  { title: "Get Player Pawn", category: "Game", type: "call", function: "GameplayStatics:GetPlayerPawn", class: "K2Node_CallFunction", pure: true, pins: [P("PlayerIndex", "in", "int", "Player Index", "0"), P("ReturnValue", "out", "object:Pawn", "Return Value")] },
  { title: "Get Player Character", category: "Game", type: "call", function: "GameplayStatics:GetPlayerCharacter", class: "K2Node_CallFunction", pure: true, pins: [P("PlayerIndex", "in", "int", "Player Index", "0"), P("ReturnValue", "out", "object:Character", "Return Value")] },
  { title: "Get Player Controller", category: "Game", type: "call", function: "GameplayStatics:GetPlayerController", class: "K2Node_CallFunction", pure: true, pins: [P("PlayerIndex", "in", "int", "Player Index", "0"), P("ReturnValue", "out", "object:PlayerController", "Return Value")] },
  { title: "Get Actor Location", category: "Transformation", type: "call", function: "Actor:K2_GetActorLocation", class: "K2Node_CallFunction", pure: true, pins: [P("self", "in", "object:Actor", "Target"), P("ReturnValue", "out", "struct:Vector", "Return Value")] },
  { title: "Set Actor Location", category: "Transformation", type: "call", function: "Actor:K2_SetActorLocation", class: "K2Node_CallFunction", pins: [EXEC_IN, EXEC_OUT, P("self", "in", "object:Actor", "Target"), P("NewLocation", "in", "struct:Vector", "New Location"), P("bSweep", "in", "bool", "Sweep", "false"), P("ReturnValue", "out", "bool", "Return Value")] },
  { title: "Destroy Actor", category: "Actor", type: "call", function: "Actor:K2_DestroyActor", class: "K2Node_CallFunction", pins: [EXEC_IN, EXEC_OUT, P("self", "in", "object:Actor", "Target")] },
  { title: "Play Sound at Location", category: "Audio", type: "call", function: "GameplayStatics:PlaySoundAtLocation", class: "K2Node_CallFunction", pins: [EXEC_IN, EXEC_OUT, P("Sound", "in", "object:SoundBase"), P("Location", "in", "struct:Vector"), P("VolumeMultiplier", "in", "real", "Volume Multiplier", "1.0")] },
  { title: "Open Level (by Name)", category: "Game", type: "call", function: "GameplayStatics:OpenLevel", class: "K2Node_CallFunction", pins: [EXEC_IN, EXEC_OUT, P("LevelName", "in", "name", "Level Name"), P("bAbsolute", "in", "bool", "Absolute", "true")] },
  { title: "Add (float)", category: "Math|Float", type: "call", function: "KismetMathLibrary:Add_DoubleDouble", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "real", undefined, "0.0"), P("B", "in", "real", undefined, "0.0"), P("ReturnValue", "out", "real", "Return Value")] },
  { title: "Subtract (float)", category: "Math|Float", type: "call", function: "KismetMathLibrary:Subtract_DoubleDouble", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "real", undefined, "0.0"), P("B", "in", "real", undefined, "0.0"), P("ReturnValue", "out", "real", "Return Value")] },
  { title: "Multiply (float)", category: "Math|Float", type: "call", function: "KismetMathLibrary:Multiply_DoubleDouble", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "real", undefined, "0.0"), P("B", "in", "real", undefined, "0.0"), P("ReturnValue", "out", "real", "Return Value")] },
  { title: "Greater (float)", category: "Math|Float", type: "call", function: "KismetMathLibrary:Greater_DoubleDouble", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "real", undefined, "0.0"), P("B", "in", "real", undefined, "0.0"), P("ReturnValue", "out", "bool", "Return Value")] },
  { title: "Less (float)", category: "Math|Float", type: "call", function: "KismetMathLibrary:Less_DoubleDouble", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "real", undefined, "0.0"), P("B", "in", "real", undefined, "0.0"), P("ReturnValue", "out", "bool", "Return Value")] },
  { title: "Clamp (float)", category: "Math|Float", type: "call", function: "KismetMathLibrary:FClamp", class: "K2Node_CallFunction", pure: true, pins: [P("Value", "in", "real", undefined, "0.0"), P("Min", "in", "real", undefined, "0.0"), P("Max", "in", "real", undefined, "1.0"), P("ReturnValue", "out", "real", "Return Value")] },
  { title: "NOT Boolean", category: "Math|Boolean", type: "call", function: "KismetMathLibrary:Not_PreBool", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "bool", undefined, "false"), P("ReturnValue", "out", "bool", "Return Value")] },
  { title: "AND Boolean", category: "Math|Boolean", type: "call", function: "KismetMathLibrary:BooleanAND", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "bool", undefined, "false"), P("B", "in", "bool", undefined, "false"), P("ReturnValue", "out", "bool", "Return Value")] },
  { title: "Make Vector", category: "Math|Vector", type: "call", function: "KismetMathLibrary:MakeVector", class: "K2Node_CallFunction", pure: true, pins: [P("X", "in", "real", undefined, "0.0"), P("Y", "in", "real", undefined, "0.0"), P("Z", "in", "real", undefined, "0.0"), P("ReturnValue", "out", "struct:Vector", "Return Value")] },
  { title: "Append", category: "Utilities|String", type: "call", function: "KismetStringLibrary:Concat_StrStr", class: "K2Node_CallFunction", pure: true, pins: [P("A", "in", "string"), P("B", "in", "string"), P("ReturnValue", "out", "string", "Return Value")] },
  { title: "Length (Array)", category: "Utilities|Array", type: "call", function: "KismetArrayLibrary:Array_Length", class: "K2Node_CallFunction", pure: true, pins: [P("TargetArray", "in", "wildcard[]", "Target Array"), P("ReturnValue", "out", "int", "Return Value")] },
  { title: "Get (a copy)", category: "Utilities|Array", type: "call", function: "KismetArrayLibrary:Array_Get", class: "K2Node_CallFunction", pure: true, pins: [P("TargetArray", "in", "wildcard[]", "Target Array"), P("Index", "in", "int", undefined, "0"), P("Item", "out", "wildcard")] },
  { title: "For Each Loop", category: "Utilities|Array", type: "macro", macro: "ForEachLoop", class: "K2Node_MacroInstance", pins: [P("Exec", "in", "exec"), P("Array", "in", "wildcard[]"), P("LoopBody", "out", "exec", "Loop Body"), P("Array Element", "out", "wildcard"), P("Array Index", "out", "int"), P("Completed", "out", "exec")] },
  { title: "For Loop", category: "Utilities|Flow Control", type: "macro", macro: "ForLoop", class: "K2Node_MacroInstance", pins: [P("Exec", "in", "exec"), P("FirstIndex", "in", "int", "First Index", "0"), P("LastIndex", "in", "int", "Last Index", "0"), P("LoopBody", "out", "exec", "Loop Body"), P("Index", "out", "int"), P("Completed", "out", "exec")] },
  { title: "For Loop with Break", category: "Utilities|Flow Control", type: "macro", macro: "ForLoopWithBreak", class: "K2Node_MacroInstance", pins: [P("Exec", "in", "exec"), P("FirstIndex", "in", "int", "First Index", "0"), P("LastIndex", "in", "int", "Last Index", "0"), P("Break", "in", "exec"), P("LoopBody", "out", "exec", "Loop Body"), P("Index", "out", "int"), P("Completed", "out", "exec")] },
  { title: "While Loop", category: "Utilities|Flow Control", type: "macro", macro: "WhileLoop", class: "K2Node_MacroInstance", pins: [P("Exec", "in", "exec"), P("Condition", "in", "bool", undefined, "false"), P("LoopBody", "out", "exec", "Loop Body"), P("Completed", "out", "exec")] },
  { title: "Do Once", category: "Utilities|Flow Control", type: "macro", macro: "DoOnce", class: "K2Node_MacroInstance", pins: [EXEC_IN, P("Reset", "in", "exec"), P("Start Closed", "in", "bool", undefined, "false"), P("Completed", "out", "exec")] },
  { title: "Do N", category: "Utilities|Flow Control", type: "macro", macro: "DoN", class: "K2Node_MacroInstance", pins: [P("Enter", "in", "exec"), P("N", "in", "int", undefined, "1"), P("Reset", "in", "exec"), P("Exit", "out", "exec"), P("Counter", "out", "int")] },
  { title: "Gate", category: "Utilities|Flow Control", type: "macro", macro: "Gate", class: "K2Node_MacroInstance", pins: [P("Enter", "in", "exec"), P("Open", "in", "exec"), P("Close", "in", "exec"), P("Toggle", "in", "exec"), P("Start Closed", "in", "bool", undefined, "false"), P("Exit", "out", "exec")] },
  { title: "Flip Flop", category: "Utilities|Flow Control", type: "macro", macro: "FlipFlop", class: "K2Node_MacroInstance", pins: [EXEC_IN, P("A", "out", "exec"), P("B", "out", "exec"), P("Is A", "out", "bool")] },
  { title: "MultiGate", category: "Utilities|Flow Control", type: "macro", macro: "MultiGate", class: "K2Node_MacroInstance", pins: [EXEC_IN, P("Reset", "in", "exec"), P("Is Random", "in", "bool", undefined, "false"), P("Loop", "in", "bool", undefined, "false"), P("Start Index", "in", "int", undefined, "-1"), P("Out 0", "out", "exec"), P("Out 1", "out", "exec")] },
  { title: "Is Valid (macro)", category: "Utilities", type: "macro", macro: "IsValid", class: "K2Node_MacroInstance", pins: [P("Exec", "in", "exec"), P("InputObject", "in", "object:Object", "Input Object"), P("Is Valid", "out", "exec"), P("Is Not Valid", "out", "exec")] },
  { title: "Add Timeline…", category: "Add Timeline", type: "timeline", name: "Timeline", class: "K2Node_Timeline", pins: [P("Play", "in", "exec"), P("PlayFromStart", "in", "exec", "Play from Start"), P("Stop", "in", "exec"), P("Reverse", "in", "exec"), P("ReverseFromEnd", "in", "exec", "Reverse from End"), P("SetNewTime", "in", "exec", "Set New Time"), P("NewTime", "in", "real", "New Time", "0.0"), P("Update", "out", "exec"), P("Finished", "out", "exec"), P("Direction", "out", "byte:ETimelineDirection")] },
  { title: "Add Reroute Node", category: "Utilities", type: "reroute", class: "K2Node_Knot", pins: [P("InputPin", "in", "wildcard"), P("OutputPin", "out", "wildcard")] },
  { title: "Add Comment", category: "Utilities", type: "comment_box", class: "EdGraphNode_Comment", pins: [] },
];

/** Classes offered as "Cast To …" with Unreal never read (the project's Blueprints are added by the page). */
const CAST_CLASSES = ["Actor", "Pawn", "Character", "PlayerController", "AIController", "GameModeBase", "GameStateBase", "PlayerState", "HUD", "UserWidget", "GameInstance", "SaveGame", "StaticMeshComponent", "SkeletalMeshComponent", "PrimitiveComponent"];

/** The palette with Unreal never read: common nodes and casts (the plugin's own list is added once read). */
export const COMMON_BP_ACTIONS: BpAction[] = [
  ...COMMON.map(({ class: _c, ...a }) => a),
  ...CAST_CLASSES.map((c) => ({ title: `Cast To ${c}`, category: "Utilities|Casting", type: "cast", class: c })),
];

/** The pins of a "Cast To" node. */
function castPins(cls: string): BpPin[] {
  const short = className(cls);
  return [EXEC_IN, P("Object", "in", "object:Object"), EXEC_OUT, P("CastFailed", "out", "exec", "Cast Failed"), P(`As${short}`, "out", `object:${cls.startsWith("/") ? `${short}_C` : short}`, `As ${short}`)];
}

/** The pins an action's node gets with Unreal closed (undefined when they are not known here). */
export function actionPins(a: Pick<BpAction, "type" | "function" | "event" | "macro" | "class" | "pins">): BpPin[] | undefined {
  if (a.pins?.length) return a.pins;
  if (a.type === "cast" && a.class) return castPins(a.class);
  const c = COMMON.find((x) => x.type === a.type && (a.type === "call" ? x.function === a.function : a.type === "event" ? x.event === a.event : a.type === "macro" ? x.macro === a.macro : true));
  return c?.pins;
}

/**
 * The node palette's matches: every word typed must be in the title, category or function (any order, any case);
 * titles that start with the words come first. Dragged from a pin, only nodes with a pin that can take the wire
 * (nodes whose pins are not known here are left out then, except events and flow nodes from an exec pin).
 *
 * @param actions - The actions to search (the plugin's kept list and {@link COMMON_BP_ACTIONS}).
 * @param query - The words typed.
 * @param from - The pin dragged from (its type and side), for "Context Sensitive".
 * @param parents - Blueprint classes' parents (for object pins).
 * @param limit - At most this many.
 * @returns The matches, best first, each once.
 */
export function searchBpActions(actions: BpAction[], query: string, from?: { type: string; dir: "in" | "out" }, parents: Record<string, string> = {}, limit = 60): BpAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const out: Array<{ a: BpAction; rank: number }> = [];
  for (const a of actions) {
    if (!a || typeof a.title !== "string") continue;
    const k = `${a.type}|${a.function ?? a.event ?? a.variable ?? a.macro ?? a.class ?? ""}|${a.title}`;
    if (seen.has(k)) continue;
    const hay = `${a.title} ${a.category} ${a.function ?? ""} ${a.event ?? ""} ${a.macro ?? ""}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    if (from && !actionFits(a, from, parents)) continue;
    seen.add(k);
    out.push({ a, rank: a.title.toLowerCase().startsWith(words.join(" ")) ? 0 : 1 });
  }
  return out.sort((x, y) => x.rank - y.rank).slice(0, limit).map((x) => x.a);
}

/** Whether an action's node has a pin that takes a wire from the dragged pin. */
function actionFits(a: BpAction, from: { type: string; dir: "in" | "out" }, parents: Record<string, string>): boolean {
  const want = from.dir === "out" ? "in" : "out";
  const pins = actionPins(a);
  if (!pins) return from.type === "exec" && a.type !== "get";
  return pins.some((p) => p.dir === want && (want === "in" ? unrealPinsFit(from.type, p.type, parents) : unrealPinsFit(p.type, from.type, parents)).ok);
}

/** "ReceiveBeginPlay" → "BeginPlay"; "OnOpened" stays. */
const eventShown = (e: string) => e.replace(/^Receive/, "");

/**
 * The title, class and pins a node gets when it is added with Unreal closed: a common node's or a listed function's
 * pins when known, else a guess from its kind (calls: execute / then). Unreal's answer after the sync replaces them.
 *
 * @param op - The add operation (its `pins` field, when the page or server knew them, is used first).
 * @param doc - The Blueprint (variables for get / set).
 * @returns The title, class and pins.
 */
export function bpNodeTemplate(op: BpOp, doc: Pick<BpDoc, "variables">): { title: string; class: string; pins: BpPin[] } {
  const type = String(op.type ?? "");
  const given = Array.isArray(op.pins) ? (op.pins as BpPin[]).filter((p) => p && typeof p.name === "string").map((p) => ({ name: p.name, dir: p.dir === "out" ? "out" as const : "in" as const, type: String(p.type ?? "wildcard"), ...(p.label ? { label: String(p.label) } : {}), ...(p.default !== undefined ? { default: String(p.default) } : {}) })) : undefined;
  const fn = String(op.function ?? "");
  const short = fn.split(":").pop() ?? fn;
  switch (type) {
    case "call": {
      const c = COMMON.find((x) => x.type === "call" && x.function === fn);
      return { title: c?.title ?? spaced(short.replace(/^K2_/, "")), class: "K2Node_CallFunction", pins: given ?? c?.pins ?? [EXEC_IN, EXEC_OUT] };
    }
    case "event": {
      const ev = String(op.event ?? "");
      const c = COMMON.find((x) => x.type === "event" && x.event === ev);
      return { title: c?.title ?? `Event ${eventShown(ev)}`, class: "K2Node_Event", pins: given ?? c?.pins ?? [EXEC_OUT] };
    }
    case "custom_event":
      return { title: String(op.name ?? "NewEvent"), class: "K2Node_CustomEvent", pins: [EXEC_OUT] };
    case "macro": {
      const m = String(op.macro ?? "");
      const c = COMMON.find((x) => x.type === "macro" && x.macro === m);
      return { title: c?.title ?? spaced(m), class: "K2Node_MacroInstance", pins: given ?? c?.pins ?? [P("Exec", "in", "exec"), P("Completed", "out", "exec")] };
    }
    case "cast": {
      const cls = String(op.class ?? "Actor");
      return { title: `Cast To ${className(cls)}`, class: "K2Node_DynamicCast", pins: castPins(cls) };
    }
    case "get":
    case "set": {
      const name = String(op.variable ?? "");
      const v = doc.variables.find((x) => x.name === name);
      const t = varPinType(v);
      return type === "get"
        ? { title: name, class: "K2Node_VariableGet", pins: [P(name, "out", t)] }
        : { title: `Set ${name}`, class: "K2Node_VariableSet", pins: [EXEC_IN, P(name, "in", t), EXEC_OUT, P("Output_Get", "out", t)] };
    }
    default: {
      const c = COMMON.find((x) => x.type === type);
      if (!c) throw new Error(`Unknown node type ${type}`);
      return { title: type === "timeline" ? String(op.name ?? "Timeline") : c.title, class: c.class, pins: c.pins };
    }
  }
}

/** A variable's pin type (the plugin's `type` has no list mark; `ptype` has it). */
function varPinType(v: { type: string; ptype?: string } | undefined): string {
  if (!v) return "wildcard";
  const base = v.type.replace(/\[\]$/, "");
  return v.ptype?.endsWith("[]") || v.type.endsWith("[]") ? `${base}[]` : base;
}

/** "PrintString" → "Print String". */
function spaced(s: string): string {
  return s.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------------------------

/** A pin's key on a wire ("node:pin"). */
const key = (node: string, pin: string) => `${node}:${pin}`;
const split = (link: string): [string, string] => {
  const i = link.indexOf(":");
  return [link.slice(0, i), link.slice(i + 1)];
};

/** Checks a value typed into an input pin, as Unreal's TrySetDefaultValue would take it. */
function checkValue(type: string, value: string): string | undefined {
  const { cat, list } = pinParts(type);
  if (list) return "A list has no value to type: wire one in";
  if (cat === "bool" && !/^(true|false)$/i.test(value)) return "Type true or false";
  if ((cat === "int" || cat === "int64") && !/^-?\d+$/.test(value.trim())) return "Type a whole number";
  if ((cat === "real" || cat === "float" || cat === "double") && !Number.isFinite(Number(value.trim()))) return "Type a number";
  if (cat === "exec") return "An execution pin has no value";
  return undefined;
}

/** Pins of these nodes can never be collapsed into a function (Unreal says the same). */
const NOT_COLLAPSIBLE = /Event|FunctionEntry|FunctionResult|Tunnel|Timeline/;

/**
 * Applies operations to one graph of a Blueprint, as the KesherAI Bridge plugin does in Unreal, without changing the
 * input (a changed copy is returned). Each operation answers on its own; a failed one changes nothing.
 *
 * Operations: `add` (type: call + function, event + event, custom_event + name, branch, sequence, macro + macro,
 * get / set + variable, cast + class, timeline + name, reroute, comment_box + width, height, text; `ref` names it
 * for later operations; `id` keeps a given id; `pins` gives the pins when known), `delete`, `move`, `connect`
 * (from → to, with {@link unrealPinsFit}; a data input and an exec output keep one wire, so the old one goes; a
 * wildcard pin takes the type wired to it), `disconnect` (a pin's wires, or one `link`), `set` (an input pin's value,
 * checked), `comment`, `resize` (comment boxes), `collapse` (nodes + name: a new function with the nodes, and a call
 * to it in their place, wires across kept through it).
 *
 * @param doc - The Blueprint.
 * @param graphName - The graph (the first one when not found).
 * @param ops - The operations, in order.
 * @param options - `newId` makes the id of an added node; `parents` Blueprint classes' parents (object pins).
 * @returns The changed copy and one result per operation.
 */
export function applyBpOps(doc: BpDoc, graphName: string, ops: BpOp[], options: { newId?: (n: number) => string; parents?: Record<string, string> } = {}): { doc: BpDoc; results: BpResult[] } {
  let copy: BpDoc = JSON.parse(JSON.stringify(doc)) as BpDoc;
  const tabName = (copy.graphs.find((g) => g.name === graphName) ?? copy.graphs[0])?.name;
  if (tabName === undefined) return { doc: copy, results: ops.map((o) => ({ op: String(o.op ?? ""), ok: false, error: "The Blueprint has no graphs" })) };
  const refs = new Map<string, string>();
  let counter = 0;
  const results: BpResult[] = [];
  for (const op of ops) {
    const kind = String(op.op ?? "");
    // Each operation works on its own copy, so a failed one changes nothing.
    const work: BpDoc = JSON.parse(JSON.stringify(copy)) as BpDoc;
    const tab = work.graphs.find((g) => g.name === tabName)!;
    const allIds = () => new Set(work.graphs.flatMap((g) => g.nodes.map((n) => n.id)));
    const makeId = (want?: unknown) => {
      const ids = allIds();
      if (typeof want === "string" && want && !ids.has(want)) return want;
      let id = "";
      do id = options.newId ? options.newId(++counter) : `new-${tab.nodes.length + ++counter}`;
      while (ids.has(id));
      return id;
    };
    const nodeOf = (id: unknown) => {
      const s = String(id ?? "");
      const real = refs.get(s) ?? s;
      return tab.nodes.find((n) => n.id === real);
    };
    // Pin names as Unreal's FindPin takes them: the name or the label, any case; "exec"/"then" for the first exec pin.
    const pinOf = (n: BpNode | undefined, name: unknown, dir?: "in" | "out") => {
      const s = String(name ?? "").toLowerCase();
      const pins = n?.pins.filter((p) => !dir || p.dir === dir) ?? [];
      return pins.find((p) => p.name.toLowerCase() === s || p.label?.toLowerCase() === s) ?? (/^(exec|execute|then|in|out)$/.test(s) ? pins.find((p) => p.type === "exec") : undefined);
    };
    const unlink = (n: BpNode, p: BpPin, only?: string) => {
      for (const l of p.links ?? []) {
        if (only && l !== only) continue;
        const [on, opin] = split(l);
        const other = tab.nodes.find((x) => x.id === on)?.pins.find((x) => x.name === opin && x.dir !== p.dir);
        if (other?.links) {
          other.links = other.links.filter((x) => x !== key(n.id, p.name));
          if (!other.links.length) delete other.links;
        }
      }
      p.links = only ? (p.links ?? []).filter((l) => l !== only) : [];
      if (!p.links.length) delete p.links;
    };
    let error: string | undefined;
    let made: string | undefined;
    try {
      switch (kind) {
        case "add": {
          const type = String(op.type ?? "");
          if (!type) throw new Error("Which node?");
          const x = Math.round(Number(op.x ?? 0) || 0);
          const y = Math.round(Number(op.y ?? 0) || 0);
          if (type === "comment_box") {
            const id = makeId(op.id);
            const text = String(op.text ?? "Comment").slice(0, 300) || "Comment";
            tab.nodes.push({ id, title: text, comment: text, class: "EdGraphNode_Comment", x, y, width: Math.min(8000, Math.max(64, Number(op.width ?? 400) || 400)), height: Math.min(8000, Math.max(64, Number(op.height ?? 200) || 200)), ...(typeof op.color === "string" ? { color: op.color } : {}), pins: [] });
            made = id;
          } else {
            if (type === "call" && !op.function) throw new Error("Which function?");
            if ((type === "get" || type === "set") && !work.variables.some((v) => v.name === String(op.variable ?? ""))) throw new Error(`No variable ${String(op.variable ?? "")}`);
            if (type === "custom_event" && !/^\w+$/.test(String(op.name ?? ""))) throw new Error("A custom event needs a name (letters, digits, _)");
            if (type === "timeline" && work.graphs.some((g) => g.nodes.some((n) => n.class === "K2Node_Timeline" && n.title === String(op.name ?? "Timeline")))) throw new Error(`A timeline named ${String(op.name ?? "Timeline")} already exists`);
            if (type === "timeline" && tab.kind !== "event") throw new Error("Timelines go in the event graph (not in a function)");
            const t = bpNodeTemplate(op, work);
            // Unreal keeps one node per overridden event: adding it again gives the one there.
            const existing = type === "event" ? work.graphs.flatMap((g) => g.nodes).find((n) => n.class === "K2Node_Event" && n.title === t.title) : undefined;
            if (existing) made = existing.id;
            else {
              const id = makeId(op.id);
              tab.nodes.push({ id, title: t.title, class: t.class, x, y, pins: JSON.parse(JSON.stringify(t.pins)) as BpPin[], ...(type === "call" ? { function: String(op.function) } : {}), ...(type === "get" || type === "set" ? { variable: String(op.variable) } : {}) });
              made = id;
            }
          }
          if (typeof op.ref === "string" && op.ref && made) refs.set(op.ref, made);
          break;
        }
        case "delete": {
          const n = nodeOf(op.node);
          if (!n) throw new Error("Node not found");
          if (/FunctionEntry|FunctionResult/.test(n.class)) throw new Error("A function's entry and return nodes stay");
          for (const p of n.pins) unlink(n, p);
          tab.nodes = tab.nodes.filter((x) => x !== n);
          break;
        }
        case "move": {
          const n = nodeOf(op.node);
          if (!n) throw new Error("Node not found");
          if (op.x !== undefined) n.x = Math.round(Number(op.x) || 0);
          if (op.y !== undefined) n.y = Math.round(Number(op.y) || 0);
          break;
        }
        case "resize": {
          const n = nodeOf(op.node);
          if (!n || n.class !== "EdGraphNode_Comment") throw new Error("Comment box not found");
          n.width = Math.min(8000, Math.max(64, Number(op.width ?? n.width) || 400));
          n.height = Math.min(8000, Math.max(64, Number(op.height ?? n.height) || 200));
          break;
        }
        case "comment": {
          const n = nodeOf(op.node);
          if (!n) throw new Error("Node not found");
          n.comment = String(op.text ?? "").slice(0, 300);
          if (n.class === "EdGraphNode_Comment") n.title = n.comment;
          if (!n.comment) delete n.comment;
          if (typeof op.color === "string" && n.class === "EdGraphNode_Comment") n.color = op.color;
          break;
        }
        case "set": {
          const n = nodeOf(op.node);
          const p = pinOf(n, op.pin, "in");
          if (!n || !p) throw new Error(`Pin not found: ${String(op.pin ?? "")}`);
          const value = String(op.value ?? "");
          const bad = checkValue(p.type, value);
          if (bad) throw new Error(`${p.label ?? p.name}: ${bad}`);
          p.default = pinParts(p.type).cat === "bool" ? value.toLowerCase() : value;
          break;
        }
        case "disconnect": {
          const n = nodeOf(op.node);
          const p = pinOf(n, op.pin, "in") ?? pinOf(n, op.pin, "out");
          if (!n || !p) throw new Error(`Pin not found: ${String(op.pin ?? "")}`);
          const link = typeof op.link === "string" ? op.link : undefined;
          if (link && !p.links?.includes(link)) throw new Error("That wire was not found");
          unlink(n, p, link);
          break;
        }
        case "connect": {
          const f = (op.from ?? {}) as { node?: string; pin?: string };
          const t = (op.to ?? {}) as { node?: string; pin?: string };
          if (!op.from || !op.to) throw new Error("connect needs from and to");
          const a = nodeOf(f.node);
          const b = nodeOf(t.node);
          const pa = pinOf(a, f.pin, "out");
          const pb = pinOf(b, t.pin, "in");
          if (!a || !b || !pa || !pb) throw new Error(`Pin not found: ${String(f.node)}.${String(f.pin)} → ${String(t.node)}.${String(t.pin)}`);
          if (a === b) throw new Error("A node does not connect to itself");
          const fit = unrealPinsFit(pa.type, pb.type, options.parents);
          if (!fit.ok) throw new Error(`These pins cannot be connected: ${pa.name} → ${pb.name} (${fit.why})`);
          // Unreal keeps one wire into a data input and one out of an exec output: the new one replaces it.
          if (pb.type !== "exec") unlink(b, pb);
          if (pa.type === "exec") unlink(a, pa);
          pa.links = [...new Set([...(pa.links ?? []), key(b.id, pb.name)])];
          pb.links = [...new Set([...(pb.links ?? []), key(a.id, pa.name)])];
          delete pb.default;
          // A wildcard takes the type wired to it (with the node's other wildcard pins, as ForEach / Array nodes do).
          const settle = (n: BpNode, concrete: string) => {
            const base = pinParts(concrete);
            if (base.cat === "wildcard") return;
            const plain = concrete.replace(/\[\]$/, "");
            for (const p of n.pins) if (pinParts(p.type).cat === "wildcard") p.type = pinParts(p.type).list ? `${plain}[]` : plain;
          };
          if (pinParts(pb.type).cat === "wildcard") settle(b, pa.type);
          else if (pinParts(pa.type).cat === "wildcard") settle(a, pb.type);
          break;
        }
        case "collapse": {
          const name = String(op.name ?? "").trim();
          const ids = Array.isArray(op.nodes) ? op.nodes.map((x) => refs.get(String(x)) ?? String(x)) : [];
          const chosen = tab.nodes.filter((n) => ids.includes(n.id) && n.class !== "EdGraphNode_Comment");
          if (!chosen.length) throw new Error("Choose the nodes to collapse");
          if (!/^\w+$/.test(name)) throw new Error("A function needs a name (letters, digits, _)");
          if (work.graphs.some((g) => g.name === name)) throw new Error(`The Blueprint already has a function named ${name}`);
          if (chosen.some((n) => NOT_COLLAPSIBLE.test(n.class) || n.function === "KismetSystemLibrary:Delay")) throw new Error("These nodes cannot go into a function (an event, the function's entry, or a latent node like Delay is among them)");
          made = collapseInto(work, tab, chosen, name, makeId);
          break;
        }
        default:
          throw new Error(`Unknown operation ${kind}`);
      }
      copy = work;
    } catch (e) {
      error = (e as Error).message;
      made = undefined;
    }
    results.push({ op: kind, ok: !error, ...(error ? { error } : {}), ...(made ? { node: made } : {}) });
  }
  return { doc: copy, results };
}

/**
 * Collapse to Function on the copy: the chosen nodes move into a new function graph between its entry and return
 * nodes, and a call node takes their place; every wire that crossed goes through a parameter (exec through the
 * entry's / call's exec pins). Unreal's own answer after the sync replaces this picture.
 *
 * @returns The call node's id.
 */
function collapseInto(doc: BpDoc, tab: BpGraph, chosen: BpNode[], name: string, makeId: (want?: unknown) => string): string {
  const inside = new Set(chosen.map((n) => n.id));
  const xs = chosen.map((n) => n.x);
  const ys = chosen.map((n) => n.y);
  const entry: BpNode = { id: makeId(), title: name, class: "K2Node_FunctionEntry", x: Math.min(...xs) - 300, y: Math.min(...ys), pins: [] };
  const result: BpNode = { id: makeId(), title: "Return Node", class: "K2Node_FunctionResult", x: Math.max(...xs) + 300, y: Math.min(...ys), pins: [] };
  const call: BpNode = { id: makeId(), title: spaced(name), class: "K2Node_CallFunction", function: name, x: Math.round(xs.reduce((s, v) => s + v, 0) / xs.length), y: Math.round(ys.reduce((s, v) => s + v, 0) / ys.length), pins: [] };
  const unique = (n: BpNode, want: string, dir: "in" | "out") => {
    let s = want;
    for (let i = 2; n.pins.some((p) => p.name === s && p.dir === dir); i++) s = `${want}_${i}`;
    return s;
  };
  const outsideNode = (id: string) => tab.nodes.find((n) => n.id === id && !inside.has(id));
  for (const n of chosen) {
    for (const p of n.pins) {
      const cross = (p.links ?? []).filter((l) => outsideNode(split(l)[0]));
      if (!cross.length) continue;
      const exec = p.type === "exec";
      // Into the nodes (an input wired from outside): entry → p inside, outside → call outside.
      // Out of the nodes (an output wired to outside): p → result inside, call → outside.
      const side = p.dir === "in" ? entry : result;
      const inner = exec ? (p.dir === "in" ? "then" : "execute") : unique(side, p.name, p.dir === "in" ? "out" : "in");
      const outer = exec ? (p.dir === "in" ? "execute" : "then") : unique(call, p.name, p.dir);
      if (!side.pins.some((x) => x.name === inner)) side.pins.push({ name: inner, dir: p.dir === "in" ? "out" : "in", type: p.type, ...(p.label ? { label: p.label } : {}) });
      if (!call.pins.some((x) => x.name === outer)) call.pins.push({ name: outer, dir: p.dir, type: p.type, ...(p.label && !exec ? { label: p.label } : {}) });
      const sidePin = side.pins.find((x) => x.name === inner)!;
      const callPin = call.pins.find((x) => x.name === outer)!;
      for (const l of cross) {
        const [on, opin] = split(l);
        const o = outsideNode(on)!.pins.find((x) => x.name === opin && x.dir !== p.dir);
        if (o) o.links = [...new Set([...(o.links ?? []).filter((x) => x !== key(n.id, p.name)), key(call.id, outer)])];
        callPin.links = [...new Set([...(callPin.links ?? []), l])];
      }
      p.links = [...(p.links ?? []).filter((l) => !cross.includes(l)), key(side.id, inner)];
      sidePin.links = [...new Set([...(sidePin.links ?? []), key(n.id, p.name)])];
    }
  }
  // A function always has exec in and out unless everything inside is pure.
  const pure = chosen.every((n) => isPureNode(n));
  if (!pure) {
    if (!entry.pins.some((p) => p.name === "then")) entry.pins.unshift({ name: "then", dir: "out", type: "exec" });
    if (!result.pins.some((p) => p.name === "execute")) result.pins.unshift({ name: "execute", dir: "in", type: "exec" });
    if (!call.pins.some((p) => p.name === "execute")) call.pins.unshift({ name: "execute", dir: "in", type: "exec" });
    if (!call.pins.some((p) => p.name === "then")) call.pins.splice(1, 0, { name: "then", dir: "out", type: "exec" });
  }
  for (const n of [entry, result, call]) for (const p of n.pins) if (p.links && !p.links.length) delete p.links;
  tab.nodes = [...tab.nodes.filter((n) => !inside.has(n.id)), call];
  doc.graphs.push({ name, kind: "function", nodes: [entry, ...chosen, result] });
  return call.id;
}

/**
 * Whether a wire may go from one pin to another in this graph, said the way the page shows it while dragging.
 *
 * @param tab - The graph.
 * @param from - The output pin (node id, pin name).
 * @param to - The input pin.
 * @param parents - Blueprint classes' parents.
 * @returns ok, and why.
 */
export function canConnectBp(tab: BpGraph, from: { node: string; pin: string }, to: { node: string; pin: string }, parents: Record<string, string> = {}): { ok: boolean; why: string } {
  const pa = tab.nodes.find((n) => n.id === from.node)?.pins.find((p) => p.name === from.pin && p.dir === "out");
  const pb = tab.nodes.find((n) => n.id === to.node)?.pins.find((p) => p.name === to.pin && p.dir === "in");
  if (!pa || !pb) return { ok: false, why: "Pin not found" };
  if (from.node === to.node) return { ok: false, why: "A node does not connect to itself" };
  return unrealPinsFit(pa.type, pb.type, parents);
}

// ---------------------------------------------------------------------------------------------------------------
// Compile messages
// ---------------------------------------------------------------------------------------------------------------

/** One compile message, tied to a node when it could be. */
export interface BpCompileMessage { severity: "error" | "warning"; text: string; node?: string; graph?: string }

/**
 * Ties the plugin's compile answer to nodes: the plugin (0.1.26+) names each node with a compiler message; for an
 * older plugin, a node whose title is in the message's text is taken (the longest title wins).
 *
 * @param answer - The plugin's compile answer: { ok, messages: [{ severity, text }], nodes?: [{ node, graph, severity, text }] }.
 * @param doc - The Blueprint as read after the compile.
 * @returns The messages, each with its node and graph when found (node messages first).
 */
export function mapCompileMessages(answer: { messages?: Array<{ severity?: string; text?: string }>; nodes?: Array<{ node?: string; graph?: string; severity?: string; text?: string }> } | undefined, doc: Pick<BpDoc, "graphs"> | undefined): BpCompileMessage[] {
  const sev = (s: unknown): "error" | "warning" => (s === "error" ? "error" : "warning");
  const out: BpCompileMessage[] = [];
  for (const n of answer?.nodes ?? []) {
    if (!n?.node) continue;
    const graph = n.graph ?? doc?.graphs.find((g) => g.nodes.some((x) => x.id === n.node))?.name;
    out.push({ severity: sev(n.severity), text: String(n.text ?? "").slice(0, 1000), node: n.node, ...(graph ? { graph } : {}) });
  }
  const titled = (doc?.graphs ?? []).flatMap((g) => g.nodes.filter((n) => n.class !== "EdGraphNode_Comment" && n.title.length >= 4).map((n) => ({ g: g.name, n })));
  titled.sort((a, b) => b.n.title.length - a.n.title.length);
  for (const m of answer?.messages ?? []) {
    const text = String(m?.text ?? "").slice(0, 1000);
    if (!text || out.some((o) => o.text && text.includes(o.text))) continue;
    const hit = titled.find(({ n }) => text.includes(n.title.split("\n")[0]!));
    out.push({ severity: sev(m?.severity), text, ...(hit ? { node: hit.n.id, graph: hit.g } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization and comparing
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reads a Blueprint from JSON text (a saved copy, or the plugin's answer) and checks its shape: unknown fields are
 * dropped, text is capped, numbers are numbers. Throws when it is not a Blueprint.
 *
 * @param text - The JSON.
 * @returns The Blueprint.
 */
export function parseBpDoc(text: string): BpDoc {
  try {
    return parseVsDoc(text);
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `Not a Blueprint: ${e.message}` : "Not a Blueprint");
  }
}

/**
 * Writes a Blueprint as stable JSON (the same Blueprint always gives the same text).
 *
 * @param doc - The Blueprint.
 * @returns The JSON text; {@link parseBpDoc} reads it back to an equal Blueprint.
 */
export function serializeBpDoc(doc: BpDoc): string {
  return JSON.stringify(parseBpDoc(JSON.stringify(doc)));
}

/**
 * What Unreal changed compared with the saved copy, graph by graph (by node id): nodes added and removed, how many
 * moved, were rewired or had a value changed ("sync on open").
 *
 * @param saved - The copy KesherAI has.
 * @param now - Unreal's Blueprint now.
 * @returns The differences.
 */
export function diffBpGraphs(saved: BpDoc, now: BpDoc): BpDiff {
  return diffVsGraphs(saved, now);
}
