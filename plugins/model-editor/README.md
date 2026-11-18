# 3D editor (official KesherAI plugin)

A 3D model editor that runs inside KesherAI as an app plugin, laid out after Blender's Outliner and Properties, Spline
and Meshy's studio (docs/RESEARCH_LOG.md → "The 3D editor's screen"; design Model3DEditorWorkspace).

- **Open it from a chat:** "Edit in the 3D editor" on a chat's model (.glb, or a .gltf with everything inside it).
- **The view:** turn (left drag), pan (right drag or two fingers), zoom (wheel or pinch); light setups (studio, sun,
  evening); wireframe; a floor grid; F frames the chosen part, Home the whole model.
- **The scene** (Blender's Outliner): the file's tree with ▸/▾ to fold, 👁 to hide; a click in the view or the tree chooses.
- **The chosen object:** a Channel Box like Maya's (move, rotate in degrees, scale; type a number), a gizmo to move,
  rotate or scale it with axis lock and snapping, colour / roughness / metalness, its size and triangles; duplicate and
  delete; undo for everything (structure too).
- **Textures** (Maya's PSD Network, Blender's Edit Externally): the chosen part's base colour texture as a thumbnail;
  *Edit in the image editor* or *New texture* hands it to the image editor with the part's UV layout as a guide layer
  (never saved), and the model as a working copy; *Back to the 3D model* there brings the picture into the same part.
- **Choose by click** (Blender's Select Linked by angle): a click picks the faces under it and spreads until the surface turns more than the angle (Shift adds); *Separate* makes them a part of their own.
- **Split into parts** (Blender's Separate): by loose pieces (triangles that touch nothing else) or by material, so each
  piece can get its own texture. By meaning (seat, leg, handle) needs a 3D part-segmentation model; it says so for now.
- **Modifiers** (3ds Max's stack, Blender's modifiers): Mirror (an axis), Array (an axis, a count, a gap) and Smooth
  shading, each on or off, moved up, or removed; they never change the object itself, stack in order, are exported
  with the model, and undo with the rest. An object with modifiers shows ⚙ in the tree.
- **Views and shading:** front / right / top / perspective (3ds Max's ViewCube faces, Blender's 1 / 3 / 7), wireframe /
  solid / material (Maya's 4 / 5 / 6).
- **Versions:** "Keep a version" saves the state as a thumbnail in the strip at the bottom; a click goes back to it.
- **Export / Send to the chat:** a GLB of the model as it is now.
- **Keys, two maps** (chosen in the bar, remembered): Maya / 3ds Max / Unreal — W E R move / rotate / scale, Ctrl+D
  duplicate, Delete; Blender — G R S, then X / Y / Z to lock an axis, Shift+D duplicate, X delete. Both: F frame, Home or A
  all, H hide, Alt+H show all, 1 / 3 / 7 views, 4 / 5 / 6 shading, Shift+S snapping, Esc let go, Ctrl+Z, `?` all of them.

It talks to KesherAI only through `window.kesher` (`ui/kesher.js`): `editor.input` (the chat's model, as bytes) and
`chat.sendFile`. three.js 0.181 (MIT) is vendored in `ui/vendor/three/`. Next: mark a part and "What to do here?" with
the 3D models (new texture, change it by a sentence), retopology, and open in Blender / Unreal / Unity.
