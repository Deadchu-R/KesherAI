// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Unity.VisualScripting;
using UnityEditor;
using UnityEngine;

namespace KesherAI.Bridge
{
    /// <summary>
    /// What KesherAI can do with Visual Scripting graphs (Script Graph assets),
    /// as JSON in and JSON out — the same shape as the Unreal bridge:
    /// list, graph, apply (one undo step), save, open.
    /// Nodes are named by their GUID; a node added in the same apply is named
    /// by the "ref" given to it ("$1", "$log"…). Ports are named by their key
    /// ("enter", "exit", "trigger", "ifTrue", "ifFalse", "condition", "message"…).
    /// </summary>
    internal static class KesherGraph
    {
        static Dictionary<string, object> Error(string message) => new Dictionary<string, object> { ["error"] = message };

        static ScriptGraphAsset Load(string path) => AssetDatabase.LoadAssetAtPath<ScriptGraphAsset>(path);

        public static Dictionary<string, object> List()
        {
            var items = new List<object>();
            foreach (var guid in AssetDatabase.FindAssets("t:ScriptGraphAsset"))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (!path.StartsWith("Assets/", StringComparison.Ordinal)) continue;
                items.Add(new Dictionary<string, object> { ["path"] = path, ["name"] = System.IO.Path.GetFileNameWithoutExtension(path), ["parent"] = "Script Graph" });
            }
            return new Dictionary<string, object> { ["blueprints"] = items };
        }

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

        static string TypeName(Type t) => t == null ? "" : t == typeof(object) ? "object" : t.Name;

        static Dictionary<string, object> PortJson(IUnitPort port, string dir, string type, IUnit unit)
        {
            var p = new Dictionary<string, object> { ["name"] = port.key, ["dir"] = dir, ["type"] = type };
            if (port is ValueInput vi && !vi.hasValidConnection && unit.defaultValues.TryGetValue(vi.key, out var def) && def != null) p["default"] = def.ToString();
            var links = port.connectedPorts.Select(c => (object)(c.unit.guid.ToString() + ":" + c.key)).ToList();
            if (links.Count > 0) p["links"] = links;
            return p;
        }

        public static Dictionary<string, object> Read(string path)
        {
            var asset = Load(path);
            if (asset == null) return Error("No Script Graph at " + path);
            var graph = asset.graph;
            var nodes = new List<object>();
            foreach (var unit in graph.units)
            {
                var pins = new List<object>();
                foreach (var p in unit.controlInputs) pins.Add(PortJson(p, "in", "exec", unit));
                foreach (var p in unit.valueInputs) pins.Add(PortJson(p, "in", TypeName(p.type), unit));
                foreach (var p in unit.controlOutputs) pins.Add(PortJson(p, "out", "exec", unit));
                foreach (var p in unit.valueOutputs) pins.Add(PortJson(p, "out", TypeName(p.type), unit));
                var n = new Dictionary<string, object>
                {
                    ["id"] = unit.guid.ToString(),
                    ["title"] = Title(unit),
                    ["class"] = unit.GetType().Name,
                    ["x"] = (double)unit.position.x,
                    ["y"] = (double)unit.position.y,
                    ["pins"] = pins,
                };
                if (unit is MemberUnit m && m.member != null) n["function"] = (m.member.targetType != null ? m.member.targetType.FullName : "") + ":" + m.member.name;
                nodes.Add(n);
            }
            var vars = new List<object>();
            foreach (var v in graph.variables)
            {
                vars.Add(new Dictionary<string, object> { ["name"] = v.name, ["type"] = v.value != null ? v.value.GetType().Name : "object" });
            }
            return new Dictionary<string, object>
            {
                ["path"] = path,
                ["name"] = asset.name,
                ["parent"] = "Script Graph",
                ["variables"] = vars,
                ["graphs"] = new List<object> { new Dictionary<string, object> { ["name"] = asset.name, ["kind"] = "flow", ["nodes"] = nodes } },
            };
        }

        /// <summary>A Visual Scripting unit type by its short name ("Start", "Update", "If", "Sequence", "OnTriggerEnter"…).</summary>
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

