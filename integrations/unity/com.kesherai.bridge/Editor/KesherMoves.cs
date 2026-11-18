// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Moves made in KesherAI while Unity was closed (its scene stand-in, docs/RESEARCH_LOG "A game scene edited in
    /// KesherAI without its engine"): KesherAI writes them to <c>KesherAI/pending-moves.json</c> beside Assets, per
    /// scene; this applies each scene's moves when it is open, as one undo step, and leaves out any object that also
    /// moved in Unity since (it says which in the Console, and keeps Unity's).
    /// </summary>
    [InitializeOnLoad]
    internal static class KesherMoves
    {
        static DateTime seen;

        static string FilePath => Path.Combine(Directory.GetParent(Application.dataPath).FullName, "KesherAI", "pending-moves.json");

        static KesherMoves()
        {
            EditorSceneManager.sceneOpened += (scene, _) => Apply(scene);
            EditorApplication.delayCall += ApplyOpen;
            // Moves made while Unity is open arrive too: the file is looked at every two seconds.
            EditorApplication.update += Poll;
        }

        static double nextLook;

        static void Poll()
        {
            if (EditorApplication.timeSinceStartup < nextLook) return;
            nextLook = EditorApplication.timeSinceStartup + 2;
            if (!File.Exists(FilePath)) return;
            var t = File.GetLastWriteTimeUtc(FilePath);
            if (t == seen) return;
            seen = t;
            ApplyOpen();
        }

        static void ApplyOpen()
        {
            for (var i = 0; i < SceneManager.sceneCount; i++) Apply(SceneManager.GetSceneAt(i));
        }

        static Vector3 Vec(Dictionary<string, object> o, string key, Vector3 fallback)
        {
            if (o == null || !o.TryGetValue(key, out var v) || !(v is List<object> l) || l.Count < 3) return fallback;
            return new Vector3(F(l[0]), F(l[1]), F(l[2]));
        }

        static Quaternion Quat(Dictionary<string, object> o, string key)
        {
            if (o == null || !o.TryGetValue(key, out var v) || !(v is List<object> l) || l.Count < 4) return Quaternion.identity;
            return new Quaternion(F(l[0]), F(l[1]), F(l[2]), F(l[3]));
        }

        static float F(object v) => Convert.ToSingle(v, CultureInfo.InvariantCulture);

        /// <summary>Applies the waiting moves of one open scene, then keeps only those it could not find yet.</summary>
        internal static void Apply(Scene scene)
        {
            if (!scene.IsValid() || !scene.isLoaded || string.IsNullOrEmpty(scene.path) || !File.Exists(FilePath)) return;
            if (!(Json.Parse(File.ReadAllText(FilePath)) is Dictionary<string, object> all)) return;
            if (!all.TryGetValue(scene.path, out var v) || !(v is List<object> moves) || moves.Count == 0) return;
            var guid = AssetDatabase.AssetPathToGUID(scene.path);
            Undo.IncrementCurrentGroup();
            var group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("KesherAI: moves made in KesherAI");
            var left = new List<object>();
            var done = 0;
            var clashes = new List<string>();
            foreach (var item in moves)
            {
                if (!(item is Dictionary<string, object> m)) continue;
                var id = Json.Str(m, "id");
                // A scene object's id: type 2, the scene's GUID, its file id, and no prefab part; a placed prefab or
                // model is "<its Transform's id in the source>:<the prefab instance's id>".
                var parts = id.Split(':');
                var target = parts.Length == 2 ? $"{parts[0]}-{parts[1]}" : $"{id}-0";
                if (!GlobalObjectId.TryParse($"GlobalObjectId_V1-2-{guid}-{target}", out var gid) || !(GlobalObjectId.GlobalObjectIdentifierToObjectSlow(gid) is Transform t))
                {
                    left.Add(item);
                    continue;
                }
                var from = Json.Obj(m, "from");
                var to = Json.Obj(m, "to");
                if (Vector3.Distance(t.localPosition, Vec(from, "position", t.localPosition)) > 1e-3f || Quaternion.Angle(t.localRotation, Quat(from, "rotation")) > 0.05f)
                {
                    clashes.Add(t.name);
                    continue;
                }
                Undo.RecordObject(t, "KesherAI move");
                t.localPosition = Vec(to, "position", t.localPosition);
                t.localRotation = Quat(to, "rotation");
                t.localScale = Vec(to, "scale", t.localScale);
                done++;
            }
            Undo.CollapseUndoOperations(group);
            if (done > 0)
            {
                EditorSceneManager.MarkSceneDirty(scene);
                Debug.Log($"KesherAI: {done} moves made in KesherAI are in {scene.name} (Ctrl+Z takes them back).");
            }
            if (clashes.Count > 0) Debug.LogWarning($"KesherAI: these moved in Unity too, so Unity's place was kept: {string.Join(", ", clashes)}");
            all[scene.path] = left;
            File.WriteAllText(FilePath, Json.Write(all));
            seen = File.GetLastWriteTimeUtc(FilePath);
        }
    }
}
