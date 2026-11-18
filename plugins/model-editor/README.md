# 3D editor (official KesherAI plugin)

A 3D model editor that runs inside KesherAI as an app plugin, laid out after Blender's Outliner and Properties, Spline
and Meshy's studio (docs/RESEARCH_LOG.md → "The 3D editor's screen"; design Model3DEditorWorkspace).

- **Open it from a chat:** "Edit in the 3D editor" on a chat's model (.glb, or a .gltf with everything inside it).
- **The view:** turn (left drag), pan (right drag or two fingers), zoom (wheel or pinch); light setups (studio, sun,
  evening); wireframe; a floor grid; F frames the chosen part, Home the whole model.
- **Parts:** every mesh of the file as a list with 👁 to hide it; a click in the view or the list chooses one.
- **The chosen part:** colour, roughness and metalness, its size (in the file's units), and its triangles.
- **Versions:** "Keep a version" saves the state as a thumbnail in the strip at the bottom; a click goes back to it.
- **Export / Send to the chat:** a GLB of the model as it is now.
- **Keys:** F frame, Home all, H hide the part, Alt+H show all, W wireframe, Ctrl+Z undo, `?` shows them all.

It talks to KesherAI only through `window.kesher` (`ui/kesher.js`): `editor.input` (the chat's model, as bytes) and
`chat.sendFile`. three.js 0.181 (MIT) is vendored in `ui/vendor/three/`. Next: mark a part and "What to do here?" with
the 3D models (new texture, change it by a sentence), retopology, and open in Blender / Unreal / Unity.
