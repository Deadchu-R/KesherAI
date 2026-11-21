// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.IO;
using UnityEditor;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Tells KesherAI when the editor enters or leaves Play Mode, so it can free the graphics card for the game
    /// (Settings → "Free the graphics card while the game plays") and take it back after. Unity's CLI is not a
    /// live connection, so the state goes into <c>Temp/KesherPlay.json</c> as <c>{"event":"play","on":true|false}</c>,
    /// which KesherAI reads every few seconds. Unity clears <c>Temp</c> when the editor closes. Package 0.2.13+.
    /// </summary>
    [InitializeOnLoad]
    internal static class KesherPlay
    {
        static KesherPlay()
        {
            EditorApplication.playModeStateChanged += OnChanged;
            // A script reload (also when entering Play with domain reload) says where things stand now.
            Write(EditorApplication.isPlayingOrWillChangePlaymode);
        }

        static void OnChanged(PlayModeStateChange state)
        {
            // On at the earliest moment (before the scene loads), off once the editor is back to edit mode.
            if (state == PlayModeStateChange.ExitingEditMode) Write(true);
            else if (state == PlayModeStateChange.EnteredEditMode) Write(false);
        }

        static void Write(bool on)
        {
            try
            {
                var temp = Path.Combine(Directory.GetCurrentDirectory(), "Temp");
                if (!Directory.Exists(temp)) return;
                File.WriteAllText(Path.Combine(temp, "KesherPlay.json"), "{\"event\":\"play\",\"on\":" + (on ? "true" : "false") + "}");
            }
            catch (Exception)
            {
                // KesherAI just does not hear about Play this time; never disturb the editor.
            }
        }
    }
}
