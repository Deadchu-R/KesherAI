// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System.Collections.Generic;
using Unity.Pipeline.Commands;

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
        const string Version = "0.2.0";

        static string Out(Dictionary<string, object> result) => Json.Write(result);

        [CliCommand("kesher_hello", "KesherAI Bridge: its version")]
        static string Hello() => Out(new Dictionary<string, object> { ["bridge"] = Version, ["project"] = UnityEngine.Application.productName, ["engine"] = UnityEngine.Application.unityVersion });

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

        [CliCommand("kesher_check", "KesherAI Bridge: check a graph (missing inputs, broken ports)")]
        static string Check([CliArg("path", "Where the graph lives")] string path) => Out(KesherGraph.Check(path));

        [CliCommand("kesher_save", "KesherAI Bridge: save a graph")]
        static string Save([CliArg("path", "Where the graph lives")] string path) => Out(KesherGraph.Save(path));

        [CliCommand("kesher_open", "KesherAI Bridge: open a graph in the editor")]
        static string Open([CliArg("path", "Where the graph lives")] string path) => Out(KesherGraph.Open(path));
    }
}
