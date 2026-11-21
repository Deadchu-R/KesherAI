// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using System.IO;
using UnityEditor;
using UnityEditor.PackageManager;

namespace KesherAI.Bridge
{
    /// <summary>
    /// Tells KesherAI that this package compiled and loaded: after every domain reload it writes the package's version
    /// into <c>Temp/KesherBridge.ok</c>. When the package does not compile, this never runs, so KesherAI (which reads
    /// that file, and the editor's log for the compile errors) can offer "Convert with AI" for this Unity version.
    /// Unity clears <c>Temp</c> when the editor closes. Package 0.2.14+.
    /// </summary>
    [InitializeOnLoad]
    internal static class KesherReady
    {
        static KesherReady()
        {
            try
            {
                var temp = Path.Combine(Directory.GetCurrentDirectory(), "Temp");
                if (!Directory.Exists(temp)) return;
                var info = PackageInfo.FindForAssembly(typeof(KesherReady).Assembly);
                File.WriteAllText(Path.Combine(temp, "KesherBridge.ok"), info != null ? info.version : "?");
            }
            catch (Exception)
            {
                // KesherAI just does not hear about it this time; never disturb the editor.
            }
        }
    }
}