        /// <summary>"UnityEngine.Debug:Log", "Debug.Log" or "UnityEngine.Transform:Translate".</summary>
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
                case "string": return typeof(string);
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
            IEnumerable<IUnitPort> ports = output
                ? unit.controlOutputs.Cast<IUnitPort>().Concat(unit.valueOutputs)
                : unit.controlInputs.Cast<IUnitPort>().Concat(unit.valueInputs);
            var list = ports.ToList();
            var found = list.FirstOrDefault(p => string.Equals(p.key, name, StringComparison.OrdinalIgnoreCase));
            if (found != null) return found;
            // "exec" / "then" / "in" / "out": the first control port on that side.
            if (new[] { "exec", "execute", "then", "in", "out", "enter", "exit" }.Contains((name ?? "").ToLowerInvariant()))
            {
                return output ? (IUnitPort)unit.controlOutputs.FirstOrDefault() : unit.controlInputs.FirstOrDefault();
            }
            return null;
        }

        public static Dictionary<string, object> Apply(string path, List<object> ops)
        {
            var asset = Load(path);
            if (asset == null) return Error("No Script Graph at " + path);
            var graph = asset.graph;
            Undo.RegisterCompleteObjectUndo(asset, "KesherAI edit");
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
                            v.kind = Enum.TryParse<VariableKind>(Json.Str(op, "kind"), true, out var k) ? k : VariableKind.Graph;
                            unit = v;
                        }
                        else if (type == "literal")
                        {
                            var t = ValueType(Json.Str(op, "valueType"));
                            unit = new Literal(t, ConversionUtility.Convert(Json.Str(op, "value"), t));
                        }
                        else if (type == "custom_event")
                        {
                            unit = new CustomEvent();
                        }
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
                        else
                        {
                            var input = unit.valueInputs[pin];
                            input.SetDefaultValue(ConversionUtility.Convert(Json.Str(op, "value"), input.type));
                        }
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
                    else problem = "Unknown operation " + kind;
                }
                catch (Exception e)
                {
                    problem = e.Message;
                }
                var res = new Dictionary<string, object> { ["op"] = kind, ["ok"] = problem == null };
                if (problem != null) { res["error"] = problem; failed++; }
                if (made != null) res["node"] = made.guid.ToString();
                results.Add(res);
            }
            EditorUtility.SetDirty(asset);
            return new Dictionary<string, object> { ["results"] = results, ["failed"] = (double)failed };
        }

        /// <summary>Checks the graph: ports left without a needed connection and broken links (Visual Scripting has no separate compile step).</summary>
        public static Dictionary<string, object> Check(string path)
        {
            var asset = Load(path);
            if (asset == null) return Error("No Script Graph at " + path);
            var messages = new List<object>();
            foreach (var unit in asset.graph.units)
            {
                foreach (var input in unit.valueInputs)
                {
                    if (!input.hasValidConnection && !input.hasDefaultValue && !input.nullMeansSelf && !input.allowsNull)
                        messages.Add(new Dictionary<string, object> { ["severity"] = "warning", ["text"] = Title(unit) + ": input " + input.key + " has no value" });
                }
                foreach (var port in unit.invalidInputs) messages.Add(new Dictionary<string, object> { ["severity"] = "error", ["text"] = Title(unit) + ": broken input " + port.key });
                foreach (var port in unit.invalidOutputs) messages.Add(new Dictionary<string, object> { ["severity"] = "error", ["text"] = Title(unit) + ": broken output " + port.key });
            }
            return new Dictionary<string, object> { ["ok"] = !messages.OfType<Dictionary<string, object>>().Any(m => (string)m["severity"] == "error"), ["messages"] = messages };
        }

        public static Dictionary<string, object> Save(string path)
        {
            var asset = Load(path);
            if (asset == null) return Error("No Script Graph at " + path);
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { ["ok"] = true };
        }

        public static Dictionary<string, object> Open(string path)
        {
            var asset = Load(path);
            if (asset == null) return Error("No Script Graph at " + path);
            AssetDatabase.OpenAsset(asset);
            return new Dictionary<string, object> { ["ok"] = true };
        }
    }
}
