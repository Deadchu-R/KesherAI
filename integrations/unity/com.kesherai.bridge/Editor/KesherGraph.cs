// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Unity.VisualScripting;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace KesherAI.Bridge
{
    /// <summary>
    /// What KesherAI can do with Visual Scripting, as JSON in and JSON out (the
    /// same shape as the Unreal bridge): list, graph, apply (one undo step),
    /// check, save, open.
    ///
    /// A "path" names where a graph lives:
    /// - <c>Assets/Door.asset</c> — a Script Graph or State Graph asset;
    /// - <c>Assets/Scenes/Main.unity#Player/Body@0</c> — a graph kept inside a
    ///   Script Machine or State Machine on a GameObject in a scene (the number
    ///   picks the machine when the object has several);
    /// - <c>Assets/Door.prefab#Door/Hinge@0</c> — the same inside a prefab.
    ///
    /// A State Graph shows as several tabs: "States" (states and transitions),
    /// then the flow graph inside each Flow State and each transition, and the
    /// states of each Super State, so every part can be read and changed.
    ///
    /// Nodes are named by their GUID; a node added in the same apply is named by
    /// the "ref" given to it. Ports are named by their key ("enter", "exit",
    /// "trigger", "ifTrue", "condition", "message"…).
    /// </summary>
    internal static class KesherGraph
    {
        static Dictionary<string, object> Error(string message) => new Dictionary<string, object> { ["error"] = message };

        // --- where a graph lives -----------------------------------------------

        /// <summary>A loaded graph and how to record undo, mark it changed and save it.</summary>
        sealed class Target
        {
            public IGraph Root;
            public UnityEngine.Object Owner;
            public string Name;
            public Action Save = () => { };
            public Action Done = () => { };
        }

        static Target Load(string path)
        {
            var hash = path.IndexOf('#');
            var file = hash < 0 ? path : path.Substring(0, hash);
            if (hash < 0)
            {
                var asset = AssetDatabase.LoadMainAssetAtPath(file);
                var script = asset as ScriptGraphAsset;
                if (script != null) return new Target { Root = script.graph, Owner = script, Name = script.name, Save = () => { EditorUtility.SetDirty(script); AssetDatabase.SaveAssetIfDirty(script); } };
                var state = asset as StateGraphAsset;
                if (state != null) return new Target { Root = state.graph, Owner = state, Name = state.name, Save = () => { EditorUtility.SetDirty(state); AssetDatabase.SaveAssetIfDirty(state); } };
                return null;
            }
            var rest = path.Substring(hash + 1);
            var at = rest.LastIndexOf('@');
            var goPath = at < 0 ? rest : rest.Substring(0, at);
            int index;
            if (at < 0 || !int.TryParse(rest.Substring(at + 1), out index)) index = 0;

            if (file.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                var contents = PrefabUtility.LoadPrefabContents(file);
                var go = Find(contents, goPath);
                var machine = go != null ? Machines(go).ElementAtOrDefault(index) : null;
                if (machine == null) { PrefabUtility.UnloadPrefabContents(contents); return null; }
                return new Target
                {
                    Root = machine.nest.graph,
                    Owner = (UnityEngine.Object)machine,
                    Name = go.name,
                    Save = () => PrefabUtility.SaveAsPrefabAsset(contents, file),
                    Done = () => PrefabUtility.UnloadPrefabContents(contents),
                };
            }

            var scene = SceneManager.GetSceneByPath(file);
            if (!scene.IsValid() || !scene.isLoaded)
            {
                // In a batch run (Unity closed) open it; in the editor open it beside what is open.
                scene = EditorSceneManager.OpenScene(file, Application.isBatchMode ? OpenSceneMode.Single : OpenSceneMode.Additive);
            }
            GameObject target = null;
            var first = goPath.Split('/')[0];
            foreach (var r in scene.GetRootGameObjects())
            {
                if (r.name != first) continue;
                target = goPath.Contains("/") ? Find(r, goPath.Substring(first.Length + 1)) : r;
                if (target != null) break;
            }
            var m = target != null ? Machines(target).ElementAtOrDefault(index) : null;
            if (m == null) return null;
            var s = scene;
            return new Target
            {
                Root = m.nest.graph,
                Owner = (UnityEngine.Object)m,
                Name = target.name,
                Save = () => { EditorSceneManager.MarkSceneDirty(s); EditorSceneManager.SaveScene(s); },
            };
        }

        static GameObject Find(GameObject root, string path)
        {
            if (string.IsNullOrEmpty(path) || path == root.name) return root;
            var t = root.transform.Find(path.StartsWith(root.name + "/", StringComparison.Ordinal) ? path.Substring(root.name.Length + 1) : path);
            return t != null ? t.gameObject : null;
        }

        /// <summary>The object's Script and State Machines that keep their graph inside them (not a shared asset).</summary>
        static List<IMachine> Machines(GameObject go)
        {
            var list = new List<IMachine>();
            foreach (var c in go.GetComponents<MonoBehaviour>())
            {
                var m = c as IMachine;
                if (m != null && m.nest != null && m.nest.source == GraphSource.Embed && m.nest.embed != null) list.Add(m);
            }
            return list;
        }

        static string GoPath(Transform t) => t.parent == null ? t.name : GoPath(t.parent) + "/" + t.name;

        // --- list ----------------------------------------------------------------

        public static Dictionary<string, object> List()
        {
            var items = new List<object>();
            foreach (var guid in AssetDatabase.FindAssets("t:ScriptGraphAsset"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.StartsWith("Assets/", StringComparison.Ordinal)) items.Add(Item(p, System.IO.Path.GetFileNameWithoutExtension(p), "Script Graph"));
            }
            foreach (var guid in AssetDatabase.FindAssets("t:StateGraphAsset"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.StartsWith("Assets/", StringComparison.Ordinal)) items.Add(Item(p, System.IO.Path.GetFileNameWithoutExtension(p), "State Graph"));
            }
            // Graphs inside prefabs.
            foreach (var guid in AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" }))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                if (prefab == null) continue;
                foreach (var t in prefab.GetComponentsInChildren<Transform>(true)) AddMachines(items, p, t);
            }
            // Graphs inside the scenes that are open.
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded || string.IsNullOrEmpty(scene.path)) continue;
                foreach (var root in scene.GetRootGameObjects())
                {
                    foreach (var t in root.GetComponentsInChildren<Transform>(true)) AddMachines(items, scene.path, t);
                }
            }
            return new Dictionary<string, object> { ["blueprints"] = items };
        }

        static Dictionary<string, object> Item(string path, string name, string kind) => new Dictionary<string, object> { ["path"] = path, ["name"] = name, ["parent"] = kind };

        static void AddMachines(List<object> items, string file, Transform t)
        {
            var machines = Machines(t.gameObject);
            for (var k = 0; k < machines.Count; k++)
            {
                var kind = machines[k] is StateMachine ? "State Machine" : "Script Machine";
                var where = System.IO.Path.GetFileNameWithoutExtension(file);
                items.Add(Item(file + "#" + GoPath(t) + "@" + k, t.name + (machines.Count > 1 ? " #" + (k + 1) : "") + " (" + where + ")", kind));
            }
        }

        // --- read ----------------------------------------------------------------

        static string Title(IUnit unit)
        {
            var m = unit as MemberUnit;
            if (m != null && m.member != null) return (m.member.targetType != null ? m.member.targetType.Name + "." : "") + m.member.name;
            var v = unit as UnifiedVariableUnit;
            if (v != null)
            {
                object n;
                return (unit is SetVariable ? "Set " : "Get ") + (unit.defaultValues.TryGetValue("name", out n) ? n : "") + " (" + v.kind + ")";
            }
            var l = unit as Literal;
            if (l != null) return "Literal " + (l.type != null ? l.type.Name : "");
            var name = unit.GetType().Name;
            return name.EndsWith("Unit", StringComparison.Ordinal) ? name.Substring(0, name.Length - 4) : name;
        }

        static string StateTitle(IState s)
        {
            var nester = s as INesterState;
            var t = nester != null && nester.nest.graph != null ? nester.nest.graph.title : null;
            return !string.IsNullOrEmpty(t) ? t : s is AnyState ? "Any State" : s.GetType().Name;
        }

        static string TypeName(Type t) => t == null ? "" : t == typeof(object) ? "object" : t.Name;

        static Dictionary<string, object> PortJson(IUnitPort port, string dir, string type, IUnit unit)
        {
            var p = new Dictionary<string, object> { ["name"] = port.key, ["dir"] = dir, ["type"] = type };
            var vi = port as ValueInput;
            object def;
            if (vi != null && !vi.hasValidConnection && unit.defaultValues.TryGetValue(vi.key, out def) && def != null) p["default"] = def.ToString();
            var links = port.connectedPorts.Select(c => (object)(c.unit.guid.ToString() + ":" + c.key)).ToList();
            if (links.Count > 0) p["links"] = links;
            return p;
        }

        static List<object> FlowNodes(FlowGraph graph)
        {
            var nodes = new List<object>();
            foreach (var unit in graph.units)
            {
                var pins = new List<object>();
                foreach (var p in unit.controlInputs) pins.Add(PortJson(p, "in", "exec", unit));
                foreach (var p in unit.valueInputs) pins.Add(PortJson(p, "in", TypeName(p.type), unit));
                foreach (var p in unit.controlOutputs) pins.Add(PortJson(p, "out", "exec", unit));
                foreach (var p in unit.valueOutputs) pins.Add(PortJson(p, "out", TypeName(p.type), unit));
                var n = new Dictionary<string, object> { ["id"] = unit.guid.ToString(), ["title"] = Title(unit), ["class"] = unit.GetType().Name, ["x"] = (double)unit.position.x, ["y"] = (double)unit.position.y, ["pins"] = pins };
                var m = unit as MemberUnit;
                if (m != null && m.member != null) n["function"] = (m.member.targetType != null ? m.member.targetType.FullName : "") + ":" + m.member.name;
                nodes.Add(n);
            }
            return nodes;
        }

        static List<object> StateNodes(StateGraph graph)
        {
            var nodes = new List<object>();
            foreach (var s in graph.states)
            {
                var pins = new List<object>
                {
                    new Dictionary<string, object> { ["name"] = "in", ["dir"] = "in", ["type"] = "exec", ["links"] = s.incomingTransitions.Select(t => (object)(t.source.guid + ":out")).ToList() },
                    new Dictionary<string, object> { ["name"] = "start", ["dir"] = "in", ["type"] = "bool", ["default"] = s.isStart ? "true" : "false" },
                    new Dictionary<string, object> { ["name"] = "out", ["dir"] = "out", ["type"] = "exec", ["links"] = s.outgoingTransitions.Select(t => (object)(t.destination.guid + ":in")).ToList() },
                };
                nodes.Add(new Dictionary<string, object> { ["id"] = s.guid.ToString(), ["title"] = StateTitle(s) + (s.isStart ? " ▶" : ""), ["class"] = s.GetType().Name, ["x"] = (double)s.position.x, ["y"] = (double)s.position.y, ["pins"] = pins });
            }
            return nodes;
        }

        /// <summary>Every graph in the tree, as tabs (name, graph).</summary>
        static void Tabs(IGraph graph, string prefix, List<KeyValuePair<string, IGraph>> tabs)
        {
            var flow = graph as FlowGraph;
            if (flow != null)
            {
                tabs.Add(new KeyValuePair<string, IGraph>(prefix == "" ? "Flow" : prefix, flow));
                return;
            }
            var states = graph as StateGraph;
            if (states == null) return;
            tabs.Add(new KeyValuePair<string, IGraph>(prefix == "" ? "States" : prefix + " · States", states));
            foreach (var s in states.states)
            {
                var nester = s as INesterState;
                if (nester == null || nester.nest.source != GraphSource.Embed || nester.nest.graph == null) continue;
                var name = (prefix == "" ? "" : prefix + " · ") + (s is SuperState ? "Super " : "State ") + StateTitle(s) + " [" + s.guid.ToString().Substring(0, 8) + "]";
                Tabs(nester.nest.graph, name, tabs);
            }
            foreach (var t in states.transitions)
            {
                var nester = t as INesterStateTransition;
                if (nester == null || nester.nest.source != GraphSource.Embed || nester.nest.graph == null) continue;
                var name = (prefix == "" ? "" : prefix + " · ") + "Transition " + StateTitle(t.source) + " → " + StateTitle(t.destination) + " [" + t.guid.ToString().Substring(0, 8) + "]";
                Tabs(nester.nest.graph, name, tabs);
            }
        }

        public static Dictionary<string, object> Read(string path)
        {
            var target = Load(path);
            if (target == null) return Error("No graph at " + path);
            try
            {
                var tabs = new List<KeyValuePair<string, IGraph>>();
                Tabs(target.Root, "", tabs);
                var graphs = new List<object>();
                foreach (var tab in tabs)
                {
                    var flow = tab.Value as FlowGraph;
                    graphs.Add(new Dictionary<string, object> { ["name"] = tab.Key, ["kind"] = flow != null ? "function" : "macro", ["nodes"] = flow != null ? FlowNodes(flow) : StateNodes((StateGraph)tab.Value) });
                }
                var vars = new List<object>();
                var withVars = target.Root as IGraphWithVariables;
                if (withVars != null)
                {
                    foreach (var v in withVars.variables)
                    {
                        var t = DeclaredType(v);
                        vars.Add(new Dictionary<string, object> { ["name"] = v.name, ["type"] = v.value != null ? v.value.GetType().Name : "object", ["ptype"] = TypeKey(t), ["default"] = ValueText(v.value) });
                    }
                }
                return new Dictionary<string, object> { ["path"] = path, ["name"] = target.Name, ["parent"] = target.Root is StateGraph ? "State Graph" : "Script Graph", ["variables"] = vars, ["graphs"] = graphs };
            }
            finally
            {
                target.Done();
            }
        }

        // --- apply ---------------------------------------------------------------

        static Type UnitType(string name)
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (!asm.GetName().Name.StartsWith("Unity.VisualScripting", StringComparison.Ordinal)) continue;
                Type[] types;
                try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(x => x != null).ToArray(); }
                var t = types.FirstOrDefault(x => typeof(IUnit).IsAssignableFrom(x) && !x.IsAbstract && x.GetConstructor(Type.EmptyTypes) != null && (x.Name == name || x.Name == name + "Unit"));
                if (t != null) return t;
            }
            return null;
        }

        static Member FindMember(string spec, int argCount)
        {
            var cut = spec.LastIndexOf(':');
            if (cut < 0) cut = spec.LastIndexOf('.');
            if (cut <= 0) return null;
            var typeName = spec.Substring(0, cut);
            var memberName = spec.Substring(cut + 1);
            Type type = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                type = asm.GetType(typeName) ?? asm.GetType("UnityEngine." + typeName);
                if (type != null) break;
            }
            if (type == null) return null;
            var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance).Where(m => m.Name == memberName && !m.IsGenericMethodDefinition).ToList();
            var method = methods.FirstOrDefault(m => argCount >= 0 && m.GetParameters().Length == argCount) ?? methods.OrderBy(m => m.GetParameters().Length).FirstOrDefault();
            if (method != null) return new Member(type, method);
            var prop = type.GetProperty(memberName, BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
            if (prop != null) return new Member(type, prop);
            var field = type.GetField(memberName, BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
            return field != null ? new Member(type, field) : null;
        }

        static Type ValueType(string name)
        {
            switch ((name ?? "").ToLowerInvariant())
            {
                case "int": case "integer": return typeof(int);
                case "float": case "number": return typeof(float);
                case "bool": case "boolean": return typeof(bool);
                case "vector2": return typeof(Vector2);
                case "vector3": return typeof(Vector3);
                default: return typeof(string);
            }
        }

        static IUnitPort FindPort(IUnit unit, string name, bool output)
        {
            var list = (output ? unit.controlOutputs.Cast<IUnitPort>().Concat(unit.valueOutputs) : unit.controlInputs.Cast<IUnitPort>().Concat(unit.valueInputs)).ToList();
            var found = list.FirstOrDefault(p => string.Equals(p.key, name, StringComparison.OrdinalIgnoreCase));
            if (found != null) return found;
            if (new[] { "exec", "execute", "then", "in", "out", "enter", "exit" }.Contains((name ?? "").ToLowerInvariant()))
            {
                return output ? (IUnitPort)unit.controlOutputs.FirstOrDefault() : unit.controlInputs.FirstOrDefault();
            }
            return null;
        }

        public static Dictionary<string, object> Apply(string path, string graphName, List<object> ops)
        {
            var target = Load(path);
            if (target == null) return Error("No graph at " + path);
            try
            {
                var tabs = new List<KeyValuePair<string, IGraph>>();
                Tabs(target.Root, "", tabs);
                var tab = tabs.FirstOrDefault(t => t.Key == graphName);
                var graph = tab.Value ?? tabs[0].Value;
                Undo.RegisterCompleteObjectUndo(target.Owner, "KesherAI edit");
                var result = graph is FlowGraph ? ApplyFlow((FlowGraph)graph, ops) : ApplyStates((StateGraph)graph, ops);
                EditorUtility.SetDirty(target.Owner);
                // A prefab is edited in a copy of its contents, and a batch run (Unity closed) leaves nothing open: write them back now.
                if (path.Contains(".prefab#") || Application.isBatchMode) target.Save();
                return result;
            }
            finally
            {
                target.Done();
            }
        }

        static Dictionary<string, object> Result(List<object> results, int failed) => new Dictionary<string, object> { ["results"] = results, ["failed"] = (double)failed };

        static Dictionary<string, object> Res(string kind, string problem, string node)
        {
            var r = new Dictionary<string, object> { ["op"] = kind, ["ok"] = problem == null };
            if (problem != null) r["error"] = problem;
            if (node != null) r["node"] = node;
            return r;
        }

        static Dictionary<string, object> ApplyFlow(FlowGraph graph, List<object> ops)
        {
            var refs = new Dictionary<string, IUnit>();
            Func<string, IUnit> NodeOf = id =>
            {
                if (string.IsNullOrEmpty(id)) return null;
                IUnit r;
                if (refs.TryGetValue(id, out r)) return r;
                Guid g;
                return Guid.TryParse(id, out g) ? graph.units.FirstOrDefault(u => u.guid == g) : null;
            };
            var results = new List<object>();
            var failed = 0;
            foreach (var o in ops)
            {
                var op = o as Dictionary<string, object>;
                if (op == null) continue;
                var kind = Json.Str(op, "op");
                string problem = null;
                IUnit made = null;
                try
                {
                    if (kind == "add")
                    {
                        var type = Json.Str(op, "type");
                        IUnit unit = null;
                        if (type == "call")
                        {
                            var member = FindMember(Json.Str(op, "function"), (int)Json.Num(op, "args", -1));
                            if (member == null) problem = "No method " + Json.Str(op, "function");
                            else unit = new InvokeMember(member);
                        }
                        else if (type == "get" || type == "set")
                        {
                            var v = type == "get" ? (UnifiedVariableUnit)new GetVariable() : new SetVariable();
                            VariableKind k;
                            v.kind = Enum.TryParse(Json.Str(op, "kind"), true, out k) ? k : VariableKind.Graph;
                            unit = v;
                        }
                        else if (type == "literal")
                        {
                            var t = ValueType(Json.Str(op, "valueType"));
                            unit = new Literal(t, ConversionUtility.Convert(Json.Str(op, "value"), t));
                        }
                        else if (type == "custom_event") unit = new CustomEvent();
                        else
                        {
                            var name = type == "unit" || type == "event" ? Json.Str(op, type == "event" ? "event" : "unit") : type;
                            var t = UnitType(name == "branch" ? "If" : name);
                            if (t == null) problem = "No node type " + name;
                            else unit = (IUnit)Activator.CreateInstance(t);
                        }
                        if (unit != null)
                        {
                            unit.position = new Vector2((float)Json.Num(op, "x", 0), (float)Json.Num(op, "y", 0));
                            graph.units.Add(unit);
                            if ((type == "get" || type == "set") && unit.valueInputs.Contains("name")) unit.defaultValues["name"] = Json.Str(op, "variable");
                            if (type == "custom_event" && unit.valueInputs.Contains("name")) unit.defaultValues["name"] = Json.Str(op, "name");
                            made = unit;
                            var r = Json.Str(op, "ref");
                            if (!string.IsNullOrEmpty(r)) refs[r] = unit;
                        }
                    }
                    else if (kind == "connect")
                    {
                        var from = Json.Obj(op, "from");
                        var to = Json.Obj(op, "to");
                        var a = NodeOf(Json.Str(from, "node"));
                        var b = NodeOf(Json.Str(to, "node"));
                        var pa = a != null ? FindPort(a, Json.Str(from, "pin"), true) : null;
                        var pb = b != null ? FindPort(b, Json.Str(to, "pin"), false) : null;
                        if (pa == null || pb == null) problem = "Port not found: " + Json.Str(from, "node") + "." + Json.Str(from, "pin") + " → " + Json.Str(to, "node") + "." + Json.Str(to, "pin");
                        else if (!pa.CanValidlyConnectTo(pb)) problem = "These ports cannot be connected: " + pa.key + " → " + pb.key;
                        else pa.ValidlyConnectTo(pb);
                    }
                    else if (kind == "set")
                    {
                        var unit = NodeOf(Json.Str(op, "node"));
                        var pin = Json.Str(op, "pin");
                        if (unit == null || !unit.valueInputs.Contains(pin)) problem = "Input not found: " + pin;
                        else unit.valueInputs[pin].SetDefaultValue(ConversionUtility.Convert(Json.Str(op, "value"), unit.valueInputs[pin].type));
                    }
                    else if (kind == "move")
                    {
                        var unit = NodeOf(Json.Str(op, "node"));
                        if (unit == null) problem = "Node not found";
                        else unit.position = new Vector2((float)Json.Num(op, "x", unit.position.x), (float)Json.Num(op, "y", unit.position.y));
                    }
                    else if (kind == "delete")
                    {
                        var unit = NodeOf(Json.Str(op, "node"));
                        if (unit == null) problem = "Node not found";
                        else graph.units.Remove(unit);
                    }
                    else if (kind == "disconnect")
                    {
                        // Every connection of one port (Alt+click, or right-click a port, as in Unity's own editor).
                        var unit = NodeOf(Json.Str(op, "node"));
                        var pin = Json.Str(op, "pin");
                        var port = unit != null ? (FindPort(unit, pin, true) ?? FindPort(unit, pin, false)) : null;
                        if (port == null) problem = "Port not found: " + Json.Str(op, "node") + "." + pin;
                        else port.Disconnect();
                    }
                    else problem = "Unknown operation " + kind;
                }
                catch (Exception e)
                {
                    problem = e.Message;
                }
                if (problem != null) failed++;
                results.Add(Res(kind, problem, made != null ? made.guid.ToString() : null));
            }
            return Result(results, failed);
        }

        static Dictionary<string, object> ApplyStates(StateGraph graph, List<object> ops)
        {
            var refs = new Dictionary<string, IState>();
            Func<string, IState> StateOf = id =>
            {
                if (string.IsNullOrEmpty(id)) return null;
                IState r;
                if (refs.TryGetValue(id, out r)) return r;
                Guid g;
                return Guid.TryParse(id, out g) ? graph.states.FirstOrDefault(s => s.guid == g) : null;
            };
            var results = new List<object>();
            var failed = 0;
            foreach (var o in ops)
            {
                var op = o as Dictionary<string, object>;
                if (op == null) continue;
                var kind = Json.Str(op, "op");
                string problem = null;
                IState made = null;
                try
                {
                    if (kind == "add")
                    {
                        var type = Json.Str(op, "type");
                        IState state = type == "super_state" ? (IState)SuperState.WithStart() : type == "any_state" ? (IState)new AnyState() : FlowState.WithEnterUpdateExit();
                        var nester = state as INesterState;
                        var title = Json.Str(op, "name");
                        if (nester != null && !string.IsNullOrEmpty(title)) ((Graph)nester.nest.embed).title = title;
                        state.position = new Vector2((float)Json.Num(op, "x", 0), (float)Json.Num(op, "y", 0));
                        if (graph.states.Count == 0) state.isStart = true;
                        graph.states.Add(state);
                        made = state;
                        var r = Json.Str(op, "ref");
                        if (!string.IsNullOrEmpty(r)) refs[r] = state;
                    }
                    else if (kind == "connect")
                    {
                        var a = StateOf(Json.Str(Json.Obj(op, "from"), "node"));
                        var b = StateOf(Json.Str(Json.Obj(op, "to"), "node"));
                        if (a == null || b == null) problem = "State not found";
                        else if (b is AnyState) problem = "Nothing can go into Any State";
                        else graph.transitions.Add(FlowStateTransition.WithDefaultTrigger(a, b));
                    }
                    else if (kind == "disconnect")
                    {
                        var a = StateOf(Json.Str(Json.Obj(op, "from"), "node"));
                        var b = StateOf(Json.Str(Json.Obj(op, "to"), "node"));
                        var t = a != null ? a.outgoingTransitions.FirstOrDefault(x => x.destination == b) : null;
                        if (t == null) problem = "No transition between those states";
                        else graph.transitions.Remove(t);
                    }
                    else if (kind == "set")
                    {
                        var s = StateOf(Json.Str(op, "node"));
                        var pin = Json.Str(op, "pin");
                        if (s == null) problem = "State not found";
                        else if (pin == "start")
                        {
                            var on = Json.Str(op, "value").ToLowerInvariant() == "true";
                            if (on) foreach (var other in graph.states) other.isStart = false;
                            s.isStart = on;
                        }
                        else if (pin == "name" || pin == "title")
                        {
                            var nester = s as INesterState;
                            if (nester == null || nester.nest.graph == null) problem = "This state has no name";
                            else ((Graph)nester.nest.graph).title = Json.Str(op, "value");
                        }
                        else problem = "States have \"start\" and \"name\"";
                    }
                    else if (kind == "move")
                    {
                        var s = StateOf(Json.Str(op, "node"));
                        if (s == null) problem = "State not found";
                        else s.position = new Vector2((float)Json.Num(op, "x", s.position.x), (float)Json.Num(op, "y", s.position.y));
                    }
                    else if (kind == "delete")
                    {
                        var s = StateOf(Json.Str(op, "node"));
                        if (s == null) problem = "State not found";
                        else
                        {
                            foreach (var t in s.transitions.ToList()) graph.transitions.Remove(t);
                            graph.states.Remove(s);
                        }
                    }
                    else problem = "Unknown operation " + kind;
                }
                catch (Exception e)
                {
                    problem = e.Message;
                }
                if (problem != null) failed++;
                results.Add(Res(kind, problem, made != null ? made.guid.ToString() : null));
            }
            return Result(results, failed);
        }

        // --- check, save, open -----------------------------------------------------

        /// <summary>Checks every flow graph in the tree: inputs without a value, broken ports, a state graph without a start (Visual Scripting has no separate compile step).</summary>
        public static Dictionary<string, object> Check(string path)
        {
            var target = Load(path);
            if (target == null) return Error("No graph at " + path);
            try
            {
                var tabs = new List<KeyValuePair<string, IGraph>>();
                Tabs(target.Root, "", tabs);
                var messages = new List<object>();
                foreach (var tab in tabs)
                {
                    var flow = tab.Value as FlowGraph;
                    if (flow == null) continue;
                    var where = tabs.Count > 1 ? tab.Key + ": " : "";
                    foreach (var unit in flow.units)
                    {
                        foreach (var input in unit.valueInputs)
                        {
                            if (!input.hasValidConnection && !input.hasDefaultValue && !input.nullMeansSelf && !input.allowsNull)
                                messages.Add(new Dictionary<string, object> { ["severity"] = "warning", ["text"] = where + Title(unit) + ": input " + input.key + " has no value" });
                        }
                        foreach (var port in unit.invalidInputs) messages.Add(new Dictionary<string, object> { ["severity"] = "error", ["text"] = where + Title(unit) + ": broken input " + port.key });
                        foreach (var port in unit.invalidOutputs) messages.Add(new Dictionary<string, object> { ["severity"] = "error", ["text"] = where + Title(unit) + ": broken output " + port.key });
                    }
                }
                var states = target.Root as StateGraph;
                if (states != null && states.states.Count > 0 && !states.states.Any(s => s.isStart))
                    messages.Add(new Dictionary<string, object> { ["severity"] = "error", ["text"] = "No start state" });
                return new Dictionary<string, object> { ["ok"] = !messages.OfType<Dictionary<string, object>>().Any(m => (string)m["severity"] == "error"), ["messages"] = messages };
            }
            finally
            {
                target.Done();
            }
        }

        // --- graph variables (Blackboard → Graph) ------------------------------------

        /// <summary>The type a variable was declared with (its value may be empty).</summary>
        static Type DeclaredType(VariableDeclaration v)
        {
            var handle = typeof(VariableDeclaration).GetProperty("typeHandle")?.GetValue(v);
            var id = handle?.GetType().GetProperty("Identification")?.GetValue(handle) as string;
            var t = string.IsNullOrEmpty(id) ? null : Type.GetType(id);
            return t ?? v.value?.GetType();
        }

        /// <summary>How KesherAI names a type: int, float, bool, string, or the class name (Vector3, GameObject, Enemy).</summary>
        static string TypeKey(Type t)
        {
            if (t == null) return "object";
            if (t == typeof(int)) return "int";
            if (t == typeof(float)) return "float";
            if (t == typeof(bool)) return "bool";
            if (t == typeof(string)) return "string";
            return t.Name;
        }

        /// <summary>A type from KesherAI's name for it: the basic ones, Unity's, then any class in the project.</summary>
        static Type FindType(string key)
        {
            switch ((key ?? "").ToLowerInvariant())
            {
                case "int": return typeof(int);
                case "float": return typeof(float);
                case "bool": return typeof(bool);
                case "string": return typeof(string);
            }
            var u = typeof(GameObject).Assembly.GetType("UnityEngine." + key);
            if (u != null) return u;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(x => x != null).ToArray(); }
                var t = types.FirstOrDefault(x => x.Name == key && x.IsPublic && (typeof(UnityEngine.Object).IsAssignableFrom(x) || x.IsValueType));
                if (t != null) return t;
            }
            return null;
        }

        static string ValueText(object v)
        {
            if (v == null) return "";
            if (v is UnityEngine.Object o) return o ? o.name : "";
            if (v is bool b) return b ? "true" : "false";
            if (v is float f) return f.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (v is Vector3 v3) return v3.x.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", " + v3.y.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", " + v3.z.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (v is Vector2 v2) return v2.x.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", " + v2.y.ToString(System.Globalization.CultureInfo.InvariantCulture);
            return Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        /// <summary>A starting value of a type from text ("5", "true", "1, 2, 3"); null for an object (picked in the editor) or empty text.</summary>
        static object ValueOf(Type t, string text)
        {
            text = (text ?? "").Trim();
            if (t == typeof(string)) return text;
            if (typeof(UnityEngine.Object).IsAssignableFrom(t)) return null;
            if (text == "") return t.IsValueType ? Activator.CreateInstance(t) : null;
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            if (t == typeof(int)) return int.Parse(text, inv);
            if (t == typeof(float)) return float.Parse(text.TrimEnd('f', 'F'), inv);
            if (t == typeof(bool)) return text.ToLowerInvariant() == "true";
            var n = text.Trim('(', ')').Split(',').Select(x => float.Parse(x.Trim(), inv)).ToArray();
            if (t == typeof(Vector2)) return new Vector2(n[0], n[1]);
            if (t == typeof(Vector3)) return new Vector3(n[0], n[1], n[2]);
            if (t == typeof(Color)) return new Color(n[0], n[1], n[2], n.Length > 3 ? n[3] : 1f);
            return ConversionUtility.Convert(text, t);
        }

        /// <summary>Gives a declaration its type (so an empty object variable still knows it holds a GameObject).</summary>
        static void SetDeclaredType(VariableDeclaration d, Type t)
        {
            var p = typeof(VariableDeclaration).GetProperty("typeHandle");
            if (p == null || !p.CanWrite) return;
            try { p.SetValue(d, Activator.CreateInstance(p.PropertyType, t.AssemblyQualifiedName)); } catch (Exception) { /* older Visual Scripting: the value's own type is used */ }
        }

        static bool RemoveDeclaration(VariableDeclarations decl, string name)
        {
            var coll = typeof(VariableDeclarations).GetField("collection", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(decl)
                ?? typeof(VariableDeclarations).GetProperty("collection", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(decl);
            var remove = coll?.GetType().GetMethod("Remove", new[] { typeof(string) });
            return remove != null && (bool)remove.Invoke(coll, new object[] { name });
        }

        /// <summary>
        /// The graph's own variables (Blackboard → Graph), as one undo step: add (name, type, default),
        /// change (name and any of newName, type, default; a new name is given to its Get/Set nodes too),
        /// remove (name).
        /// </summary>
        public static Dictionary<string, object> Vars(string path, List<object> ops)
        {
            var target = Load(path);
            if (target == null) return Error("No graph at " + path);
            try
            {
                var withVars = target.Root as IGraphWithVariables;
                if (withVars == null) return Error("This graph has no variables of its own.");
                Undo.RegisterCompleteObjectUndo(target.Owner, "KesherAI variables");
                var decl = withVars.variables;
                var results = new List<object>();
                var failed = 0;
                foreach (var o in ops)
                {
                    var op = o as Dictionary<string, object>;
                    if (op == null) continue;
                    var kind = Json.Str(op, "op");
                    var name = Json.Str(op, "name");
                    string problem = null;
                    try
                    {
                        if (string.IsNullOrEmpty(name)) problem = "A variable needs a name";
                        else if (kind == "add")
                        {
                            var t = FindType(Json.Str(op, "type"));
                            if (decl.IsDefined(name)) problem = "There is already a variable " + name;
                            else if (t == null) problem = "Unknown type " + Json.Str(op, "type");
                            else
                            {
                                decl.Set(name, ValueOf(t, Json.Str(op, "default")));
                                SetDeclaredType(decl.GetDeclaration(name), t);
                            }
                        }
                        else if (!decl.IsDefined(name)) problem = "No variable " + name;
                        else if (kind == "remove")
                        {
                            if (!RemoveDeclaration(decl, name)) problem = "Visual Scripting did not remove " + name;
                        }
                        else if (kind == "change")
                        {
                            var d = decl.GetDeclaration(name);
                            var t = op.ContainsKey("type") ? FindType(Json.Str(op, "type")) : DeclaredType(d);
                            if (t == null) problem = "Unknown type " + Json.Str(op, "type");
                            else
                            {
                                var value = op.ContainsKey("default") ? ValueOf(t, Json.Str(op, "default")) : d.value;
                                var newName = Json.Str(op, "newName");
                                if (!string.IsNullOrEmpty(newName) && newName != name)
                                {
                                    if (decl.IsDefined(newName)) problem = "There is already a variable " + newName;
                                    else
                                    {
                                        RemoveDeclaration(decl, name);
                                        decl.Set(newName, value);
                                        SetDeclaredType(decl.GetDeclaration(newName), t);
                                        RenameUses(target.Root, name, newName);
                                    }
                                }
                                else
                                {
                                    d.value = value;
                                    SetDeclaredType(d, t);
                                }
                            }
                        }
                        else problem = "Unknown operation " + kind;
                    }
                    catch (Exception e)
                    {
                        problem = e.Message;
                    }
                    if (problem != null) failed++;
                    var r = Res(kind, problem, null);
                    r["name"] = name;
                    results.Add(r);
                }
                EditorUtility.SetDirty(target.Owner);
                if (path.Contains(".prefab#") || Application.isBatchMode) target.Save();
                return Result(results, failed);
            }
            finally
            {
                target.Done();
            }
        }

        /// <summary>Get/Set/Is Variable nodes of kind Graph that name the old variable now name the new one (in every tab).</summary>
        static void RenameUses(IGraph root, string from, string to)
        {
            var tabs = new List<KeyValuePair<string, IGraph>>();
            Tabs(root, "", tabs);
            foreach (var tab in tabs)
            {
                var flow = tab.Value as FlowGraph;
                if (flow == null) continue;
                foreach (var u in flow.units.OfType<UnifiedVariableUnit>())
                {
                    if (u.kind == VariableKind.Graph && u.defaultValues.TryGetValue("name", out var n) && (n as string) == from) u.defaultValues["name"] = to;
                }
            }
        }

        public static Dictionary<string, object> Save(string path)
        {
            var target = Load(path);
            if (target == null) return Error("No graph at " + path);
            try
            {
                target.Save();
                return new Dictionary<string, object> { ["ok"] = true };
            }
            finally
            {
                target.Done();
            }
        }

        public static Dictionary<string, object> Open(string path)
        {
            var hash = path.IndexOf('#');
            var file = hash < 0 ? path : path.Substring(0, hash);
            var asset = AssetDatabase.LoadMainAssetAtPath(file);
            if (asset == null) return Error("Nothing at " + file);
            if (hash < 0 || file.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) AssetDatabase.OpenAsset(asset);
            else
            {
                var scene = SceneManager.GetSceneByPath(file);
                if (!scene.IsValid() || !scene.isLoaded) EditorSceneManager.OpenScene(file, OpenSceneMode.Additive);
                var target = Load(path);
                if (target != null) Selection.activeObject = target.Owner;
            }
            return new Dictionary<string, object> { ["ok"] = true };
        }
    }
}
