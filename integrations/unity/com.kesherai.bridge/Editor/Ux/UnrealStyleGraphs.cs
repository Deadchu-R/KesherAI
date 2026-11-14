// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Unity.VisualScripting;
using UnityEditor;
using UnityEditor.ShortcutManagement;
using UnityEngine;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Visual Scripting graphs that handle like Unreal Blueprints (asked for: "exactly like Unreal"):
    /// - right-click empty space: the node search opens at once (no menu first; Shift+right-click for the menu);
    /// - Space: the node search at the mouse;
    /// - right-click a pin: Break Pin Link(s), Promote to Variable; Alt+click a pin: break its links;
    /// - C: a comment box (group) around the selected nodes;
    /// - the mouse wheel zooms (Visual Scripting's "Alternate" scheme, once called "Unreal").
    /// On by default; Tools → KesherAI → Unreal-style graphs turns it off (and back on).
    /// </summary>
    [InitializeOnLoad]
    internal static class UnrealStyleGraphs
    {
        const string Pref = "KesherAI.UnrealStyleGraphs";
        const string AppliedPref = "KesherAI.UnrealStyleGraphs.applied";
        const string Menu = "Tools/KesherAI/Unreal-style graphs";

        static readonly Dictionary<Type, Type> Pins = new Dictionary<Type, Type>
        {
            [typeof(ValueInput)] = typeof(UnrealValueInputWidget),
            [typeof(ValueOutput)] = typeof(UnrealValueOutputWidget),
            [typeof(ControlInput)] = typeof(UnrealControlInputWidget),
            [typeof(ControlOutput)] = typeof(UnrealControlOutputWidget),
        };

        static readonly HashSet<WidgetProvider> Patched = new HashSet<WidgetProvider>();

        internal static bool Enabled => EditorPrefs.GetBool(Pref, true);

        static UnrealStyleGraphs()
        {
            EditorApplication.delayCall += () =>
            {
                if (Enabled && !EditorPrefs.GetBool(AppliedPref, false)) ApplySettings(true);
            };
            EditorApplication.update += PatchActive;
        }

        [MenuItem(Menu)]
        static void Toggle()
        {
            var on = !Enabled;
            EditorPrefs.SetBool(Pref, on);
            ApplySettings(on);
            foreach (var p in Patched.ToList()) Unpatch(p);
            Patched.Clear();
            GraphWindow.active?.Repaint();
            Debug.Log(on ? "KesherAI: Unreal-style graphs are on (right-click/Space: search nodes; right-click a pin: Promote to Variable; Alt+click: break links; C: comment)." : "KesherAI: Unreal-style graphs are off.");
        }

        [MenuItem(Menu, true)]
        static bool ToggleCheck()
        {
            UnityEditor.Menu.SetChecked(Menu, Enabled);
            return true;
        }

        /// <summary>Visual Scripting's own settings that match Unreal: no menu before the search, wheel zooms.</summary>
        static void ApplySettings(bool on)
        {
            try
            {
                BoltFlow.Configuration.skipContextMenu = on;
                BoltFlow.Configuration.Save();
                BoltCore.Configuration.controlScheme = on ? CanvasControlScheme.Alternate : CanvasControlScheme.Default;
                BoltCore.Configuration.Save();
                EditorPrefs.SetBool(AppliedPref, on);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("KesherAI: could not change Visual Scripting's settings: " + ex.Message);
            }
        }

        // --- pins: Visual Scripting picks a pin's widget by type; the open graph's list is pointed at ours ---------

        static readonly Type ProviderBase = typeof(SingleDecoratorProvider<IGraphItem, IWidget, WidgetAttribute>);

        static Dictionary<Type, Type> Field(WidgetProvider p, string name) =>
            ProviderBase.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)?.GetValue(p) as Dictionary<Type, Type>;

        static void PatchActive()
        {
            if (!Enabled) return;
            var canvas = GraphWindow.active?.context?.canvas as FlowCanvas;
            if (canvas == null) return;
            var provider = canvas.widgetProvider;
            if (provider == null || Patched.Contains(provider)) return;
            Patched.RemoveWhere(p => p == null);
            var defined = Field(provider, "definedDecoratorTypes");
            var resolved = Field(provider, "resolvedDecoratorTypes");
            if (defined == null || resolved == null)
            {
                Patched.Add(provider); // an unknown Visual Scripting version: leave it as it is
                return;
            }
            foreach (var pair in Pins) defined[pair.Key] = pair.Value;
            resolved.Clear();
            Patched.Add(provider);
            provider.FreeAll();
            canvas.Recollect();
            GraphWindow.active.Repaint();
        }

        static void Unpatch(WidgetProvider provider)
        {
            var defined = Field(provider, "definedDecoratorTypes");
            var resolved = Field(provider, "resolvedDecoratorTypes");
            if (defined == null || resolved == null) return;
            defined[typeof(ValueInput)] = typeof(ValueInputWidget);
            defined[typeof(ValueOutput)] = typeof(ValueOutputWidget);
            defined[typeof(ControlInput)] = typeof(ControlInputWidget);
            defined[typeof(ControlOutput)] = typeof(ControlOutputWidget);
            resolved.Clear();
            provider.FreeAll();
        }

        // --- keys -----------------------------------------------------------------------------------------------

        /// <summary>Space: the node search at the mouse, as in Unreal.</summary>
        [Shortcut("KesherAI/Visual Scripting/Search nodes", typeof(GraphWindow), KeyCode.Space)]
        static void SearchNodes()
        {
            if (!Enabled || EditorGUIUtility.editingTextField) return;
            var window = GraphWindow.active;
            var canvas = window?.context?.canvas as FlowCanvas;
            if (canvas == null || canvas.isCreatingConnection) return;
            var newUnit = typeof(FlowCanvas).GetMethod("NewUnit", BindingFlags.Instance | BindingFlags.NonPublic, null, new[] { typeof(Vector2) }, null);
            if (newUnit == null) return;
            newUnit.Invoke(canvas, new object[] { canvas.mousePosition });
            window.Repaint();
        }

        /// <summary>C: a comment box around the selected nodes, as in Unreal (a Visual Scripting group).</summary>
        [Shortcut("KesherAI/Visual Scripting/Comment selection", typeof(GraphWindow), KeyCode.C)]
        static void Comment()
        {
            if (!Enabled || EditorGUIUtility.editingTextField) return;
            var window = GraphWindow.active;
            var context = window?.context;
            var canvas = context?.canvas as FlowCanvas;
            if (canvas == null) return;
            var rects = canvas.selection.Where(el => !(el is GraphGroup)).Select(el => canvas.Widget(el).position).ToList();
            if (rects.Count == 0) return;
            var xMin = rects.Min(r => r.xMin) - 20;
            var yMin = rects.Min(r => r.yMin) - 50;
            var xMax = rects.Max(r => r.xMax) + 20;
            var yMax = rects.Max(r => r.yMax) + 20;
            context.BeginEdit();
            try
            {
                UndoUtility.RecordEditedObject("Create Comment");
                var group = new GraphGroup { label = "Comment", position = new Rect(xMin, yMin, xMax - xMin, yMax - yMin) };
                canvas.graph.elements.Add(group);
                canvas.selection.Select(group);
            }
            finally
            {
                context.EndEdit();
            }
            GUI.changed = true;
            window.Repaint();
        }
    }
}
