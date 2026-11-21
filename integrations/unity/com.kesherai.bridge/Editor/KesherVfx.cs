// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Effects the VFX specialist made in KesherAI while Unity was closed (packages/core/src/engine-build-tools.ts,
    /// <c>unity_vfx</c>): KesherAI writes one spec per effect to <c>KesherAI/pending-vfx/&lt;name&gt;.json</c> beside
    /// Assets; this makes each as a Particle System in the open scene (one Undo step per effect) and deletes its file.
    /// A spec whose <c>attachTo</c> object is not in the open scene waits for a scene that has it.
    /// Looks at the folder when the editor loads and every three seconds after.
    /// </summary>
    [InitializeOnLoad]
    internal static class KesherVfx
    {
        static string Folder => Path.Combine(Directory.GetParent(Application.dataPath).FullName, "KesherAI", "pending-vfx");
        static double nextLook;

        static KesherVfx()
        {
            EditorApplication.delayCall += ApplyAll;
            EditorApplication.update += Poll;
        }

        static void Poll()
        {
            if (EditorApplication.timeSinceStartup < nextLook) return;
            nextLook = EditorApplication.timeSinceStartup + 3;
            ApplyAll();
        }

        static void ApplyAll()
        {
            // Never while playing or compiling: the scene is not the one being edited then.
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || !Directory.Exists(Folder)) return;
            foreach (var file in Directory.GetFiles(Folder, "*.json"))
            {
                try
                {
                    if (!(Json.Parse(File.ReadAllText(file)) is Dictionary<string, object> spec)) { File.Delete(file); continue; }
                    if (Make(spec)) File.Delete(file);
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"KesherAI: the queued effect {Path.GetFileName(file)} could not be made: {e.Message}");
                    File.Move(file, file + ".failed");
                }
            }
        }

        static float F(Dictionary<string, object> o, string key, float fallback) => (float)Json.Num(o, key, fallback);

        static Color Hex(string hex, Color fallback) => ColorUtility.TryParseHtmlString(hex, out var c) ? c : fallback;

        /// <summary>Makes one effect from its spec; false when its parent is not in the open scene yet.</summary>
        static bool Make(Dictionary<string, object> s)
        {
            Transform parent = null;
            var attach = Json.Str(s, "attachTo");
            if (attach != "")
            {
                var p = GameObject.Find(attach);
                if (p == null) return false;
                parent = p.transform;
            }
            var go = new GameObject(Json.Str(s, "name") == "" ? "FX" : Json.Str(s, "name"));
            Undo.RegisterCreatedObjectUndo(go, "KesherAI: effect " + go.name);
            if (parent != null) go.transform.SetParent(parent, false);
            if (s.TryGetValue("position", out var pv) && pv is List<object> pl && pl.Count == 3)
                go.transform.localPosition = new Vector3(Convert.ToSingle(pl[0], CultureInfo.InvariantCulture), Convert.ToSingle(pl[1], CultureInfo.InvariantCulture), Convert.ToSingle(pl[2], CultureInfo.InvariantCulture));
            var ps = go.AddComponent<ParticleSystem>();
            var main = ps.main;
            main.duration = F(s, "duration", 5);
            main.loop = !s.TryGetValue("looping", out var lv) || !(lv is bool b) || b;
            main.startLifetime = F(s, "lifetime", 1);
            main.startSpeed = F(s, "speed", 1);
            main.startSize = F(s, "size", 0.2f);
            main.gravityModifier = F(s, "gravity", 0);
            main.maxParticles = Mathf.RoundToInt(F(s, "max", 300));
            var start = Hex(Json.Str(s, "color"), Color.white);
            var end = Hex(Json.Str(s, "colorEnd"), start);
            main.startColor = start;
            var em = ps.emission;
            em.rateOverTime = F(s, "rate", 30);
            var burst = Mathf.RoundToInt(F(s, "burst", 0));
            if (burst > 0) em.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Min(burst, short.MaxValue)) });
            var sh = ps.shape;
            switch (Json.Str(s, "shape"))
            {
                case "sphere": sh.shapeType = ParticleSystemShapeType.Sphere; break;
                case "box": sh.shapeType = ParticleSystemShapeType.Box; break;
                case "edge": sh.shapeType = ParticleSystemShapeType.SingleSidedEdge; break;
                default: sh.shapeType = ParticleSystemShapeType.Cone; break;
            }
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(new[] { new GradientColorKey(start, 0f), new GradientColorKey(end, 1f) }, new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.7f), new GradientAlphaKey(0f, 1f) });
            col.color = g;
            var mat = AssetDatabase.LoadAssetAtPath<Material>("Packages/com.unity.render-pipelines.universal/Runtime/Materials/ParticlesUnlit.mat")
                ?? AssetDatabase.GetBuiltinExtraResource<Material>("Default-ParticleSystem.mat");
            if (mat != null) go.GetComponent<ParticleSystemRenderer>().sharedMaterial = mat;
            EditorSceneManager.MarkSceneDirty(go.scene);
            Debug.Log($"KesherAI: made the queued effect {go.name} (Ctrl+Z takes it back; save the scene to keep it).");
            return true;
        }
    }
}
