// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

// Unity's CLI commands exist only with the Pipeline package (Unity 6+); on 2021.3/2022.3 this file is left out.
#if KESHER_PIPELINE
using System.Collections.Generic;
using Unity.Pipeline.Commands;
using UnityEditor;
using UnityEditor.SceneManagement;

namespace KesherAI.Bridge
{
    /// <summary>
    /// The commands KesherAI runs through Unity's CLI (the Pipeline package):
    /// warm, against the open editor — <c>unity command kesher_graph --path …</c> —
    /// or, with Unity closed, in a one-shot batch editor —
    /// <c>unity run &lt;project&gt; --command kesher_graph -- --path …</c>.
    /// Each returns JSON text (see <see cref="KesherGraph"/>).
    /// </summary>
    internal static class KesherCommands
    {
        const string Version = "0.2.13";

        static string Out(Dictionary<string, object> result) => Json.Write(result);

        [CliCommand("kesher_hello", "KesherAI Bridge: its version")]
        static string Hello() => Out(new Dictionary<string, object> { ["bridge"] = Version, ["project"] = UnityEngine.Application.productName, ["engine"] = UnityEngine.Application.unityVersion });

        [CliCommand("kesher_changed", "KesherAI Bridge: when something last changed in the editor (ms since 1970)")]
        static string Changed() => Out(new Dictionary<string, object> { ["changedAt"] = KesherChanges.ChangedAt });

#if KESHER_VS // the graph commands need Visual Scripting
        [CliCommand("kesher_list", "KesherAI Bridge: every Visual Scripting graph (assets, prefabs, open scenes)")]
        static string List() => Out(KesherGraph.List());

        [CliCommand("kesher_graph", "KesherAI Bridge: one graph as JSON")]
        static string Graph([CliArg("path", "Asset path, or file#GameObject/Path@index")] string path) => Out(KesherGraph.Read(path));

        [CliCommand("kesher_apply", "KesherAI Bridge: apply operations (JSON list) to one graph, as one undo step")]
        static string Apply([CliArg("path", "Where the graph lives")] string path, [CliArg("ops", "The operations, a JSON list")] string ops, [CliArg("graph", "Which tab (default: the first)")] string graph = "")
        {
            var list = Json.Parse(ops) as List<object>;
            return list == null ? Out(new Dictionary<string, object> { ["error"] = "ops must be a JSON list" }) : Out(KesherGraph.Apply(path, graph, list));
        }

        /// <summary>
        /// Changes queued in KesherAI while Unity was closed, all in one editor run (a batch Unity boots once, not
        /// once per change). The file is a JSON list of { cmd: "apply" | "save" | "graph", path, graph, ops }; the
        /// answer lists { ok, result | error } in the same order.
        /// </summary>
        [CliCommand("kesher_batch", "KesherAI Bridge: run a list of graph commands (a JSON file) in one editor run")]
        static string Batch([CliArg("file", "The JSON file with the commands")] string file)
        {
            List<object> list;
            try { list = Json.Parse(System.IO.File.ReadAllText(file)) as List<object>; }
            catch (System.Exception e) { return Out(new Dictionary<string, object> { ["error"] = "The batch file could not be read: " + e.Message }); }
            if (list == null) return Out(new Dictionary<string, object> { ["error"] = "The batch file must be a JSON list" });
            var answers = new List<object>();
            foreach (var item in list)
            {
                var c = item as Dictionary<string, object> ?? new Dictionary<string, object>();
                string Arg(string k) => c.TryGetValue(k, out var v) && v != null ? v.ToString() : "";
                try
                {
                    Dictionary<string, object> r;
                    switch (Arg("cmd"))
                    {
                        case "apply": r = KesherGraph.Apply(Arg("path"), Arg("graph"), c.TryGetValue("ops", out var ops) ? ops as List<object> ?? new List<object>() : new List<object>()); break;
                        case "save": r = KesherGraph.Save(Arg("path")); break;
                        case "graph": r = KesherGraph.Read(Arg("path")); break;
                        default: r = new Dictionary<string, object> { ["error"] = "Unknown batch command: " + Arg("cmd") }; break;
                    }
                    var ok = !r.ContainsKey("error");
                    answers.Add(ok ? new Dictionary<string, object> { ["ok"] = true, ["result"] = r } : new Dictionary<string, object> { ["ok"] = false, ["error"] = r["error"] });
                }
                catch (System.Exception e)
                {
                    answers.Add(new Dictionary<string, object> { ["ok"] = false, ["error"] = e.Message });
                }
            }
            return Out(new Dictionary<string, object> { ["answers"] = answers });
        }

        [CliCommand("kesher_vars", "KesherAI Bridge: add, change or remove the graph's own variables (JSON list), as one undo step")]
        static string Vars([CliArg("path", "Where the graph lives")] string path, [CliArg("ops", "The changes, a JSON list")] string ops)
        {
            var list = Json.Parse(ops) as List<object>;
            return list == null ? Out(new Dictionary<string, object> { ["error"] = "ops must be a JSON list" }) : Out(KesherGraph.Vars(path, list));
        }

        [CliCommand("kesher_actions", "KesherAI Bridge: the nodes that can be added (like the fuzzy finder), narrowed by a query")]
        static string Actions([CliArg("path", "Where the graph lives")] string path, [CliArg("query", "Words to look for")] string query = "") => Out(KesherGraph.Actions(query));
#endif

        [CliCommand("kesher_undo", "KesherAI Bridge: undo the last change in the editor")]
        static string Undo() { UnityEditor.Undo.PerformUndo(); return Out(new Dictionary<string, object> { ["ok"] = true }); }

        [CliCommand("kesher_redo", "KesherAI Bridge: redo in the editor")]
        static string Redo() { UnityEditor.Undo.PerformRedo(); return Out(new Dictionary<string, object> { ["ok"] = true }); }

#if KESHER_VS
        [CliCommand("kesher_check", "KesherAI Bridge: check a graph (missing inputs, broken ports)")]
        static string Check([CliArg("path", "Where the graph lives")] string path) => Out(KesherGraph.Check(path));

        [CliCommand("kesher_save", "KesherAI Bridge: save a graph")]
        static string Save([CliArg("path", "Where the graph lives")] string path) => Out(KesherGraph.Save(path));

        [CliCommand("kesher_open", "KesherAI Bridge: open a graph in the editor")]
        static string Open([CliArg("path", "Where the graph lives")] string path) => Out(KesherGraph.Open(path));
#endif

        [CliCommand("kesher_close", "KesherAI Bridge: close the editor, saving open scenes and assets first or throwing unsaved changes away")]
        static string Close([CliArg("save", "true: save first; false: close without saving")] string save = "false")
        {
            var keep = save == "true";
            if (keep)
            {
                if (EditorApplication.isPlaying) return Out(new Dictionary<string, object> { ["error"] = "The game is playing in the editor. Stop it, then close with saving." });
                if (!EditorSceneManager.SaveOpenScenes()) return Out(new Dictionary<string, object> { ["error"] = "The open scenes could not be saved, so Unity stays open." });
                AssetDatabase.SaveAssets();
            }
            // After this answer has gone back to KesherAI. Exit asks nothing (the choice was made in KesherAI).
            EditorApplication.delayCall += () => EditorApplication.Exit(0);
            return Out(new Dictionary<string, object> { ["ok"] = true, ["saved"] = keep });
        }
    }
}
#endif
