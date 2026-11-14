// Copyright KesherAI contributors. Licensed under the Apache License, Version 2.0.

using System;
using UnityEditor;

namespace KesherAI.Bridge
{
    /// <summary>
    /// When something last changed in the editor (any edit, undo or redo, or an asset saved, moved or deleted),
    /// so KesherAI reads the open graph again only then (<c>kesher_changed</c>), instead of the whole graph every
    /// few seconds. Starts at the time the editor loaded the package (a script reload counts as a change).
    /// </summary>
    [InitializeOnLoad]
    internal static class KesherChanges
    {
        /// <summary>Milliseconds since 1970 of the last change.</summary>
        internal static long ChangedAt { get; private set; }

        static KesherChanges()
        {
            Mark();
            ObjectChangeEvents.changesPublished += OnChanges;
            Undo.undoRedoPerformed += Mark;
        }

        static void OnChanges(ref ObjectChangeEventStream stream)
        {
            if (stream.length > 0) Mark();
        }

        internal static void Mark() => ChangedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    /// <summary>Saved, moved or deleted assets count as changes (a graph asset saved from its window).</summary>
    internal sealed class KesherChangedAssets : AssetPostprocessor
    {
        static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            if (imported.Length + deleted.Length + moved.Length > 0) KesherChanges.Mark();
        }
    }
}
