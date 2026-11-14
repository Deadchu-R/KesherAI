// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Linq;
using Unity.VisualScripting;
using UnityEditor;
using UnityEngine;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Ports that behave like Unreal Blueprint pins (asked for): right-click a pin for a menu (Break Link(s),
    /// Promote to Variable), Alt+click a pin to break its links. Everything else is Visual Scripting's own.
    /// </summary>
    internal static class UnrealPins
    {
        /// <summary>Handles a pin's own clicks; true when it took the event.</summary>
        internal static bool HandleInput(FlowCanvas canvas, IUnitPort port, IUnitPortWidget widget, EventWrapper e, bool isMouseOver, IGraphContext context)
        {
            if (!UnrealStyleGraphs.Enabled || canvas.isCreatingConnection) return false;
            if (e.alt && e.IsMouseDown(MouseButton.Left))
            {
                BreakLinks(canvas, port);
                e.Use();
                return true;
            }
            if (e.IsMouseDown(MouseButton.Right))
            {
                e.Use();
                return true;
            }
            if (e.IsMouseUp(MouseButton.Right))
            {
                if (isMouseOver) ShowMenu(canvas, port, widget, context);
                e.Use();
                return true;
            }
            return false;
        }

        static void ShowMenu(FlowCanvas canvas, IUnitPort port, IUnitPortWidget widget, IGraphContext context)
        {
            var menu = new GenericMenu();
            var linked = port.hasAnyConnection;
            if (linked) menu.AddItem(new GUIContent(port.connectedPorts.Count() > 1 ? "Break All Pin Links" : "Break Pin Link"), false, () => Edit(context, () => BreakLinks(canvas, port)));
            else menu.AddDisabledItem(new GUIContent("Break Pin Link"));
            if (port is ValueInput || port is ValueOutput)
            {
                menu.AddSeparator("");
                menu.AddItem(new GUIContent("Promote to Variable"), false, () => Edit(context, () => PromoteToVariable(canvas, port, widget)));
            }
            menu.ShowAsContext();
        }

        static void Edit(IGraphContext context, Action change)
        {
            context?.BeginEdit();
            try { change(); }
            finally { context?.EndEdit(); }
            GraphWindow.active?.Repaint();
        }

        static void BreakLinks(FlowCanvas canvas, IUnitPort port)
        {
            UndoUtility.RecordEditedObject("Break Pin Links");
            foreach (var other in port.connectedPorts.ToList()) canvas.Widget(other.unit).Reposition();
            canvas.Widget(port.unit).Reposition();
            port.Disconnect();
            GUI.changed = true;
        }

        /// <summary>
        /// Like Unreal's "Promote to Variable": a new graph variable of the pin's type (named after the pin), with a
        /// Get node feeding an input pin, or a Set node taking an output pin. One undo step.
        /// </summary>
        static void PromoteToVariable(FlowCanvas canvas, IUnitPort port, IUnitPortWidget widget)
        {
            var graph = canvas.graph as FlowGraph;
            if (graph == null) return;
            var type = port is ValueInput vi ? vi.type : ((ValueOutput)port).type;
            var name = UniqueName(graph.variables, port);
            UndoUtility.RecordEditedObject("Promote to Variable");
            object start = null;
            if (port is ValueInput input && input.hasDefaultValue && port.unit.defaultValues.TryGetValue(input.key, out var d)) start = d;
            else if (type.IsValueType) start = Activator.CreateInstance(type);
            graph.variables.Set(name, start);
            SetDeclaredType(graph.variables.GetDeclaration(name), type);

            var at = widget.handlePosition.center;
            if (port is ValueInput target)
            {
                var get = new GetVariable { kind = VariableKind.Graph };
                canvas.AddUnit(get, new Vector2(at.x - 200, at.y - 20));
                get.defaultValues["name"] = name;
                get.value.ValidlyConnectTo(target);
            }
            else
            {
                var set = new SetVariable { kind = VariableKind.Graph };
                canvas.AddUnit(set, new Vector2(at.x + 60, at.y - 20));
                set.defaultValues["name"] = name;
                ((ValueOutput)port).ValidlyConnectTo(set.input);
            }
            canvas.Cache();
            GUI.changed = true;
            Debug.Log($"KesherAI: promoted to the graph variable \"{name}\" ({type.Name}). Rename it in the Blackboard → Graph.");
        }

        static string UniqueName(VariableDeclarations vars, IUnitPort port)
        {
            var label = port.Description<UnitPortDescription>()?.label;
            if (string.IsNullOrWhiteSpace(label)) label = port.key;
            var clean = new string(label.Where(c => char.IsLetterOrDigit(c) || c == ' ' || c == '_').ToArray());
            var words = clean.Split(new[] { ' ', '_' }, StringSplitOptions.RemoveEmptyEntries).Select(w => char.ToUpperInvariant(w[0]) + w.Substring(1));
            var name = string.Concat(words);
            if (string.IsNullOrEmpty(name) || char.IsDigit(name[0])) name = "NewVar";
            var result = name;
            for (var i = 0; vars.IsDefined(result); i++) result = name + "_" + i;
            return result;
        }

        /// <summary>Gives a declaration its type (so an empty object variable still knows what it holds).</summary>
        static void SetDeclaredType(VariableDeclaration d, Type t)
        {
            var p = typeof(VariableDeclaration).GetProperty("typeHandle");
            if (p == null || !p.CanWrite) return;
            try { p.SetValue(d, Activator.CreateInstance(p.PropertyType, t.AssemblyQualifiedName)); } catch (Exception) { /* older Visual Scripting: the value's own type is used */ }
        }
    }

    internal sealed class UnrealValueInputWidget : ValueInputWidget
    {
        public UnrealValueInputWidget(FlowCanvas canvas, ValueInput port) : base(canvas, port) { }
        public override void HandleInput() { if (!UnrealPins.HandleInput(canvas, port, this, e, isMouseOver, context)) base.HandleInput(); }
    }

    internal sealed class UnrealValueOutputWidget : ValueOutputWidget
    {
        public UnrealValueOutputWidget(FlowCanvas canvas, ValueOutput port) : base(canvas, port) { }
        public override void HandleInput() { if (!UnrealPins.HandleInput(canvas, port, this, e, isMouseOver, context)) base.HandleInput(); }
    }

    internal sealed class UnrealControlInputWidget : ControlInputWidget
    {
        public UnrealControlInputWidget(FlowCanvas canvas, ControlInput port) : base(canvas, port) { }
        public override void HandleInput() { if (!UnrealPins.HandleInput(canvas, port, this, e, isMouseOver, context)) base.HandleInput(); }
    }

    internal sealed class UnrealControlOutputWidget : ControlOutputWidget
    {
        public UnrealControlOutputWidget(FlowCanvas canvas, ControlOutput port) : base(canvas, port) { }
        public override void HandleInput() { if (!UnrealPins.HandleInput(canvas, port, this, e, isMouseOver, context)) base.HandleInput(); }
    }
}
